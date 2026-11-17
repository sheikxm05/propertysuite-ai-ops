/**
 * The failure vocabulary of `services/rag/**`.
 *
 * Modelled on `services/ai/errors.ts`, and for the same reason: the distinction that
 * matters is not "did it fail" but **"will it fail again"**. An embedding job that
 * dead-letters on a rate limit loses a document from the corpus; an embedding job that
 * retries a 404 for a quarter of an hour sends an operator chasing a network problem
 * that does not exist. Those are two different bugs and one error type cannot express
 * both.
 *
 * The classification is the one `services/ai/providers/nvidia.ts` arrived at by probing
 * the live API, and it is deliberately identical here:
 *
 *   401, 403, 404, 410   CONFIGURATION. The deployment is wrong — a dead model, a key
 *                        without entitlement to it, a typo. `/v1/models` listing a
 *                        model proves nothing about your account's access to it. Never
 *                        retried, at any level.
 *   429                  RATE LIMITED. Retry with backoff.
 *   anything else        TRANSIENT. Retry with backoff.
 *
 * Every error here carries `logFields` whose keys are all on the
 * `lib/observability/redaction.ts` allowlist. No embedding input, no chunk text and no
 * vector is ever attached to an error, because an error is the one object that
 * reliably reaches a log (CLAUDE.md rule 8).
 */

export type RagFailureKind =
  /** No NVIDIA credential is configured at all. */
  | 'not_configured'
  /** The provider rejected the deployment: bad key, dead model, no entitlement. */
  | 'configuration'
  /** HTTP 429. */
  | 'rate_limited'
  /** The provider was reached and failed with something other than 429. */
  | 'upstream_error'
  /** Transport failure — DNS, TLS, connection reset. */
  | 'unreachable'
  /** The caller's signal fired, or the request timed out. */
  | 'aborted'
  /** A 200 whose body is not the documented shape, or the wrong vector width. */
  | 'malformed_reply'
  /** A database read or write failed. */
  | 'storage';

/** Base class, so a route or a job handler can catch this layer in one clause. */
export class RagError extends Error {
  readonly kind: RagFailureKind;
  /** True when the same call may succeed later. Drives the job's retry decision. */
  readonly retryable: boolean;
  /** Allowlisted field names only. Never input text, never a vector. */
  readonly logFields: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      kind: RagFailureKind;
      retryable: boolean;
      logFields?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = new.target.name;
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.logFields = options.logFields ?? {};
  }
}

/**
 * No embedding credential.
 *
 * Retryable on purpose, unlike the other configuration faults. A missing
 * `NVIDIA_API_KEY` is normally a half-finished deploy, and the next deploy fixes it —
 * whereas dead-lettering every queued embedding job would leave the corpus permanently
 * short of the documents that happened to be uploaded during the gap, each needing a
 * manual requeue under a fresh idempotency key.
 */
export class RagNotConfiguredError extends RagError {
  constructor(reason: string, cause?: unknown) {
    super(`embedding provider is not configured: ${reason}`, {
      kind: 'not_configured',
      retryable: true,
      logFields: { reason: 'embedding_provider_not_configured' },
      cause,
    });
  }
}

/**
 * The provider rejected the deployment itself.
 *
 * 401, 403, 404 and 410, plus the vector-width check: a model that returns 1536
 * dimensions into a `halfvec(2048)` column is a configuration error dressed as a
 * database error, and catching it here means the operator reads "wrong model" instead
 * of a Postgres cast failure.
 *
 * Never retried. Nothing about the next attempt will differ.
 */
export class RagConfigurationError extends RagError {
  readonly upstreamStatus: number | null;

  constructor(reason: string, options: { upstreamStatus?: number | null; cause?: unknown } = {}) {
    super(`embedding provider rejected the configuration: ${reason}`, {
      kind: 'configuration',
      retryable: false,
      logFields: {
        reason: 'embedding_provider_misconfigured',
        ...(options.upstreamStatus ? { status_code: options.upstreamStatus } : {}),
      },
      cause: options.cause,
    });
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}

/** The provider was reached and failed in a way that may not recur. */
export class RagProviderError extends RagError {
  readonly upstreamStatus: number | null;

  constructor(
    kind: Extract<RagFailureKind, 'rate_limited' | 'upstream_error' | 'unreachable' | 'aborted'>,
    options: { upstreamStatus?: number | null; attempt?: number; cause?: unknown } = {},
  ) {
    super(`embedding request failed: ${kind}`, {
      kind,
      retryable: true,
      logFields: {
        reason: `embedding_${kind}`,
        ...(options.upstreamStatus ? { status_code: options.upstreamStatus } : {}),
        ...(options.attempt ? { attempt: options.attempt } : {}),
      },
      cause: options.cause,
    });
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}

/**
 * A 200 whose body is not what the API documents.
 *
 * Separated from `upstream_error` because it is the one provider failure that is a
 * *contract* failure: the count of vectors did not match the count of inputs, or an
 * entry was not an array of finite numbers. Silently accepting either would store a
 * vector against the wrong chunk, which produces citations that point at text the
 * answer did not come from — a wrong answer that looks sourced.
 */
export class RagMalformedReplyError extends RagError {
  constructor(reason: string, cause?: unknown) {
    super(`embedding reply was malformed: ${reason}`, {
      kind: 'malformed_reply',
      retryable: true,
      logFields: { reason: `embedding_${reason}` },
      cause,
    });
  }
}

/** A read or write against `documents` or `document_chunks` failed. */
export class RagStorageError extends RagError {
  readonly pgCode: string;

  constructor(reason: string, pgCode: string, cause?: unknown) {
    super(`chunk storage operation failed: ${reason}`, {
      kind: 'storage',
      retryable: true,
      logFields: { reason: `chunk_store_${reason}`, pg_code: pgCode },
      cause,
    });
    this.pgCode = pgCode;
  }
}

export function isRagError(value: unknown): value is RagError {
  return value instanceof RagError;
}

/**
 * Maps an HTTP status from the embeddings endpoint to an error.
 *
 * One function so the classification exists exactly once. `reason` carries only what
 * the provider says about the *deployment* (NIM's problem+json `detail` names the model
 * and the account); request content never reaches it.
 */
export function errorForStatus(status: number, reason: string, attempt: number): RagError {
  if (status === 401 || status === 403 || status === 404 || status === 410) {
    return new RagConfigurationError(
      status === 410 ? `model_end_of_life: ${reason}` : `nvidia_rejected: ${reason}`,
      { upstreamStatus: status },
    );
  }
  if (status === 429)
    return new RagProviderError('rate_limited', { upstreamStatus: status, attempt });
  return new RagProviderError('upstream_error', { upstreamStatus: status, attempt });
}
