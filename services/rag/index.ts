/**
 * `services/rag` — chunking and embeddings, lane w3-l2.
 *
 * The one job of this directory: turn `documents.extracted_text` into stored, embedded
 * chunks that the retrieval layer can cite.
 *
 *   `chunking`                pure, deterministic splitter — no I/O, no server imports
 *   `embedding-model`         the model id, its 2048 dimensions, the pgvector literal
 *   `errors`                  the failure vocabulary and the retryable/permanent split
 *   `embeddings`              the NIM `/embeddings` transport: batching, pool, retries
 *   `chunk-store`             reads `documents`, writes `document_chunks` (service role)
 *   `document-embedding-job`  the queue handler, its payload and its idempotency key
 *   `server-only/embed-document`  the direct, non-queue path (absent from this barrel)
 *
 * ---------------------------------------------------------------------------
 * WHAT OTHER LANES CALL
 * ---------------------------------------------------------------------------
 * w3-l3 (retrieval API and ask UI)
 *   `createNvidiaEmbeddingClient().embedQuery(question)` — the question vector. It MUST
 *   be `embedQuery`, not `embedPassages`: the model is asymmetric and using the wrong
 *   side degrades recall silently (see `embedding-model.ts`).
 *   `EMBEDDING_DIMENSIONS` and `toVectorLiteral()` — to hand that vector to the
 *   `security definer` retrieval function as a `halfvec` literal.
 *
 * The documents lane, a backfill script, or an operator
 *   `enqueueDocumentEmbedding(serviceRoleClient, { documentId, organizationId })`
 *   `fingerprintText(extractedText)` as the `suffix` when re-embedding changed text.
 *
 * Whoever assembles the worker registry
 *   `createDocumentEmbeddingHandler()` — a `JobHandler` for `JobHandlerRegistry`.
 *   This lane does not own `services/workers/index.ts` and therefore cannot add itself
 *   to `createDefaultRegistry()`; see the lane report.
 *
 * ---------------------------------------------------------------------------
 * CLIENT COMPONENTS
 * ---------------------------------------------------------------------------
 * Do not import this barrel from a client component. It reaches
 * `lib/server-only/secrets.ts` through `embeddings.ts`. A client component that needs
 * the splitter — to preview how a document will be chunked, say — imports
 * `@/services/rag/chunking` directly, which has no server imports at all.
 *
 * And the rule that outranks the rest: **nothing in this directory ever logs chunk
 * content, document text or an embedding.** Counts, durations, token totals, model and
 * document ids only (CLAUDE.md rule 8).
 */

export * from './chunking';
export * from './embedding-model';
export * from './errors';
export * from './embeddings';
export * from './chunk-store';
export * from './document-embedding-job';
