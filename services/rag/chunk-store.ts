/**
 * Reads `documents.extracted_text`; writes `public.document_chunks`.
 *
 * `document_chunks` has **no client INSERT policy, by design** (lane w3-l1, migration
 * `0004`). Chunks are derived data: they are produced by a background job that has no
 * `auth.uid()`, and a tenant who could insert a chunk could insert a chunk claiming to
 * be from a document they do not own and then have the retrieval layer cite it as
 * authoritative. So every write below requires a `PrivilegedSupabaseClient` — the
 * service-role client, which bypasses RLS — and that shifts the entire burden of tenant
 * scoping onto this file. Two things carry it:
 *
 *  1. **`organization_id` is re-derived from the `documents` row, never taken from the
 *     job payload.** `loadDocumentForEmbedding` returns the row's own organization and
 *     the caller cross-checks the payload against it. A poisoned payload therefore
 *     cannot steer the worker at another tenant's document (CLAUDE.md rule 5).
 *  2. **Every statement is keyed on `(organization_id, document_id)`, both columns.**
 *     The table's composite foreign key makes that pair the real identity of a
 *     document, and filtering on `document_id` alone would be a correct query today and
 *     a cross-tenant one the day an id is reused or spoofed.
 *
 * ---------------------------------------------------------------------------
 * PLANNING DEFECT (reported, not worked around): the generated `Database` type in
 * `packages/shared/types/database.ts` predates migration `0004`, so it has no
 * `document_chunks` entry, and `packages/shared/**` belongs to lane w0-l4 — this lane
 * may not add one. The minimal schema below is a *local view of one table for one
 * client call*, not a second copy of a shared type: it declares no domain type, no
 * enum and no error code, and it disappears the moment `database.ts` is regenerated
 * against `0004`. The shape is transcribed from the frozen column list in the lane
 * briefing, column for column.
 * ---------------------------------------------------------------------------
 *
 * Nothing here logs. The caller logs counts; chunk content and vectors are unloggable
 * (CLAUDE.md rule 8).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

import { EMBEDDING_DIMENSIONS, toVectorLiteral } from './embedding-model';
import { RagConfigurationError, RagStorageError } from './errors';

/* ------------------------------------------------------------ table shape -- */

/** `public.document_chunks`, as created by migration `0004`. */
export type DocumentChunkRow = {
  id: string;
  organization_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number | null;
  /** `halfvec(2048)`. PostgREST moves it as a pgvector literal string. */
  embedding: string | null;
  created_at: string;
};

export type DocumentChunkInsert = {
  organization_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count?: number | null;
  embedding?: string | null;
};

/** The one-table schema the local client view is bound to. See the header. */
type ChunkSchema = {
  Tables: {
    document_chunks: {
      Row: DocumentChunkRow;
      Insert: DocumentChunkInsert;
      Update: Partial<DocumentChunkInsert>;
      Relationships: [];
    };
  };
  Views: Record<string, never>;
  Functions: Record<string, never>;
  Enums: Record<string, never>;
  CompositeTypes: Record<string, never>;
};

type ChunkDatabase = { public: ChunkSchema };

/**
 * Re-views the privileged client over the one table the generated types do not know
 * about yet. Runtime-identical — PostgREST does not care what TypeScript believes — and
 * confined to this module so there is exactly one place to delete when `database.ts`
 * catches up.
 */
function chunkTable(client: PrivilegedSupabaseClient) {
  return (client as unknown as SupabaseClient<ChunkDatabase>).from('document_chunks');
}

const pgCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
};

/* --------------------------------------------------------------- the row -- */

export interface DocumentForEmbedding {
  readonly id: string;
  readonly organizationId: string;
  readonly extractedText: string | null;
  readonly verificationStatus: string;
}

/**
 * Loads the document to be embedded, or `null` when it does not exist.
 *
 * Selects `organization_id` explicitly because that value — not the one in the job
 * payload — is the tenant this document belongs to. Everything downstream is scoped by
 * what this function returns.
 */
export async function loadDocumentForEmbedding(
  client: PrivilegedSupabaseClient,
  documentId: string,
): Promise<DocumentForEmbedding | null> {
  const { data, error } = await client
    .from('documents')
    .select('id, organization_id, extracted_text, verification_status')
    .eq('id', documentId)
    .maybeSingle();

  if (error) throw new RagStorageError('document_read_failed', pgCode(error), error);
  if (!data) return null;

  return {
    id: data.id,
    organizationId: data.organization_id,
    extractedText: data.extracted_text,
    verificationStatus: data.verification_status,
  };
}

/* ----------------------------------------------------------------- write -- */

/** A chunk ready to be stored: text, its index, its estimate and its vector. */
export interface EmbeddedChunk {
  readonly index: number;
  readonly content: string;
  readonly tokenCount: number;
  readonly embedding: readonly number[];
}

export interface ReplaceChunksInput {
  readonly organizationId: string;
  readonly documentId: string;
  readonly chunks: readonly EmbeddedChunk[];
  /** Rows per INSERT. A 2048-wide literal is ~26 KB, so batches stay small. */
  readonly insertBatchSize?: number;
}

export interface ReplaceChunksResult {
  readonly removed: number;
  readonly inserted: number;
}

