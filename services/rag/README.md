# `services/rag` — chunking and embeddings

Lane **w3-l2**. Turns `documents.extracted_text` into stored, embedded chunks that the
retrieval layer can cite.

```
documents.extracted_text
  → chunkDocumentText()            800–1200 chars, ~15% overlap, clause heading carried
  → embedPassages()                nvidia/nemotron-3.5-embed-1b, 2048 dims, input_type=passage
  → replaceDocumentChunks()        upsert by (organization_id, document_id, chunk_index)
  → public.document_chunks         embedding halfvec(2048), service-role write only
```

## Files

| File                           | What it is                                                      |
| ------------------------------ | --------------------------------------------------------------- |
| `chunking.ts`                  | Pure, deterministic splitter. No I/O, no server imports.          |
| `embedding-model.ts`           | Model id, 2048 dimensions, pgvector literal serialisation.        |
| `errors.ts`                    | Failure vocabulary and the retryable-vs-permanent split.          |
| `embeddings.ts`                | NIM `POST /embeddings`: batching, bounded pool, bounded retries.  |
| `chunk-store.ts`               | Reads `documents`, writes `document_chunks` with the service role.|
| `document-embedding-job.ts`    | The queue handler, its payload, its idempotency key.              |
| `server-only/embed-document.ts`| The direct, non-queue path. Not exported from the barrel.         |

## What other lanes call

**w3-l3 — retrieval API and ask UI**

```ts
import { createNvidiaEmbeddingClient, toVectorLiteral } from '@/services/rag';

const vector = await createNvidiaEmbeddingClient().embedQuery(question);
const { data } = await callerScopedClient.rpc('search_document_chunks', {
  p_organization_id: membership.organizationId,
  p_query: toVectorLiteral(vector),
  p_limit: 8,
});
```

`embedQuery`, not `embedPassages`. The model is asymmetric: embedding a question on the
passage side returns a vector that is merely *near* the right place, nothing errors, and
recall drops silently.

`search_document_chunks` (migration `0004`) is `security definer` and refuses a
service-role caller with `28000` — it authorizes a human, and there is no human in a
service-role session. Call it with the caller-scoped client.

**Anything that uploads or re-extracts a document**

```ts
await enqueueDocumentEmbedding(serviceRoleClient, {
  documentId,
  organizationId,
  suffix: fingerprintText(extractedText), // so changed text is a new job, not a no-op
});
```

**Whoever assembles the worker registry**

```ts
new JobHandlerRegistry()
  .register(createDocumentExtractionHandler())
  .register(createDocumentEmbeddingHandler());
```

This lane does not own `services/workers/index.ts` and so cannot add itself to
`createDefaultRegistry()`. Until it is added there, `npx tsx services/workers/cli.ts`
will never claim a `document_embedding` job. See the lane report.

## Rules this directory keeps

- **Nothing logs chunk content, document text or an embedding.** Counts, durations,
  token totals, model and ids only (CLAUDE.md rule 8). `chunking.ts` and `embeddings.ts`
  have no logger at all.
- **`organization_id` is always re-derived from the `documents` row**, never taken from
  the job payload, because the writing client bypasses RLS (CLAUDE.md rule 5).
- **Writes go through the service-role client only.** `document_chunks` has no client
  INSERT policy by design.
- **Do not import this barrel from a client component.** It reaches
  `lib/server-only/secrets.ts`. A client component that wants the splitter imports
  `@/services/rag/chunking` directly.
