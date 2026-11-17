/**
 * `POST /api/v1/rag/ask` — answer a question from the caller's own documents, with
 * sources.
 *
 * THIS ROUTE CHANGES NOTHING. There is no insert, no update, no privileged client and no
 * import that could reach one: it uses `withApiHandler`, not
 * `withPrivilegedApiHandler`, so `ctx.serviceRole` is `undefined` and the only database
 * access available to it is the caller's own RLS-bound client. Consequently there is no
 * `audit` option either — the audit contract is one row per state change, and a read
 * that changed nothing would be a false record. What the request leaves behind is the
 * structured log line below.
 *
 * The isolation story, in the order it happens:
 *
 *   1. `withApiHandler` authenticates, then resolves membership from trusted rows.
 *   2. `AskRequestSchema` validates the body — and has no `organization_id` field, so a
 *      client cannot name an organization even to be ignored (CLAUDE.md rule 5).
 *   3. The rate limiter spends a token from the caller's **AI** bucket, so a question
 *      here and a classification on `/api/v1/ai/*` draw on the same budget.
 *   4. `askDocuments` embeds the question, calls `search_document_chunks` with
 *      `membership.organization.id`, and re-checks every cited document through the
 *      caller's own client before a citation is built.
 *   5. The response is validated against `AskResponseSchema` before it ships.
 *
 * WHY THERE IS NO `roles` GATE
 * `options.roles` is a coarse filter over the whole route, and every role in this product
 * has a legitimate, non-empty document set: a manager sees the organization's, a tenant
 * sees their own tenancy's, a provider sees the completion evidence on tickets assigned
 * to them (amendment A7). Listing roles here would either be the full list — which is
 * the same as omitting it, with the added risk of drifting out of date — or an
 * authorization decision taken in the wrong place. The decision that matters is per
 * document, it is taken in the retrieval function's visibility predicate and again by
 * RLS on the `documents` re-read, and a role with nothing to retrieve gets zero chunks
 * and the "could not find it" answer. Which is what a correct boundary looks like from
 * the inside.
 *
 * Nothing logged below carries the question, a chunk or the answer (CLAUDE.md rule 8) —
 * only counts, ids, model metadata and durations.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { AskRequestSchema, AskResponseSchema, type AskRequestInput } from '@/features/rag';
import { askDocuments } from '@/features/rag/server/ask-service';
import { toApiRouteError } from '@/services/ai';
// Deep import rather than the `@/services/rag` barrel, deliberately: the barrel also
// re-exports `chunk-store`, which holds a service-role client. A read-only route has no
// business pulling an RLS-bypassing module into its graph just to reach an HTTP client
// next to it. `services/rag/index.ts` blesses the deep import for exactly this reason.
import { createNvidiaEmbeddingClient } from '@/services/rag/embeddings';
import { isRagError } from '@/services/rag/errors';

import { resolveChatModel, resolveChatTransport } from './transport';

/**
 * Stricter than the AI default of 10/min, and sharing its bucket.
 *
 * The key is `'ai'`, which is the same bucket `defaultRuleFor` hands to `/api/v1/ai/*`.
 * That is deliberate: `applyAiCeiling` only caps routes under the `/api/v1/ai` prefix,
 * and this route is not one, so without an explicit declaration it would inherit the
 * **mutation** default of 60/min — six times the AI ceiling, on the most expensive
 * request in the application (an embedding call plus a chat call). Declaring the shared
 * key means a caller cannot dodge their model budget by alternating between the two
 * surfaces, and six per minute is a person asking questions rather than a script.
 */
const ASK_RATE_LIMIT = { key: 'ai', perMinute: 6 } as const;

