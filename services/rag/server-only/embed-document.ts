/**
 * Embedding a document without going through the queue.
 *
 * The ordinary path is the job: `enqueueDocumentEmbedding`, then the runner. This
 * module is the direct one — a backfill of documents uploaded before the corpus
 * existed, a demo that needs the chunks to be there *now*, an operator re-embedding a
 * document whose job dead-lettered. It does the same work in the same order, so the
 * two paths cannot drift: it builds the handler and runs it against a synthetic job
 * row rather than reimplementing the steps.
 *
 * It is the only file in `services/rag` that creates a client of its own. Writes to
 * `document_chunks` go through the **service-role** client, because that table has no
 * client INSERT policy by design — so this module must be unreachable from a browser,
 * and it is kept so three ways: the `server-only` import below is a build failure in a
 * client component, the `server-only/` path segment is covered by the ESLint import
 * restriction, and `createServiceRoleClient()` throws if `window` exists.
 *
 * Deliberately **not** re-exported from `services/rag/index.ts`, for the same reason
 * `services/workers/cli.ts` is absent from its barrel: it reads a service-role
 * credential at call time, and a barrel that pulled it in would make every importer of
 * `services/rag` — including a route that only wants `embedQuery` — depend on one.
 */

import 'server-only';

import { systemLogger, type Logger } from '@/lib/observability/logger';
import { createServiceRoleClient } from '@/lib/supabase/server-only/service-role';
import type { JobRow } from '@shared/index';

import {
  DOCUMENT_EMBEDDING_JOB_TYPE_NAME,
  createDocumentEmbeddingHandler,
  documentEmbeddingIdempotencyKey,
  type DocumentEmbeddingDeps,
} from '../document-embedding-job';

export interface EmbedDocumentNowInput {
  readonly documentId: string;
  readonly organizationId: string;
  readonly requestedBy?: string | null;
  readonly logger?: Logger;
  readonly signal?: AbortSignal;
  readonly deps?: DocumentEmbeddingDeps;
}

/**
 * Chunks, embeds and stores one document, synchronously.
 *
 * Throws the queue's own error types (`PermanentJobError`, `RetryableJobError`) because
 * it runs the real handler — a caller outside the runner should treat a
 * `PermanentJobError` as "do not try this again" exactly as the runner does.
 *
 * The caller is responsible for authorization. This function derives the document's
 * organization from its row and refuses a mismatch, but it does not know who asked:
 * it must only be called after the caller's membership has been resolved
 * (CLAUDE.md rule 5).
 */
export async function embedDocumentNow(input: EmbedDocumentNowInput): Promise<void> {
  const client = createServiceRoleClient();
  const logger = input.logger ?? systemLogger({ operation: 'document_embedding_direct' });

  const job: JobRow = {
    id: documentEmbeddingIdempotencyKey(input.documentId, 'direct'),
    type: DOCUMENT_EMBEDDING_JOB_TYPE_NAME,
    payload: {
      document_id: input.documentId,
      organization_id: input.organizationId,
      requested_by: input.requestedBy ?? null,
    },
    idempotency_key: documentEmbeddingIdempotencyKey(input.documentId, 'direct'),
    attempts: 0,
    next_run_at: null,
    status: 'running',
    last_error: null,
    created_at: new Date().toISOString(),
  };

  await createDocumentEmbeddingHandler(input.deps ?? {}).run({
    job,
    client,
    logger,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
