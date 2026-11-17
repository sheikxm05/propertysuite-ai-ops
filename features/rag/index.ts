/**
 * `features/rag` — retrieval-augmented question answering over the caller's documents.
 *
 * Lane w3-l3. This barrel is the contract half: schemas, limits and display helpers that
 * a client component may import. The server half lives under `server/` and is imported
 * only by `app/api/v1/rag/ask/route.ts`, which is the composition root that supplies the
 * credentialed adapters.
 *
 * Nothing re-exported here touches a secret, a network client or a Supabase client, so
 * importing this barrel from a client component is safe by construction rather than by
 * convention.
 */

export {
  AskRequestSchema,
  AskResponseSchema,
  RagAnswerSchema,
  RagCitationSchema,
  RAG_MAX_CHUNKS,
  RAG_MAX_CHUNKS_SINGLE_DOCUMENT,
  RAG_MAX_EXCERPT_CHARS,
  RAG_NO_ANSWER_TEXT,
  type AskRequestInput,
  type RagAnswer,
  type RagCitation,
} from './contract';

export {
  RAG_ANSWER_PROMPT,
  RAG_ANSWER_PROMPT_VERSION,
  RAG_ANSWER_SYSTEM,
  RAG_ANSWER_USER_PREAMBLE,
} from './prompt';
