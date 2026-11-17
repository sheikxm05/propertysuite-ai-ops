/**
 * Retrieval — vector search, then a second authorization pass over the result.
 *
 * Two layers, on purpose, and the second one is not redundant.
 *
 *  1. `public.search_document_chunks(p_organization_id, p_query, p_limit, p_document_id)`
 *     is `security definer` (migration 0004). It applies the organization predicate and
 *     `can_read_document` inside a MATERIALIZED CTE **before** any similarity ordering,
 *     which is the only correct order: filtering after a `limit` would let another
 *     organization's chunks consume the result slots and silently starve the caller's
 *     own answer, and "the row was dropped afterwards" is not isolation if the ranking
 *     already depended on rows the caller cannot see.
 *
 *  2. Every chunk it returns is then re-read from `document_chunks`, and every document
 *     those chunks name is re-read from `documents`, through the **caller's own** client
 *     with Row Level Security in force. A chunk that does not come back from both is
 *     discarded, and each row's `organization_id` is compared to the caller's membership
 *     as well.
 *
 * Layer 2 exists because layer 1 runs as its owner: its correctness is a property of SQL
 * written in another lane, and `security definer` is precisely the construct that makes
 * a mistake there invisible to RLS. The project is judged on "enforced in Postgres RLS
 * *and* server-side" — this is the server-side half, written so that a defect in the
 * definer function produces an empty answer rather than a cross-tenant one.
 *
 * It also earns its keep in the ordinary case, because it is where two fields the
 * citation contract needs come from and the search function does not return:
 * `chunk_index` (from `document_chunks`) and `document_type` (from `documents`).
 *
 * `p_organization_id` is `membership.organization.id` and is never read from the request
 * body — `AskRequestSchema` has no field for one (CLAUDE.md rule 5).
 *
 * Nothing in this file logs chunk content (CLAUDE.md rule 8). Counts and ids only.
 */

import { ApiRouteError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import { toVectorLiteral } from '@/services/rag/embedding-model';

import { RAG_MAX_EXCERPT_CHARS } from '../contract';

/** The name of the retrieval function. One string, one place. */
export const SEARCH_FUNCTION = 'search_document_chunks';

/** A chunk that survived the definer function and both caller-scoped re-reads. */
export interface RetrievedChunk {
  /** 1-based position in the ranked list. This is the `[SOURCE n]` the model cites. */
  readonly ordinal: number;
  readonly chunkId: string;
  readonly documentId: string;
  /** From the `documents` row, read with the caller's client. Never from the chunk. */
  readonly documentType: string;
  /** Position within the document, zero-based. From `document_chunks.chunk_index`. */
  readonly chunkIndex: number;
  /** Stored chunk text. **Untrusted** — fenced before it reaches a model. */
  readonly content: string;
  /** Cosine distance, lower is nearer. */
  readonly distance: number | null;
}

export interface RetrieveInput {
  readonly embedding: readonly number[];
  readonly limit: number;
  /** Narrows to one document. Still subject to both authorization layers. */
  readonly documentId?: string | undefined;
}

export interface RetrieveOutcome {
  readonly chunks: readonly RetrievedChunk[];
  /** Rows the definer function returned, before the caller-scoped re-reads. */
  readonly matched: number;
  /**
   * Rows dropped by layer 2. Expected to be zero forever.
   *
   * Non-zero is not a user-facing condition and is not an error the caller caused — it
   * means the definer function returned a chunk the caller's own RLS policies refuse.
   * Logged at warning level by the route, because it is the signature of exactly the
   * defect layer 2 exists to contain.
   */
  readonly withheld: number;
}

/* -------------------------------------------------------------- the search -- */

/**
 * The minimum surface needed to call a Postgres function.
 *
 * `packages/shared/types/database.ts` is generated against migrations 0001–0003 and has
 * no entry for `search_document_chunks`, which landed in 0004 — and that file belongs to
 * lane w0-l4, so this lane cannot add one (CLAUDE.md rule 2). Raised as a planning
 * defect; until it is regenerated, the call is made through this narrow structural type.
 *
 * The static typing given up here is bought back at runtime immediately below:
 * `readSearchRow` validates every field of every row and discards anything it cannot
 * read, so a signature change downstream produces zero results rather than an exception
 * or, worse, a silently mis-shaped citation.
 */
interface RpcCapableClient {
  rpc(
    fn: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: PostgrestFailure | null }>;
}

/**
 * The minimum surface needed to read `document_chunks` by primary key.
 *
 * Same planning defect as `RpcCapableClient` and the same containment: the table landed
 * in 0004, the generated `Database` type stops at 0003, so the typed client resolves
 * `from('document_chunks')` to `never`. `readChunkRow` validates each row at runtime.
 *
 * Note the shape of the narrowing — `from → select → in`, and nothing else. There is no
 * `insert`, no `update`, no `upsert` and no `delete` on this interface, so the cast that
 * recovers the chunk read cannot be reused to smuggle a write past the type system. It
 * would also fail at the database: 0004 revokes INSERT, UPDATE and DELETE on
 * `document_chunks` from `authenticated` outright.
 */
interface ChunkReadClient {
  from(table: 'document_chunks'): {
    select(columns: string): {
      in(
        column: string,
        values: readonly string[],
      ): PromiseLike<{ data: unknown; error: PostgrestFailure | null }>;
    };
  };
}

/** What PostgREST reports. Code and message only; the message is logged, never returned. */
interface PostgrestFailure {
  readonly message: string;
  readonly code?: string;
}

/** One row of the caller-scoped `document_chunks` re-read. */
interface ChunkRow {
  readonly id: string;
  readonly organizationId: string;
  readonly chunkIndex: number;
}

function readChunkRow(row: unknown): ChunkRow | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;

  const id = record.id;
  const organizationId = record.organization_id;
  const chunkIndex = record.chunk_index;

  if (typeof id !== 'string' || typeof organizationId !== 'string') return null;
  if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return null;
  }

  return { id, organizationId, chunkIndex };
}