/** Rows per INSERT statement. 16 x ~26 KB keeps a request body around 400 KB. */
const DEFAULT_INSERT_BATCH = 16;

/**
 * Replaces a document's chunks: upsert by position, then drop the surplus.
 *
 * **Why this is a replace and not an append.** Re-running an embedding job for a
 * document — because the text was re-extracted, because the chunker changed, because
 * the first attempt died after the model call — must leave the document with one set of
 * chunks. Appending would double every citation and double-count every similarity hit;
 * `chunk_index` would stop identifying a chunk.
 *
 * **Why upsert rather than delete-then-insert.** Migration `0004` gives the table
 * `unique (organization_id, document_id, chunk_index)`, so a chunk's position *is* its
 * identity and `on conflict` can overwrite it in place. That matters because PostgREST
 * calls are not one transaction: delete-then-insert leaves a window in which the
 * document has no chunks at all, and a question asked inside that window returns "no
 * sources found" for a document that is in fact indexed. Upserting closes the window —
 * every chunk index holds either its old content or its new content throughout, never
 * nothing.
 *
 * **The one DELETE, and why rule 6 permits it.** When the new text chunks into fewer
 * pieces than the old, indices at the tail are left pointing at superseded text. They
 * are removed by index, after the upserts have landed. CLAUDE.md rule 6 forbids a
 * DELETE path on a tenant-scoped table and is right to: a deleted ticket or document is
 * lost evidence, so those archive instead. A `document_chunks` row is a different kind
 * of thing — a *derivative index* of `documents.extracted_text`, rebuildable at any
 * time by re-running this job, carrying no fact the document does not already carry.
 * The document itself is never touched. Archiving instead would leave stale vectors in
 * the table the similarity search reads, which is the wrong outcome in the most
 * expensive way: a citation that points confidently at text the document no longer
 * contains. This is called out in the lane report as a deliberate, narrow exception
 * rather than left as an unremarked DELETE.
 *
 * Every statement is scoped to one organization and one document.
 */
export async function replaceDocumentChunks(
  client: PrivilegedSupabaseClient,
  input: ReplaceChunksInput,
): Promise<ReplaceChunksResult> {
  const rows = input.chunks.map((chunk) => toInsertRow(input, chunk));

  const size = Math.max(1, input.insertBatchSize ?? DEFAULT_INSERT_BATCH);
  let inserted = 0;

  for (let start = 0; start < rows.length; start += size) {
    const batch = rows.slice(start, start + size);
    const { error } = await chunkTable(client).upsert(batch, {
      onConflict: 'organization_id,document_id,chunk_index',
    });
    if (error) throw new RagStorageError('chunk_upsert_failed', pgCode(error), error);
    inserted += batch.length;
  }

  const removed = await deleteSurplusChunks(
    client,
    input.organizationId,
    input.documentId,
    rows.length,
  );

  return { removed, inserted };
}

/**
 * Removes chunks at index `fromIndex` and above — the tail left behind when a
 * re-embedding produced fewer chunks than the run before it.
 *
 * Runs *after* the upserts, so there is no moment at which a surviving index is
 * missing. With `fromIndex = 0` it empties the document, which is what the caller wants
 * when a document's text has gone.
 */
export async function deleteSurplusChunks(
  client: PrivilegedSupabaseClient,
  organizationId: string,
  documentId: string,
  fromIndex: number,
): Promise<number> {
  const { data, error } = await chunkTable(client)
    .delete()
    .eq('organization_id', organizationId)
    .eq('document_id', documentId)
    .gte('chunk_index', fromIndex)
    .select('id');

  if (error) throw new RagStorageError('chunk_delete_failed', pgCode(error), error);
  return data?.length ?? 0;
}

function toInsertRow(input: ReplaceChunksInput, chunk: EmbeddedChunk): DocumentChunkInsert {
  let embedding: string;
  try {
    embedding = toVectorLiteral([...chunk.embedding], EMBEDDING_DIMENSIONS);
  } catch (thrown) {
    // A wrong-width or non-finite vector is the wrong model answering, not a bad row.
    throw new RagConfigurationError('embedding_dimension_mismatch', { cause: thrown });
  }

  return {
    organization_id: input.organizationId,
    document_id: input.documentId,
    chunk_index: chunk.index,
    content: chunk.content,
    token_count: chunk.tokenCount,
    embedding,
  };
}

/**
 * Removes every chunk of one document, returning how many went.
 *
 * For the case the upsert path cannot express: a document whose text was withdrawn, so
 * the correct number of chunks is none. `.select('id')` so the count is the database's
 * answer rather than an assumption. Both key columns are pinned — see the file header.
 */
export async function deleteDocumentChunks(
  client: PrivilegedSupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<number> {
  return deleteSurplusChunks(client, organizationId, documentId, 0);
}

/** How many chunks a document currently has. Used by callers deciding to skip work. */
export async function countDocumentChunks(
  client: PrivilegedSupabaseClient,
  organizationId: string,
  documentId: string,
): Promise<number> {
  const { count, error } = await chunkTable(client)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('document_id', documentId);

  if (error) throw new RagStorageError('chunk_count_failed', pgCode(error), error);
  return count ?? 0;
}
