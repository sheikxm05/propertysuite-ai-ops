/**
 * What a failed job is allowed to say about itself.
 *
 * `jobs.last_error` is the only free-text field a background job writes, and the job in
 * question is processing a tenancy contract. The obvious implementation —
 * `last_error: String(error)` — would put a pdf.js parse error quoting bytes from the
 * document, or a provider error echoing part of the prompt, into a database column that
 * nothing redacts. That is a direct breach of CLAUDE.md rule 8, and it would arrive by
 * accident rather than by decision.
 *
 * So `last_error` is not free text here. It is one token from the closed list below.
 * `sanitiseJobError` maps every error this lane can throw to a token and maps everything
 * else to `unexpected_error`: an unrecognised failure records that it was unrecognised
 * rather than describing itself. The stack trace is still available to the logger, which
 * applies its own allowlist (`lib/observability/redaction.ts`).
 *
 * The second thing this module decides is **retryable or not**, which is what makes the
 * dead-letter state meaningful. A PDF whose magic bytes are wrong will have the wrong
 * magic bytes on the fifth attempt too; retrying it four more times is pure noise. A
 * provider timeout is the opposite. Getting this classification wrong in the safe
 * direction (retrying something permanent) wastes a quarter of an hour; getting it wrong
 * in the unsafe direction (dead-lettering something transient) loses work, so anything
 * unrecognised is treated as retryable.
 */

import {
  isFieldExtractionError,
  isPdfTextExtractionError,
  isUploadValidationError,
} from '@/services/extraction';

/**
 * Every token `jobs.last_error` may contain.
 *
 * A closed union, so adding a failure path without adding a token is a compile error
 * and `tests/documents/job-errors.test.ts` can enumerate the lot.
 */
export const JOB_FAILURE_REASONS = [
  // Permanent — the same input will fail the same way.
  'document_not_found',
  'document_organization_mismatch',
  'document_not_pending_verification',
  'document_object_missing',
  'payload_invalid',
  'mime_type_not_allowed',
  'extension_not_allowed',
  'declared_size_exceeds_cap',
  'declared_size_not_positive',
  'byte_size_exceeds_cap',
  'byte_size_below_minimum',
  'magic_bytes_not_pdf',
  'pdf_parse_threw',
  'pdf_parse_returned_no_text',
  'handler_not_registered',
  'fence_integrity_failed',
  // Retryable — the same input may succeed later.
  'storage_download_failed',
  'database_write_failed',
  'pdf_parse_unavailable',
  'extractor_threw',
  'extractor_returned_unparseable_reply',
  'extractor_output_failed_schema',
  'aborted',
  'unexpected_error',
] as const;

export type JobFailureReason = (typeof JOB_FAILURE_REASONS)[number];

/** Reasons that must never be retried. Everything else is retryable by default. */
const PERMANENT: ReadonlySet<JobFailureReason> = new Set<JobFailureReason>([
  'document_not_found',
  'document_organization_mismatch',
  'document_not_pending_verification',
  'document_object_missing',
  'payload_invalid',
  'mime_type_not_allowed',
  'extension_not_allowed',
  'declared_size_exceeds_cap',
  'declared_size_not_positive',
  'byte_size_exceeds_cap',
  'byte_size_below_minimum',
  'magic_bytes_not_pdf',
  'pdf_parse_threw',
  'pdf_parse_returned_no_text',
  'handler_not_registered',
  'fence_integrity_failed',
]);

/* ------------------------------------------------------------- throwables -- */

/** A failure that will recur. The runner dead-letters it without burning retries. */
export class PermanentJobError extends Error {
  readonly reason: JobFailureReason;

  constructor(reason: JobFailureReason, options?: { cause?: unknown }) {
    super(
      `job failed permanently: ${reason}`,
      options?.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'PermanentJobError';
    this.reason = reason;
  }
}

/** A failure that may not recur. The runner schedules the next attempt. */
export class RetryableJobError extends Error {
  readonly reason: JobFailureReason;

  constructor(reason: JobFailureReason, options?: { cause?: unknown }) {
    super(
      `job failed, retryable: ${reason}`,
      options?.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'RetryableJobError';
    this.reason = reason;
  }
}

export function isPermanentJobError(value: unknown): value is PermanentJobError {
  return value instanceof PermanentJobError;
}

export function isRetryableJobError(value: unknown): value is RetryableJobError {
  return value instanceof RetryableJobError;
}

/* ------------------------------------------------------------- sanitising -- */

export interface SanitisedJobFailure {
  readonly reason: JobFailureReason;
  /** True to dead-letter now; false to schedule the next attempt. */
  readonly permanent: boolean;
}

/**
 * Reduces anything thrown by a handler to a token and a retry decision.
 *
 * The thrown value's own `message` is never read. That is the whole point: a mapping
 * table cannot leak what it does not consult.
 */
export function sanitiseJobError(thrown: unknown): SanitisedJobFailure {
  if (isPermanentJobError(thrown)) return { reason: thrown.reason, permanent: true };
  if (isRetryableJobError(thrown)) return { reason: thrown.reason, permanent: false };

  // A rejected upload is permanent by construction: the bytes are what they are.
  if (isUploadValidationError(thrown)) return finalise(thrown.reason);

  // pdf-parse threw, or produced nothing. Both are properties of the file, except
  // `pdf_parse_unavailable`, which is a deployment problem and may be fixed by a deploy.
  if (isPdfTextExtractionError(thrown)) return finalise(thrown.reason);

  // A provider failure. Retryable: a second sample often parses, and a provider outage
  // ends. The bounded attempt cap is what stops this becoming an infinite loop.
  if (isFieldExtractionError(thrown)) return finalise(thrown.reason);

  if (isAbortError(thrown)) return { reason: 'aborted', permanent: false };

  return { reason: 'unexpected_error', permanent: false };
}

function finalise(reason: string): SanitisedJobFailure {
  const known = (JOB_FAILURE_REASONS as readonly string[]).includes(reason)
    ? (reason as JobFailureReason)
    : 'unexpected_error';
  return { reason: known, permanent: PERMANENT.has(known) };
}

function isAbortError(thrown: unknown): boolean {
  return (
    typeof thrown === 'object' &&
    thrown !== null &&
    (thrown as { name?: unknown }).name === 'AbortError'
  );
}

/** Is `reason` one that must never be retried? Exported for the runner and its tests. */
export function isPermanentReason(reason: JobFailureReason): boolean {
  return PERMANENT.has(reason);
}
