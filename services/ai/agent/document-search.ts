/**
 * The seam to lane w3-l2/w3-l3's retrieval, and the honest stub that stands in for it.
 *
 * WHY THIS IS A SEAM AND NOT A RETRIEVER
 * --------------------------------------
 * `search_documents` needs chunking, embeddings and a vector index. Those are lane
 * w3-l2 (`services/rag/**`) and lane w3-l3 (`app/api/v1/rag/**`), both running
 * concurrently with this lane, and neither directory exists on disk yet. The two wrong
 * answers available were:
 *
 *   - write a second retriever here, which would be two embedding strategies, two
 *     chunkings and two sets of relevance behaviour for one question; or
 *   - drop the tool, which would silently change what the agent can do.
 *
 * So the tool stays in the registry with its real name and its real schema, and reports
 * `available: false` until a retriever is bound. The model is told the capability is not
 * deployed and reasons without it — which is the correct behaviour for a degraded
 * dependency, and is also what it should do in production the day the vector index is
 * down.
 *
 * WHAT A BOUND RETRIEVER MUST GUARANTEE
 * -------------------------------------
 * `query.organizationId` is derived from `Membership` by the route and passed through
 * unchanged. A retriever must scope to it and must additionally run under Row Level
 * Security as the caller; the agent has no way to check that from here, which is exactly
 * why the contract says so in the type.
 *
 * Every excerpt comes back as untrusted text. A document excerpt is the most hostile
 * input in this application — whoever uploaded the PDF wrote every character of it — and
 * it is fenced by `services/ai/fence.ts` under the `document_text` label before it
 * reaches the model, by the same code path a tenant's message takes.
 */

import type { Json } from '@shared/index';

/** What the agent asks for. `question` is model-authored text; `limit` is clamped. */
export interface DocumentSearchQuery {
  /** The organization, derived from `Membership`. A retriever must scope to it. */
  readonly organizationId: string;
  /** The model's own question. Untrusted — it is model output. */
  readonly question: string;
  readonly limit: number;
}

/** One retrieved passage. */
export interface DocumentSearchHit {
  /** `documents.id`. Structured, safe to show the model unfenced. */
  readonly documentId: string;
  /** Controlled vocabulary from the `documents` row, never the document's own claim. */
  readonly documentType: string;
  /** Similarity or rank, when the retriever reports one. */
  readonly score: number | null;
  /** The passage itself. **Untrusted.** Fenced before it reaches the model. */
  readonly excerpt: string;
}

export interface DocumentSearchResult {
  readonly hits: readonly DocumentSearchHit[];
}

/** The function shape a retrieval lane binds. */
export type DocumentSearchFn = (
  query: DocumentSearchQuery,
  signal?: AbortSignal,
) => Promise<DocumentSearchResult>;

let bound: DocumentSearchFn | null = null;

/**
 * Binds the real retriever.
 *
 * Intended to be called once, at composition time, by whatever wires the agent to
 * `services/rag`. Deliberately not auto-discovered: an agent whose capabilities depend on
 * which modules happen to have been imported is an agent whose capabilities nobody can
 * state.
 */
export function registerDocumentSearch(fn: DocumentSearchFn): void {
  bound = fn;
}

/** Unbinds. Exists so a test or an eval can assert the unavailable path. */
export function clearDocumentSearch(): void {
  bound = null;
}

/** Whether `search_documents` can do anything. Reported to the model as a fact. */
export function isDocumentSearchAvailable(): boolean {
  return bound !== null;
}

/**
 * Runs the bound retriever, or reports unavailability.
 *
 * Returns `null` when nothing is bound rather than throwing: "this capability is not
 * deployed" is an answer the agent can work with, and a thrown error would end a run
 * that is otherwise perfectly able to finish.
 */
export async function runDocumentSearch(
  query: DocumentSearchQuery,
  signal?: AbortSignal,
): Promise<DocumentSearchResult | null> {
  if (!bound) return null;
  return bound(query, signal);
}

/** The structured half of the unavailable answer. Shaped like a real result. */
export const DOCUMENT_SEARCH_UNAVAILABLE: Json = {
  available: false,
  reason: 'document_retrieval_not_deployed',
  hits: [],
  note: 'Document retrieval is not available in this deployment. Answer from the other tools, and say plainly that you could not consult documents.',
};
