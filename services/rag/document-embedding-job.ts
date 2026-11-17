/**
 * The `document_embedding` job handler.
 *
 * Chunk a document's extracted text, embed the chunks, store them. It runs on the
 * existing queue in `services/workers/**` — this lane exports a handler and the
 * registry it is registered into belongs to that lane, so nothing here edits the
 * runner, the queue or the registry.
 *
 * Three properties, in the order they matter:
 *
 *  1. **Tenant-scoped despite an RLS-bypassing client.** The handler receives the
 *     service-role client from the runner. `organization_id` is re-derived from the
 *     `documents` row and the payload must agree with it; a mismatch fails permanently
 *     rather than proceeding with either value. This is the same control
 *     `document-extraction-job.ts` applies, for the same reason: a payload is data, and
 *     a client that ignores policies will happily act on poisoned data.
 *  2. **Idempotent.** Two kinds of repetition have to be handled and they are handled
 *     in different places. A duplicate *enqueue* is stopped by `jobs.idempotency_key`,
 *     which is `unique` — `enqueueDocumentEmbedding` returns the existing job with
 *     `created: false`. A repeated *run* — a retry after the model call succeeded and
 *     the insert failed, a deliberate re-embedding after re-extraction — is handled by
 *     `replaceDocumentChunks`, which upserts each chunk onto its own
 *     `(organization_id, document_id, chunk_index)` and then drops any surplus tail.
 *     Re-running produces one set of chunks, never two, and never an empty window.
 *  3. **Silent about content.** Counts, durations, token totals, document and
 *     organization ids. Never a chunk, never the text, never a vector (CLAUDE.md
 *     rule 8). The logger's allowlist would drop them anyway; the call sites below do
 *     not rely on that.
 *
 * ---------------------------------------------------------------------------
 * PLANNING DEFECT (reported, not worked around)
 * ---------------------------------------------------------------------------
 * `JOB_TYPES` in `packages/shared/constants/statuses.ts` is `['document_extraction']`.
 * There is no `'document_embedding'` token, and `packages/shared/**` belongs to lane
 * w0-l4 — no wave-3 lane owns it, so this lane cannot add one and must not define a
 * local copy of a frozen enum (CLAUDE.md rule 4).
 *
 * The database is unaffected: `jobs.type` is plain `text` with no check constraint
 * (`0003`, section 2), the runner's registry is keyed by `string`, and `claimNextJob`
 * passes the type list to PostgREST as strings. So the job type works end to end at
 * runtime and the gap is purely in the TypeScript union. The single assertion below is
 * the whole of the workaround, named and isolated so that adding `'document_embedding'`
 * to `JOB_TYPES` makes it a no-op and deleting it is a one-line change.
 *
 * Second, smaller gap: `JOB_FAILURE_REASONS` in `services/workers/job-errors.ts` has no
 * embedding-specific token either, so the mapping at the bottom of this file reuses the
 * nearest existing ones. They are honest about retryability, which is what the queue
 * acts on, but an operator reading `last_error: 'extractor_threw'` on an embedding job
 * is reading a token written for field extraction.
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';

import { UuidSchema, type JobType } from '@shared/index';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';
import {
  PermanentJobError,
  RetryableJobError,
  enqueueJob,
  type EnqueueResult,
  type JobHandler,
  type JobHandlerContext,
} from '@/services/workers';

import { chunkDocumentText, type ChunkTextOptions } from './chunking';
import { loadDocumentForEmbedding, replaceDocumentChunks } from './chunk-store';
import { createNvidiaEmbeddingClient, type EmbeddingClient } from './embeddings';
import { RagConfigurationError, RagError, isRagError } from './errors';

/**
 * `jobs.type` for this handler.
 *
 * The assertion is the planning defect described in the file header, in its entirety.
 * The value is a legal `jobs.type` — that column is unconstrained `text` — and every
 * consumer of `JobType` treats it as a string at runtime.
 */
export const DOCUMENT_EMBEDDING_JOB_TYPE = 'document_embedding' as unknown as JobType;

/** The same value, honestly typed, for anything that wants a plain string. */
export const DOCUMENT_EMBEDDING_JOB_TYPE_NAME = 'document_embedding';

/* --------------------------------------------------------------- payload -- */

