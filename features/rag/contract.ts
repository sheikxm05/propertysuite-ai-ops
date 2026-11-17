/**
 * The `/api/v1/rag/ask` request and response contract.
 *
 * `packages/shared` does not carry a retrieval contract — §5.4 froze its surface before
 * wave 3 existed and no feature lane may add to it (CLAUDE.md rule 4). So the ask
 * contract lives here, in the lane that owns the route, and is **built out of** the
 * shared primitives rather than restating them: `UuidSchema`, `boundedText` and
 * `resourceResponseSchema` all come from `@shared/index`. Nothing below is a local copy
 * of a shared type.
 *
 * The one shape in this file worth reading twice is `RagCitationSchema`.
 *
 * A citation is not decoration and it is not model output. Every field of it is a
 * server-side fact: `document_id` and `chunk_index` come from the row
 * `search_document_chunks` returned, `document_type` comes from a second, RLS-scoped
 * read of the `documents` table, and `excerpt` is the stored chunk text, truncated.
 * The model's only contribution to a citation is *which of the retrieved sources it
 * used* — an integer index into a list the server built. It never emits an identifier,
 * so it cannot invent one, cannot point at a document the caller may not read, and
 * cannot smuggle a crafted uuid out of a hostile PDF.
 *
 * That is why the answer is safe to show with sources attached: the prose is a model
 * draft, but every link under it is the application's own record.
 */

import { z } from 'zod';

import { UuidSchema, boundedText, resourceResponseSchema } from '@shared/index';

/* ------------------------------------------------------------------ limits -- */

/**
 * Chunks retrieved per question.
 *
 * Six is a retrieval budget, not a display budget. Fewer than about four and a question
 * whose answer straddles two clauses of a contract loses half its evidence; many more
 * and the fenced user turn grows faster than the answer improves, while every extra
 * chunk is another block of hostile text in the context window for no gain.
 */
export const RAG_MAX_CHUNKS = 6;

/** Hard ceiling on `document_id`-filtered retrieval. Same reasoning, one document. */
export const RAG_MAX_CHUNKS_SINGLE_DOCUMENT = 8;

/**
 * Longest excerpt shipped per citation.
 *
 * The excerpt exists so a reader can check the answer against the source without opening
 * the PDF. It is stored chunk text — the same untrusted bytes the model saw — so the UI
 * renders it as plain text inside a labelled source block and never as markup.
 */
export const RAG_MAX_EXCERPT_CHARS = 600;

/**
 * What the endpoint says when retrieval found nothing it could stand behind.
 *
 * A frozen string rather than a model sentence, for the reason the whole lane exists:
 * the one answer that must never be invented is "I could not find this". If the model
 * produced that sentence it could also produce a confident wrong one, and the two would
 * be indistinguishable to the reader. This one is emitted by the application, without a
 * model call in the zero-results case at all.
 */
export const RAG_NO_ANSWER_TEXT =
  'I could not find an answer to that in the documents you have access to. Nothing here is a guess: if a document supporting this exists but has not been uploaded or processed yet, there is nothing for me to cite.';

/* ----------------------------------------------------------------- request -- */

/**
 * `POST /api/v1/rag/ask`.
 *
 * `.strict()`, so an extra key is rejected rather than ignored — and note which key is
 * conspicuously absent: there is no `organization_id`. The caller cannot name an
 * organization because the schema has nowhere to put one; the organization comes from
 * `ctx.membership`, which `resolveMembership()` derived from trusted rows (CLAUDE.md
 * rule 5). A reviewer confirms that by reading this object, not by auditing the route.
 *
 * `document_id` narrows the search to one document. It is still only a *filter*: the
 * retrieval function applies the organization and visibility predicates first, so naming
 * another organization's document id returns zero rows rather than an error — which is
 * also what a correct boundary should look like from the outside.
 */
export const AskRequestSchema = z
  .object({
    question: boundedText(3, 500),
    document_id: UuidSchema.optional(),
  })
  .strict();

export type AskRequestInput = z.infer<typeof AskRequestSchema>;

/* ---------------------------------------------------------------- response -- */

/** One source behind the answer. Every field is server-derived — see the file header. */
export const RagCitationSchema = z
  .object({
    document_id: UuidSchema,
    /**
     * Bounded text rather than `DocumentTypeSchema`.
     *
     * `documents.document_type` is `text` in SQL, not a Postgres enum (the gap §5.9
     * carries), so a row can legitimately hold a value outside `DOCUMENT_TYPES`. A
     * response schema that rejected one would turn a data-quality problem into a 500 and
     * hide the answer. The UI maps known values to labels and falls back to the raw
     * string, exactly as `documentTypeLabel` already does on the documents screens.
     */
    document_type: boundedText(1, 60),
    /** Position of the chunk within its document, zero-based. */
    chunk_index: z.number().int().min(0),
    /** The stored chunk text, truncated to `RAG_MAX_EXCERPT_CHARS`. Untrusted. */
    excerpt: boundedText(1, RAG_MAX_EXCERPT_CHARS),
  })
  .strict();

export type RagCitation = z.infer<typeof RagCitationSchema>;

/**
 * The answer payload.
 *
 * `retrieved` is the number of chunks that survived retrieval **and** the second,
 * RLS-scoped visibility check — not the number the vector search returned. It is in the
 * contract because it is the difference between "no document says this" and "no document
 * was found at all", and a reader who cannot tell those apart will distrust both.
 *
 * The invariant the route enforces: `citations` empty implies `answer` is
 * `RAG_NO_ANSWER_TEXT`. There is no state in which this object carries a substantive
 * claim with nothing behind it.
 */
export const RagAnswerSchema = z
  .object({
    answer: boundedText(1, 4000),
    citations: z.array(RagCitationSchema).max(RAG_MAX_CHUNKS_SINGLE_DOCUMENT),
    retrieved: z.number().int().min(0),
  })
  .strict();

export type RagAnswer = z.infer<typeof RagAnswerSchema>;

/** `{ data: RagAnswer }` — the §5.2 success envelope, built from the shared helper. */
export const AskResponseSchema = resourceResponseSchema(RagAnswerSchema);
