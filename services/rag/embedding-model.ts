/**
 * The embedding model, its width, and how a vector is written to Postgres.
 *
 * Three facts, all measured against the live NIM API rather than read from a model
 * card, because each of them is a silent failure if it is wrong:
 *
 *  1. **`nvidia/nemotron-3.5-embed-1b` returns 2048 dimensions.** Not 1024, not 1536.
 *  2. **The column is `halfvec(2048)`, not `vector`.** pgvector refuses to index a
 *     `vector` wider than 2000 dimensions, and this model emits 2048 — so `vector`
 *     would take the inserts and then fail at `create index`, which is the worst place
 *     to discover it. `halfvec` indexes to 4096 and halves the storage; the precision
 *     it gives up (fp16 instead of fp32) is far below the noise floor of cosine
 *     similarity over this corpus.
 *  3. **NIM requires `input_type`.** `"passage"` for text being stored, `"query"` for
 *     a question. Asymmetric embedding models are trained with different instructions
 *     on each side, so embedding a question as a passage returns a vector that is
 *     merely *near* the right place. Nothing errors. Recall just quietly drops, which
 *     is why it is pinned by a type here rather than left to a string argument.
 *
 * ---------------------------------------------------------------------------
 * PLANNING DEFECT (reported, not worked around)
 * ---------------------------------------------------------------------------
 * The model id is a constant here rather than an environment variable because
 * `lib/env.ts` belongs to lane w0-l5 and defines `NVIDIA_BASE_URL`, `AI_MODEL` and
 * `NVIDIA_TEMPERATURE` but no embedding model. Reading `process.env` directly is
 * forbidden by the ESLint rule the repository relies on, and widening another lane's
 * file is forbidden by CLAUDE.md rule 2. A constant is the honest version of that
 * constraint: it is wrong in exactly one place, visibly, instead of being wrong in a
 * deployment nobody can inspect.
 */

/** The embedding model. Confirmed live with the project key. */
export const EMBEDDING_MODEL_ID = 'nvidia/nemotron-3.5-embed-1b';

/** Vector width. Must equal the `halfvec(N)` width of `document_chunks.embedding`. */
export const EMBEDDING_DIMENSIONS = 2048;

/** The Postgres column type this width implies. Documentation, not configuration. */
export const EMBEDDING_COLUMN_TYPE = `halfvec(${EMBEDDING_DIMENSIONS})`;

/**
 * Which side of the asymmetry an input is on.
 *
 * `passage` for a stored chunk, `query` for a question. Getting it backwards degrades
 * retrieval silently, so the embedding client exposes two methods rather than one
 * method with a flag — the mistake is then unavailable rather than merely discouraged.
 */
export type EmbeddingInputType = 'passage' | 'query';

/**
 * Serialises a vector as a pgvector literal.
 *
 * pgvector's input format is `'[0.1,0.2,...]'` — a string, which PostgREST sends as
 * JSON and Postgres casts to `halfvec`. Sending a JSON array instead would be stored as
 * `jsonb` or rejected, depending on the column, and neither failure is obvious.
 *
 * Validates rather than trusts: a `NaN` or an `Infinity` reaching this function means
 * the provider returned something impossible, and a vector of the wrong width means the
 * wrong model answered. Both are configuration faults, and both must surface here
 * rather than as a Postgres cast error three layers down.
 */
export function toVectorLiteral(
  values: readonly number[],
  dimensions: number = EMBEDDING_DIMENSIONS,
): string {
  if (values.length !== dimensions) {
    throw new RangeError(
      `embedding has ${values.length} dimensions, expected ${dimensions} — wrong model?`,
    );
  }
  const parts = new Array<string>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RangeError(`embedding contains a non-finite value at index ${index}`);
    }
    parts[index] = String(value);
  }
  return `[${parts.join(',')}]`;
}

/** Whether a value is a usable embedding of the expected width. */
export function isValidEmbedding(
  value: unknown,
  dimensions: number = EMBEDDING_DIMENSIONS,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}