/**
 * The payload.
 *
 * `organization_id` is carried so the handler can *cross-check* the row it reads, not
 * so it can scope the read. `requested_by` is recorded for the log trail and grants
 * nothing. `.strict()` so an unexpected key is a rejected payload rather than an
 * ignored one.
 */
export const DocumentEmbeddingPayloadSchema = z
  .object({
    document_id: UuidSchema,
    organization_id: UuidSchema,
    requested_by: UuidSchema.nullable().optional(),
  })
  .strict();

export type DocumentEmbeddingPayload = z.infer<typeof DocumentEmbeddingPayloadSchema>;

/**
 * A short, stable fingerprint of a string. FNV-1a, 32 bits, hex.
 *
 * Not a security primitive and not used as one — it exists so a caller can build an
 * idempotency key that *changes when the text changes*. Without that, re-extracting a
 * document and re-enqueueing its embedding would collide with the already-`done` job
 * and silently do nothing, leaving the corpus holding chunks of text that no longer
 * exists. With it, new text is a new key and therefore a new job.
 */
export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Builds the exactly-once key for a document's embedding.
 *
 * Mirrors `documentExtractionIdempotencyKey`. Pass a `suffix` — the text fingerprint,
 * or a deliberate re-run marker — whenever the same document must be embedded again;
 * the bare key is correct only for the first embedding of a given text.
 */
export function documentEmbeddingIdempotencyKey(
  documentId: string,
  suffix?: string | null,
): string {
  const base = `${DOCUMENT_EMBEDDING_JOB_TYPE_NAME}:${documentId}`;
  return suffix && suffix.length > 0 ? `${base}:${suffix}` : base;
}

/* --------------------------------------------------------------- enqueue -- */

export interface EnqueueDocumentEmbeddingInput {
  readonly documentId: string;
  readonly organizationId: string;
  readonly requestedBy?: string | null;
  /**
   * Distinguishes one embedding of this document from another. Pass
   * `fingerprintText(extractedText)` after a re-extraction.
   */
  readonly suffix?: string | null;
  readonly runAt?: Date;
}

/**
 * Enqueues an embedding job, or returns the one already holding this key.
 *
 * A thin wrapper over the queue's own `enqueueJob` so that callers — the documents
 * lane, a backfill script, an operator — cannot get the type name or the key format
 * wrong, which are the two ways to accidentally create a second job for one document.
 */
export async function enqueueDocumentEmbedding(
  client: PrivilegedSupabaseClient,
  input: EnqueueDocumentEmbeddingInput,
): Promise<EnqueueResult> {
  return enqueueJob(client, {
    type: DOCUMENT_EMBEDDING_JOB_TYPE,
    payload: {
      document_id: input.documentId,
      organization_id: input.organizationId,
      requested_by: input.requestedBy ?? null,
    },
    idempotencyKey: documentEmbeddingIdempotencyKey(input.documentId, input.suffix),
    ...(input.runAt ? { runAt: input.runAt } : {}),
  });
}

/* --------------------------------------------------------------- handler -- */

export interface DocumentEmbeddingDeps {
  /** Injected in tests and evals so the handler runs without a live provider. */
  readonly embedder?: EmbeddingClient;
  readonly chunking?: ChunkTextOptions;
  readonly now?: () => number;
}

/**
 * Creates the handler.
 *
 * A factory rather than a bare object so dependencies are injected at wiring time
 * instead of read from module state, matching `createDocumentExtractionHandler()`. The
 * production call takes no arguments.
 *
 * Register it with the runner's registry:
 *
 *     new JobHandlerRegistry()
 *       .register(createDocumentExtractionHandler())
 *       .register(createDocumentEmbeddingHandler());
 */