export const POST = withApiHandler<AskRequestInput>(
  {
    bodySchema: AskRequestSchema,
    rateLimit: ASK_RATE_LIMIT,
  },
  async (ctx) => {
    const { body, membership, supabase, logger, requestId } = ctx;

    let result;
    try {
      result = await askDocuments(supabase, membership, body, {
        // `EmbeddingClient` satisfies the lane's `QueryEmbedder` port structurally, so
        // there is no adapter here — and the port exposes only `embedQuery`, which is
        // how the asymmetric-model mistake is made unavailable rather than merely
        // discouraged. One request per question; the batching and backoff in this client
        // are for the ingestion path and cost nothing here.
        embedder: createNvidiaEmbeddingClient(),
        transport: resolveChatTransport(),
        model: resolveChatModel(),
        signal: ctx.request.signal,
      });
    } catch (error) {
      logger.warn('rag answer failed', {
        scoped: body.document_id !== undefined,
        outcome: 'failed',
      });
      throw toRouteError(error);
    }

    const { answer, telemetry } = result;

    logger.info('rag answer composed', {
      document_id: body.document_id ?? null,
      scoped: telemetry.scoped,
      matched: telemetry.matched,
      retrieved: telemetry.retrieved,
      withheld: telemetry.withheld,
      cited: telemetry.cited,
      answered: telemetry.answered,
      embedding_model: telemetry.embeddingModel,
      embed_ms: telemetry.embedMs,
      version: telemetry.promptVersion,
      model: telemetry.model,
      attempt: telemetry.attempts,
      tokens_in: telemetry.tokensIn,
      tokens_out: telemetry.tokensOut,
      latency_ms: telemetry.answerMs,
      outcome: telemetry.answered ? 'answered' : 'no_answer',
    });

    // Non-zero means the definer function returned a chunk whose document the caller's
    // own policies refuse. The answer is already correct — the chunk was dropped — but
    // this is the signature of a policy regression and nothing else would record it.
    if (telemetry.withheld > 0) {
      logger.warn('retrieved chunks withheld by the caller-scoped visibility check', {
        withheld: telemetry.withheld,
        matched: telemetry.matched,
        reason: 'chunk_document_not_visible_to_caller',
      });
    }

    // A document that contains fence-marker-shaped text is not proof of an attack, but
    // it is not an accident either. Counted, never quoted.
    if (telemetry.neutralisedMarkers > 0) {
      logger.warn('fence markers neutralised in retrieved document text', {
        count: telemetry.neutralisedMarkers,
        reason: 'untrusted_content_contained_fence_markers',
      });
    }

    return ok(answer, requestId, { schema: AskResponseSchema });
  },
);

/**
 * Maps a failure from any of the three layers onto the frozen envelope.
 *
 * Three vocabularies meet at this route and each needs its own clause:
 *
 *  - `ApiRouteError` — already the envelope. Thrown by retrieval and by the response
 *    schema gate. Passed through untouched, or its code would be flattened to a 500.
 *  - `RagError` — the embedding layer's vocabulary (`services/rag/errors.ts`). It is
 *    not an `AiError`, so `toApiRouteError` would classify it as an unexpected failure
 *    and discard its `logFields`, which are the only record of *why* the embedding call
 *    failed. Carried across explicitly.
 *  - `AiError` — the chat layer's vocabulary. `toApiRouteError` already knows it.
 *
 * Every `RagError` becomes `INTERNAL_ERROR`, including the retryable ones. That is not
 * laziness: the frozen eight codes (§5.2) have no "service unavailable", and reporting
 * an upstream 429 as our own `RATE_LIMITED` would tell the caller to slow down when the
 * caller has done nothing wrong and their own bucket is untouched. The distinguishing
 * detail goes to the log, joined to the response by `request_id` — the same choice
 * `AiProviderError` already makes.
 */
function toRouteError(error: unknown): ApiRouteError {
  if (error instanceof ApiRouteError) return error;
  if (isRagError(error)) {
    return new ApiRouteError('INTERNAL_ERROR', {
      logFields: { ...error.logFields, kind: error.kind, retryable: error.retryable },
      cause: error,
    });
  }
  return toApiRouteError(error);
}