/** One row of `search_document_chunks`, as migration 0004's `returns table` declares it. */
interface SearchRow {
  readonly chunkId: string;
  readonly documentId: string;
  readonly content: string;
  readonly distance: number | null;
}

/**
 * Reads one row of the function's result.
 *
 * Returning `null` for an unreadable row rather than throwing is deliberate: one odd row
 * should cost its own citation, not the whole answer.
 */
function readSearchRow(row: unknown): SearchRow | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;

  const chunkId = record.chunk_id;
  const documentId = record.document_id;
  const content = record.content;
  const distance = record.distance;

  if (typeof chunkId !== 'string' || chunkId.length === 0) return null;
  if (typeof documentId !== 'string' || documentId.length === 0) return null;
  if (typeof content !== 'string' || content.trim().length === 0) return null;

  return {
    chunkId,
    documentId,
    content,
    distance: typeof distance === 'number' && Number.isFinite(distance) ? distance : null,
  };
}

/**
 * Wraps `services/rag`'s vector serialiser so a bad vector is an envelope, not a crash.
 *
 * The serialisation itself belongs to the lane that owns the embedding width and is
 * imported from there, not restated here: pgvector's `halfvec` input function parses the
 * text form `[0.1,0.2,…]`, PostgREST hands a JSON **string** to that parser directly,
 * and a JSON *array* would arrive as `json` with no implicit cast — a failure that reads
 * like a missing migration. One copy of that knowledge is enough.
 *
 * What this wrapper adds is the HTTP contract. `toVectorLiteral` throws `RangeError` for
 * a non-finite component or the wrong width, both of which mean the embedding provider
 * returned something impossible. Converted here to the frozen envelope so the caller
 * gets a 500 with a correlation id rather than an unhandled exception.
 */
function vectorLiteral(embedding: readonly number[]): string {
  try {
    return toVectorLiteral(embedding);
  } catch (cause) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'embedding_not_serialisable' },
      cause,
    });
  }
}

/**
 * Maps a failure of the search function onto the frozen envelope.
 *
 * The function **raises** rather than returning an empty set when the caller is not a
 * member of the organization (`42501`), and migration 0004 says why in as many words: an
 * empty result and a denial are different answers and the caller is entitled to tell
 * them apart. That distinction only survives if this function preserves it, so a `42501`
 * becomes a 403 rather than being flattened into "nothing found".
 *
 * `28000` (no authenticated session) and `22023` (a 2048-dimension mismatch) are both
 * defects on our side of the call, not the caller's, and become 500s.
 */
function searchError(error: { message: string; code?: string }): ApiRouteError {
  if (error.code === '42501') {
    return new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'chunk_search_denied', pg_code: error.code },
    });
  }
  // The message can name a column, a function signature or a dimension count. It is
  // carried as a log field, never returned; the caller sees the frozen envelope.
  return new ApiRouteError('INTERNAL_ERROR', {
    logFields: { reason: 'chunk_search_failed', pg_code: error.code ?? 'unknown' },
  });
}