export function createDocumentEmbeddingHandler(deps: DocumentEmbeddingDeps = {}): JobHandler {
  return {
    type: DOCUMENT_EMBEDDING_JOB_TYPE,

    async run(context: JobHandlerContext): Promise<void> {
      const { client, logger, signal } = context;
      const clock = deps.now ?? (() => Date.now());
      const startedAt = clock();

      const payload = parsePayload(context.job.payload);

      const document = await guard(() => loadDocumentForEmbedding(client, payload.document_id));
      if (!document) throw new PermanentJobError('document_not_found');

      // Tenant check. The row's organization is the truth; the payload must agree.
      if (document.organizationId !== payload.organization_id) {
        throw new PermanentJobError('document_organization_mismatch');
      }

      const text = document.extractedText ?? '';
      if (text.trim().length === 0) {
        // Nothing to embed, and no retry will produce text: the extraction job writes
        // this column, and if it has not, this job should not have been enqueued.
        throw new PermanentJobError('pdf_parse_returned_no_text');
      }

      const chunked = chunkDocumentText(text, deps.chunking ?? {});
      if (chunked.chunks.length === 0) throw new PermanentJobError('pdf_parse_returned_no_text');

      logger.info('document chunked', {
        document_id: document.id,
        organization_id: document.organizationId,
        count: chunked.chunks.length,
        outcome: chunked.truncated ? 'chunked_truncated' : 'chunked',
        duration_ms: clock() - startedAt,
      });

      const embedder = deps.embedder ?? createNvidiaEmbeddingClient();
      const embedStartedAt = clock();

      const vectors = await guard(() =>
        embedder.embedPassages(
          chunked.chunks.map((chunk) => chunk.content),
          signal ? { signal } : {},
        ),
      );

      if (vectors.length !== chunked.chunks.length) {
        // Belt and braces over the client's own check: a vector stored against the
        // wrong chunk produces citations that point at text the answer did not use.
        throw new RetryableJobError('extractor_returned_unparseable_reply');
      }

      logger.info('document chunks embedded', {
        document_id: document.id,
        organization_id: document.organizationId,
        model: embedder.model,
        provider: embedder.id,
        count: vectors.length,
        tokens_in: chunked.totalTokens,
        duration_ms: clock() - embedStartedAt,
      });

      const stored = await guard(() =>
        replaceDocumentChunks(client, {
          organizationId: document.organizationId,
          documentId: document.id,
          chunks: chunked.chunks.map((chunk, index) => ({
            index: chunk.index,
            content: chunk.content,
            tokenCount: chunk.tokenCount,
            embedding: vectors[index] ?? [],
          })),
        }),
      );

      logger.info('document chunks stored', {
        document_id: document.id,
        organization_id: document.organizationId,
        count: stored.inserted,
        // How many stale chunks this run replaced — 0 on a first embedding, non-zero
        // on a re-embedding, which is the observable proof that re-running replaced
        // rather than duplicated.
        retry_count: stored.removed,
        tokens_in: chunked.totalTokens,
        outcome: 'embedded',
        duration_ms: clock() - startedAt,
      });
    },
  };
}

/* ----------------------------------------------------------------- steps -- */

function parsePayload(raw: unknown): DocumentEmbeddingPayload {
  const parsed = DocumentEmbeddingPayloadSchema.safeParse(raw);
  // A malformed payload cannot become well formed on a retry.
  if (!parsed.success) throw new PermanentJobError('payload_invalid');
  return parsed.data;
}

/** Runs a step and translates this lane's errors into the queue's vocabulary. */
async function guard<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (thrown) {
    if (isRagError(thrown)) throw toJobError(thrown);
    throw thrown;
  }
}

/**
 * Maps a `RagError` to the queue's closed failure vocabulary.
 *
 * The retry decision is the part that must be right, and it comes from the error's own
 * `retryable` flag rather than from the token: a configuration fault dead-letters
 * immediately because no number of attempts can fix a dead model or an unentitled
 * account, while a 429 or a timeout is scheduled for another attempt.
 *
 * The *token* is a lesser fit — see the second planning defect in the file header —
 * because `JOB_FAILURE_REASONS` has no embedding entries and this lane may not add one.
 */
function toJobError(error: RagError): Error {
  if (error.kind === 'storage') {
    return new RetryableJobError('database_write_failed', { cause: error });
  }
  if (error.kind === 'aborted') {
    return new RetryableJobError('aborted', { cause: error });
  }
  if (error.kind === 'malformed_reply') {
    return new RetryableJobError('extractor_returned_unparseable_reply', { cause: error });
  }
  if (error instanceof RagConfigurationError || !error.retryable) {
    return new PermanentJobError('extractor_threw', { cause: error });
  }
  return new RetryableJobError('extractor_threw', { cause: error });
}
