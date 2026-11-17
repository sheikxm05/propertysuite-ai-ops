/**
 * The two outbound ports this feature needs, and nothing else.
 *
 * Both are **narrowings of interfaces that already exist**, not new ones. That is the
 * whole point of the file: this lane names the smallest surface it actually uses, and
 * the concrete objects from `services/rag` and `services/ai` satisfy those names
 * structurally, with no adapter in between.
 *
 *   `QueryEmbedder`  ← satisfied by `EmbeddingClient` (`services/rag/embeddings.ts`)
 *   `ModelTransport` ← re-exported from `services/ai/providers/transport.ts`, unchanged
 *
 * WHY NARROW AT ALL, RATHER THAN IMPORTING THE FULL TYPES
 * -------------------------------------------------------
 * `EmbeddingClient` also carries `embedPassages`, which is the ingestion side of the
 * asymmetric model: it embeds *stored chunks*, and it is lane w3-l2's to call from the
 * embedding job. Nothing in this lane should be able to reach it. Declaring the port
 * without it means a reader of `ask-service.ts` can see at the type level that the only
 * embedding this feature performs is of a question — and that the "did they use
 * `query` or `passage`?" question, which has no visible symptom when answered wrongly,
 * has only one answer available here.
 *
 * Reusing `ModelTransport` rather than inventing a chat port means the fencing, the JSON
 * extraction and the retry rule in this lane operate on exactly the same seam the
 * classification path does — so a recorded transport written for the eval suite works
 * for this route too, with no second abstraction to keep in sync.
 */

export type { ModelTransport } from '@/services/ai/providers/transport';

/**
 * Turns a question into a vector.
 *
 * `embedQuery`, never `embedPassages`. `nvidia/nemotron-3.5-embed-1b` is asymmetric: it
 * places a question and a stored paragraph in deliberately different regions of the same
 * space, so that "What is the rent?" lands near a clause that *states* a rent rather
 * than near other questions about rent. Embedding a question as a passage is not an
 * error — the call succeeds, the vector is the right width, the search returns six
 * chunks, and the answers are quietly, unfalsifiably worse. `services/rag` exposes the
 * two sides as two methods rather than one method with a flag precisely so the mistake
 * is unavailable, and this port carries only the side this lane is allowed to use.
 */
export interface QueryEmbedder {
  /** Resolved embedding model id. Logged, never hardcoded at a call site. */
  readonly model: string;
  /** Vector width. Matches the `halfvec(2048)` column migration 0004 declares. */
  readonly dimensions: number;
  /**
   * Embeds one question.
   *
   * Throws rather than returning a partial or zero vector: a zero vector would retrieve
   * an arbitrary six chunks and the answer built on them would look entirely plausible.
   */
  embedQuery(input: string, options?: { readonly signal?: AbortSignal }): Promise<number[]>;
}
