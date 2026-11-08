/**
 * Structured field extraction: prompt, call, validate.
 *
 * The order of the three steps is the security property. The prompt is built with the
 * document fenced (`prompt.ts`), the call goes through the port (`ai-port.ts`), and the
 * reply is parsed against `DocumentExtractionSchema` from `packages/shared` before a
 * single field of it is read.
 *
 * `DocumentExtractionSchema` is `.strict()`, so an extra key is a rejection rather than
 * a silent strip — an extra key means the model stopped following the contract, and
 * discarding the evidence of that is how an injected instruction becomes invisible.
 * More importantly, the schema contains no `verification_status`, no `document_id`, no
 * `tenancy_id` and no status of any kind. There is no value any model can return that
 * moves a document out of `pending` or attaches it to a record. That is what makes
 * step three the one that matters.
 *
 * On malformed output: one retry, then give up. A single malformed sample is usually
 * sampling noise; two in a row is a contract problem, and burning the job's whole retry
 * budget on it inside one attempt would defeat the bounded backoff in
 * `services/workers`. The failure is thrown so the runner can schedule the next attempt
 * and eventually dead-letter — never partially applied.
 */

import { DocumentExtractionSchema, type DocumentExtraction } from '@shared/index';

import { getDocumentFieldExtractor, type DocumentFieldExtractor } from './ai-port';
import { buildExtractionPrompt, type ExtractionPrompt } from './prompt';
import type { FenceOptions } from './fence';

/** Longest provider reply accepted before parsing. A reply is JSON, not a document. */
const MAX_REPLY_CHARS = 20_000;

/** Attempts per job attempt: the first call plus one retry. */
export const FIELD_EXTRACTION_CALL_ATTEMPTS = 2;

/** Confidence note added when no extractor is bound. Shown to the human verifier. */
export const FIELD_EXTRACTION_UNAVAILABLE_NOTE =
  'Automatic field extraction was unavailable, so no values were proposed. Enter each field from the document.';

/* ----------------------------------------------------------------- errors -- */

export type FieldExtractionFailureReason =
  'extractor_threw' | 'extractor_returned_unparseable_reply' | 'extractor_output_failed_schema';

export class FieldExtractionError extends Error {
  readonly reason: FieldExtractionFailureReason;
  /** Number of provider calls made. Safe to log. */
  readonly attempts: number;

  constructor(
    reason: FieldExtractionFailureReason,
    attempts: number,
    options?: { cause?: unknown },
  ) {
    super(
      `field extraction failed: ${reason}`,
      options?.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'FieldExtractionError';
    this.reason = reason;
    this.attempts = attempts;
  }
}

export function isFieldExtractionError(value: unknown): value is FieldExtractionError {
  return value instanceof FieldExtractionError;
}

/* ---------------------------------------------------------------- outcome -- */

export type FieldExtractionOutcome =
  | {
      readonly status: 'extracted';
      readonly extraction: DocumentExtraction;
      readonly extractorId: string;
      readonly promptVersion: string;
      readonly attempts: number;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'extractor_not_registered';
      readonly promptVersion: string;
    };

export interface ExtractFieldsOptions {
  /** Overrides the registry. Tests pass a stub; production leaves it unset. */
  readonly extractor?: DocumentFieldExtractor | null;
  readonly signal?: AbortSignal;
  readonly fence?: FenceOptions;
}

/**
 * Proposes fields for `documentText`.
 *
 * Returns `unavailable` — rather than throwing — when no extractor is bound. That is a
 * deployment state, not a document defect: the text extraction that already succeeded
 * must still be persisted, and the document must still appear on the verification
 * screen with every field blank and a note saying why. Treating it as a job failure
 * would retry it five times and dead-letter a document that is perfectly fine.
 */
export async function extractDocumentFields(
  documentText: string,
  options: ExtractFieldsOptions = {},
): Promise<FieldExtractionOutcome> {
  const prompt = buildExtractionPrompt(documentText, options.fence ?? {});
  const extractor =
    options.extractor === undefined ? getDocumentFieldExtractor() : options.extractor;

  if (!extractor) {
    return {
      status: 'unavailable',
      reason: 'extractor_not_registered',
      promptVersion: prompt.version,
    };
  }

  let lastError: FieldExtractionError | null = null;

  for (let attempt = 1; attempt <= FIELD_EXTRACTION_CALL_ATTEMPTS; attempt += 1) {
    try {
      const extraction = await callOnce(extractor, prompt, attempt, options.signal);
      return {
        status: 'extracted',
        extraction,
        extractorId: extractor.id,
        promptVersion: prompt.version,
        attempts: attempt,
      };
    } catch (thrown) {
      if (!isFieldExtractionError(thrown)) throw thrown;
      lastError = thrown;
      // An abort is not a bad sample. Retrying it would ignore the runner's deadline.
      if (options.signal?.aborted) break;
    }
  }

  throw lastError ?? new FieldExtractionError('extractor_threw', FIELD_EXTRACTION_CALL_ATTEMPTS);
}

async function callOnce(
  extractor: DocumentFieldExtractor,
  prompt: ExtractionPrompt,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<DocumentExtraction> {
  let reply: unknown;
  try {
    reply = await extractor.extract(signal ? { prompt, signal } : { prompt });
  } catch (cause) {
    throw new FieldExtractionError('extractor_threw', attempt, { cause });
  }

  const candidate = coerceReply(reply);
  if (candidate === null) {
    throw new FieldExtractionError('extractor_returned_unparseable_reply', attempt);
  }

  const parsed = DocumentExtractionSchema.safeParse(candidate);
  if (!parsed.success) {
    // The Zod issues are not attached as a cause: an issue carries the offending value,
    // which here is model output derived from document text (CLAUDE.md rule 8).
    throw new FieldExtractionError('extractor_output_failed_schema', attempt);
  }
  return parsed.data;
}

/**
 * Turns a provider reply into something parseable, or `null`.
 *
 * Accepts a plain object (an adapter that already parsed) and a string (one that did
 * not). A fenced code block is unwrapped, because every chat model emits one eventually
 * however firmly the prompt says "JSON only", and failing the job over punctuation
 * would be a poor trade. Nothing beyond that is repaired: a reply that needs guessing
 * is a reply that cannot be trusted.
 */
function coerceReply(reply: unknown): unknown {
  if (reply === null || reply === undefined) return null;
  if (typeof reply === 'object') return reply;
  if (typeof reply !== 'string') return null;
  if (reply.length === 0 || reply.length > MAX_REPLY_CHARS) return null;

  const unfenced = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsed: unknown = JSON.parse(unfenced);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
