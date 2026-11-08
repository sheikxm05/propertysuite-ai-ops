/**
 * `POST /api/v1/ai/maintenance/classify` — draft a maintenance classification.
 *
 * THIS ROUTE CREATES NOTHING. There is no `maintenance_tickets` write in this file, no
 * import that could reach one, and the response carries `created: false` as a schema
 * literal (`ClassifyResponseSchema`) so a test can assert it rather than trust a comment.
 * The only rows it writes are conversation evidence in `ai_conversations` / `ai_messages`,
 * which cause nothing to happen.
 *
 * Order of operations, and why:
 *
 *   1. Resolve the unit **from the session**. Before the model is involved at all, so a
 *      classification is never produced for a unit the caller cannot reach.
 *   2. Open or authorize the conversation, and append the caller's own turn as the
 *      caller. The record of what was sent exists before the model is called.
 *   3. Call the adapter. Untrusted text goes in fenced, in the user role, and the reply
 *      is validated against `ClassificationSchema` or the call throws.
 *   4. Overlay the server's clarification knowledge, and run `resolvePriority()`. The
 *      model's `suggested_priority` is reported separately from the resolved one so the
 *      human confirming can see that they differ.
 *   5. Append the assistant turn with the service-role client — `0002` restricts client
 *      inserts to `sender_type = 'user'`, deliberately, because a forged assistant turn
 *      is a prompt-injection vector for any later request that replays it. (Nothing in
 *      this lane replays a stored turn, which closes that off a second way.)
 *
 * `withPrivilegedApiHandler` is used for step 5 and step 5 only. The caller-scoped
 * `ctx.supabase` does every read and every client-legal write.
 */

import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { ok } from '@/lib/api/responses';
import {
  ClassifyRequestSchema,
  ClassifyResponseSchema,
  type ClassifyRequestInput,
} from '@shared/index';
import {
  applyUnitClarification,
  decidePriority,
  ensureConversation,
  getAiProvider,
  recordServerTurn,
  recordUserTurn,
  resolveUnitContext,
  toApiRouteError,
  type ClassificationResult,
} from '@/services/ai';

/**
 * Stricter than the `/api/v1/ai/*` ceiling of 10/min, not looser.
 *
 * `applyAiCeiling` would cap a larger number anyway; six is chosen because each call is a
 * paid model request and a tenant reporting six distinct problems in one minute is
 * already an unusual day.
 */
const CLASSIFY_RATE_LIMIT = { key: 'ai:maintenance:classify', perMinute: 6 } as const;

export const POST = withPrivilegedApiHandler<ClassifyRequestInput>(
  {
    // §4's matrix grants `ai_conversations` create to `tenant` alone, so the coarse gate
    // matches the policy rather than inviting a 403 from Postgres later.
    roles: ['tenant'],
    bodySchema: ClassifyRequestSchema,
    rateLimit: CLASSIFY_RATE_LIMIT,
    audit: { action: 'ai_classification_drafted', entityType: 'ai_conversation' },
  },
  async (ctx) => {
    const { body, membership, supabase, logger } = ctx;
    const organizationId = membership.organization.id;

    /* 1. Authorization first. A unit the caller cannot reach gets no classification. */
    const unit = await resolveUnitContext(supabase, membership, body.property_unit_id);

    /* 2. Evidence before inference. */
    const conversationId = await ensureConversation(supabase, membership, body.conversation_id);
    await recordUserTurn(supabase, {
      organizationId,
      conversationId,
      content: body.message,
    });

    /* 3. The model call. Validated or thrown — never partially believed. */
    let result: ClassificationResult;
    try {
      result = await getAiProvider().classify(
        {
          untrusted: { tenantMessage: body.message },
          trusted: {
            unitResolution: unit.resolution,
            candidateUnitCount: unit.candidateUnitCount,
            hasActiveTenancy: unit.resolution === 'resolved',
          },
        },
        { requestId: ctx.requestId },
      );
    } catch (error) {
      // Token counts, latency and outcome are logged; the message and the reply are not.
      logger.warn('ai classification failed', {
        conversation_id: conversationId,
        unit_id: unit.unitId,
        outcome: 'failed',
      });
      throw toApiRouteError(error);
    }

    /* 4. Server knowledge wins, and priority is decided deterministically. */
    const draft = applyUnitClarification(result.classification, unit);
    const priority = await decidePriority(supabase, {
      organizationId,
      category: draft.category,
      unit,
      suggestedPriority: draft.suggested_priority,
    });

    logger.info('ai classification drafted', {
      conversation_id: conversationId,
      unit_id: unit.unitId,
      property_id: unit.propertyId,
      category: draft.category,
      priority: priority.priority,
      model: result.model,
      provider: result.providerId,
      version: result.promptVersion,
      attempt: result.attempts,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      latency_ms: result.latencyMs,
      outcome: 'drafted',
    });

    /* 5. The assistant turn, service-role only. Best effort: nothing was created. */
    await recordServerTurn(
      ctx.serviceRole,
      {
        organizationId,
        conversationId,
        senderType: 'assistant',
        content: JSON.stringify(draft),
        metadata: {
          prompt_version: result.promptVersion,
          model: result.model,
          provider: result.providerId,
          attempts: result.attempts,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          latency_ms: result.latencyMs,
          resolved_priority: priority.priority,
          suggested_priority: priority.suggestedPriority,
          suggestion_capped: priority.suggestionCapped,
          priority_reasons: [...priority.reasons],
          requires_clarification: draft.requires_clarification,
          created: false,
        },
      },
      logger,
    );

    ctx.audit({
      entityId: conversationId,
      metadata: {
        category: draft.category,
        priority: priority.priority,
        version: result.promptVersion,
        model: result.model,
        unit_id: unit.unitId,
        requires_clarification: draft.requires_clarification,
      },
    });

    // Parsed on the way out as well as on the way in. The response is part of the frozen
    // contract, and `created: false` is a literal in it — this route cannot return a body
    // claiming otherwise even by accident.
    const payload = ClassifyResponseSchema.parse({
      data: {
        draft,
        resolved_priority: priority.priority,
        priority_reasons: [...priority.reasons],
        conversation_id: conversationId,
        property_unit_id: unit.unitId,
        created: false,
      },
    });

    // Exactly the frozen body, with nothing added. The review step's editable title and
    // description are computed on the client from `suggestTitle` / `suggestDescription`
    // in `services/ai/maintenance/draft.ts` — the same code, so the suggestion cannot
    // differ between the two sides, and the response does not grow a field outside §5.
    return ok(payload.data, ctx.requestId);
  },
);