/* ----------------------------------------------------------------- the API -- */

/**
 * Finds the chunks most like the question, within the caller's organization.
 *
 * Returns an empty list rather than throwing when nothing matches. "No document says
 * this" is an ordinary answer and the route turns it into a plain statement to that
 * effect; it is not a 404, because the question was understood and the search ran.
 */
export async function retrieveChunks(
  supabase: AppSupabaseClient,
  membership: Membership,
  input: RetrieveInput,
): Promise<RetrieveOutcome> {
  const organizationId = membership.organization.id;

  const { data, error } = await (supabase as unknown as RpcCapableClient).rpc(SEARCH_FUNCTION, {
    p_organization_id: organizationId,
    p_query: vectorLiteral(input.embedding),
    p_limit: input.limit,
    p_document_id: input.documentId ?? null,
  });

  if (error) throw searchError(error);

  const rows = Array.isArray(data) ? data : [];
  const ranked = rows
    .map((row) => readSearchRow(row))
    .filter((row): row is SearchRow => row !== null);

  if (ranked.length === 0) return { chunks: [], matched: rows.length, withheld: 0 };

  /*
   * Layer 2. Both re-reads go through the caller's own client, so both are governed by
   * the policies in 0004 §3 rather than by the definer function's judgement. Issued
   * together because neither depends on the other's result: two small `in (…)` lookups
   * on primary keys, one round trip of latency.
   */
  const chunkIds = ranked.map((row) => row.chunkId);
  const documentIds = Array.from(new Set(ranked.map((row) => row.documentId)));

  const [chunkRead, documentRead] = await Promise.all([
    (supabase as unknown as ChunkReadClient)
      .from('document_chunks')
      .select('id, organization_id, chunk_index')
      .in('id', chunkIds),
    supabase.from('documents').select('id, organization_id, document_type').in('id', documentIds),
  ]);

  if (chunkRead.error) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'citation_chunk_read_failed', pg_code: chunkRead.error.code },
    });
  }
  if (documentRead.error) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'citation_document_read_failed', pg_code: documentRead.error.code },
    });
  }

  /** chunk id → its position in the document, for chunks the caller can actually read. */
  const chunkIndexById = new Map<string, number>();
  for (const raw of Array.isArray(chunkRead.data) ? chunkRead.data : []) {
    const row = readChunkRow(raw);
    if (!row) continue;
    // Belt and braces over RLS. A row carrying another organization's id would mean a
    // policy regression, and it must not become a citation.
    if (row.organizationId !== organizationId) continue;
    chunkIndexById.set(row.id, row.chunkIndex);
  }

  /** document id → its controlled type, for documents the caller can actually read. */
  const documentTypeById = new Map<string, string>();
  for (const row of documentRead.data ?? []) {
    if (row.organization_id !== organizationId) continue;
    documentTypeById.set(row.id, row.document_type);
  }

  const chunks: RetrievedChunk[] = [];
  for (const row of ranked) {
    const chunkIndex = chunkIndexById.get(row.chunkId);
    const documentType = documentTypeById.get(row.documentId);
    if (chunkIndex === undefined || documentType === undefined) continue;

    chunks.push({
      // Renumbered after filtering, so `[SOURCE n]` is always contiguous from 1 and the
      // model is never shown a gap that invites it to guess at a missing source.
      ordinal: chunks.length + 1,
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentType,
      chunkIndex,
      content: row.content,
      distance: row.distance,
    });
  }

  return {
    chunks,
    matched: rows.length,
    withheld: ranked.length - chunks.length,
  };
}

/**
 * The excerpt shown beneath an answer.
 *
 * Collapses whitespace — a PDF extract arrives carrying the line breaks of its original
 * layout, which inside a quoted excerpt reads as corruption rather than as fidelity —
 * and cuts on a word boundary so the last word of a citation is a word.
 */
export function toExcerpt(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= RAG_MAX_EXCERPT_CHARS) return flat;

  // One character short of the bound, because the ellipsis is appended afterwards and
  // counts. `RagCitationSchema` caps the excerpt at exactly `RAG_MAX_EXCERPT_CHARS`, and
  // `ok()` validates the response against it — so an off-by-one here is not a cosmetic
  // overflow, it is a 500 on a chunk that happens to have no late word break.
  const cut = flat.slice(0, RAG_MAX_EXCERPT_CHARS - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > (RAG_MAX_EXCERPT_CHARS - 1) * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
