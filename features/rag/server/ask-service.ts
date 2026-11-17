/**
 * `askDocuments` — embed, retrieve, answer. The whole feature in one function.
 *
 * It reads. It never writes: there is no `insert`, no `update`, no `rpc` other than the
 * read-only search, and no import below could reach one. That is this lane's version of
 * CLAUDE.md rule 7 — there is no mutation for model output to reach, so the question of
 * whether a human confirmed it does not arise.
 *
 * The organization comes from `membership`, which `withApiHandler` obtained from
 * `resolveMembership()` against trusted rows. This function has no parameter through
 * which a caller could supply one (rule 5), and `AskRequestSchema` has no field for one
 * either, so there are two independent places a reviewer can confirm it.
 */

import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import {
  RAG_MAX_CHUNKS,
  RAG_MAX_CHUNKS_SINGLE_DOCUMENT,
  RAG_NO_ANSWER_TEXT,
  type AskRequestInput,
  type RagAnswer,
} from '../contract';
import { RAG_ANSWER_PROMPT } from '../prompt';
import { composeAnswer } from './answer';
import { retrieveChunks } from './retrieval';
import type { ModelTransport, QueryEmbedder } from './ports';

export interface AskDependencies {
  readonly embedder: QueryEmbedder;
  readonly transport: ModelTransport;
  /** Resolved chat model id, from `AI_MODEL`. The route reads it; this file does not. */
  readonly model: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Everything the route wants in its log line. Counts, ids, enums and durations only —
 * never the question, never a chunk, never the answer (CLAUDE.md rule 8).
 */
export interface AskTelemetry {
  readonly matched: number;
  readonly retrieved: number;
  readonly withheld: number;
  readonly cited: number;
  readonly answered: boolean;
  readonly scoped: boolean;
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
  readonly embedMs: number;
  readonly promptVersion: string;
  readonly model: string | null;
  readonly attempts: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly answerMs: number;
  /**
   * Marker-shaped substrings the fence neutralised in the retrieved text.
   *
   * Zero on every honest document. A non-zero value means a stored chunk contained
   * something shaped like a fence delimiter, which is what an attempt to break out of
   * the fence looks like from the inside — worth a log line precisely because the
   * attempt failed and nothing else would record it.
   */
  readonly neutralisedMarkers: number;
}

export interface AskResult {
  readonly answer: RagAnswer;
  readonly telemetry: AskTelemetry;
}

/**
 * Answers a question from the caller's own documents.
 *
 * Three steps, and the short-circuit between two and three matters:
 *
 *  1. Embed the question with `input_type: "query"`.
 *  2. Retrieve, organization-scoped, then re-check visibility with the caller's client.
 *  3. **Only if something was retrieved**, ask the model to compose an answer over it.
 *
 * Zero results returns the frozen "could not find it" text without a model call. Not an
 * optimisation: a model given no sources and asked a question about a tenancy will
 * answer it from what it knows about tenancies in general, and that answer will be
 * fluent, uncited, and occasionally right — which is the worst possible combination on a
 * screen people use to check what their contract says.
 */
export async function askDocuments(
  supabase: AppSupabaseClient,
  membership: Membership,
  input: AskRequestInput,
  deps: AskDependencies,
): Promise<AskResult> {
  const scoped = input.document_id !== undefined;
  const limit = scoped ? RAG_MAX_CHUNKS_SINGLE_DOCUMENT : RAG_MAX_CHUNKS;

  /* 1. The question becomes a query vector. Never a passage vector — see `QueryEmbedder`. */
  const embedStartedAt = Date.now();
  const embedding = await deps.embedder.embedQuery(input.question, { signal: deps.signal });
  const embedMs = Date.now() - embedStartedAt;

  /* 2. Retrieval, with the organization taken from trusted rows. */
  const found = await retrieveChunks(supabase, membership, {
    embedding,
    limit,
    documentId: input.document_id,
  });

  const base = {
    matched: found.matched,
    retrieved: found.chunks.length,
    withheld: found.withheld,
    scoped,
    embeddingModel: deps.embedder.model,
    embeddingDimensions: deps.embedder.dimensions,
    embedMs,
    promptVersion: RAG_ANSWER_PROMPT.version,
  } as const;

  if (found.chunks.length === 0) {
    return {
      answer: { answer: RAG_NO_ANSWER_TEXT, citations: [], retrieved: 0 },
      telemetry: {
        ...base,
        cited: 0,
        answered: false,
        model: null,
        attempts: 0,
        tokensIn: null,
        tokensOut: null,
        answerMs: 0,
        neutralisedMarkers: 0,
      },
    };
  }

  /* 3. Compose. The chunks go in fenced; the citations come back from our own rows. */
  const composed = await composeAnswer(
    {
      question: input.question,
      chunks: found.chunks,
      scopedToOneDocument: scoped,
    },
    { transport: deps.transport, model: deps.model, signal: deps.signal },
  );

  return {
    answer: {
      answer: composed.answer,
      citations: [...composed.citations],
      // What survived retrieval and the visibility re-check — not what the model used.
      // A reader who sees "6 extracts searched" under a refusal learns something true
      // that "0 citations" alone would not tell them.
      retrieved: found.chunks.length,
    },
    telemetry: {
      ...base,
      cited: composed.citations.length,
      answered: composed.answered,
      model: composed.model || deps.model,
      attempts: composed.attempts,
      tokensIn: composed.tokensIn,
      tokensOut: composed.tokensOut,
      answerMs: composed.latencyMs,
      neutralisedMarkers: composed.neutralisedMarkers,
    },
  };
}
