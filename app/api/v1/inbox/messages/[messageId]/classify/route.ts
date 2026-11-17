/**
 * `POST /api/v1/inbox/messages/{messageId}/classify` — draft a classification.
 *
 * THIS ROUTE CREATES NOTHING. There is no ticket write in this file and no import that
 * could reach one: `getAiProvider()` holds no Supabase client, and the response carries
 * `created: false`. The only row it touches is the message's own status chip, moved to
 * `classified`, which means "a draft exists and no human has decided" — amber, per the
 * colour rule in `components/ui/status.ts`.
 *
 * Order of operations, and why each step is where it is:
 *
 *   1. Read the message through the caller's own credentials. A message the caller may
 *      not see produces no draft, and the authorization happens before the model is
 *      involved at all.
 *   2. Resolve the sender against the caller's tenant directory. Same credentials, so
 *      the unit a draft is about is a unit the caller could already have found.
 *   3. Call the adapter. The message goes in through `untrusted.tenantMessage`, which
 *      `services/ai/fence.ts` fences as data in the user role. There is no parameter on
 *      `classify()` through which it could become an instruction — see
 *      `services/ai/providers/types.ts`, which is the file to read for that property.
 *   4. Decide priority deterministically. `decidePriority()` takes the model's
 *      suggestion as one bounded input and can cap it; the suggestion is returned
 *      separately so the human confirming can see that the two differ.
 *
 * The draft is NOT stored. It travels to the browser, is edited by a person, and comes
 * back to `…/ticket` where every security-relevant value is re-derived. Storing it would
 * create a second thing that looks like a decision.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { UuidSchema } from '@shared/index';
import {
  decidePriority,
  getAiProvider,
  suggestDescription,
  suggestTitle,
  toApiRouteError,
  type ClassificationResult,
  type UnitContext,
} from '@/services/ai';
import {
  audienceFor,
  inboxContextFrom,
  markClassified,
  matchSender,
  readMessage,
  senderDirectory,
} from '@/features/inbox/domain';

/** Each call is a paid model request. Six a minute is already a busy operator. */
const CLASSIFY_RATE_LIMIT = { key: 'inbox:classify', perMinute: 6 } as const;

export const POST = withPrivilegedApiHandler(
  {
    rateLimit: CLASSIFY_RATE_LIMIT,
    audit: { action: 'inbound_message_classified', entityType: 'inbound_message' },
  },
  async (ctx) => {
    const { membership, logger } = ctx;

    if (audienceFor(membership.role) === 'none') {
      throw new ApiRouteError('FORBIDDEN', {
        logFields: { reason: 'role_has_no_inbox', role: membership.role },
      });
    }

    const messageId = UuidSchema.safeParse(ctx.params.messageId);
    if (!messageId.success) {
      throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'message_id_not_a_uuid' } });
    }

    /* 1. Authorization first. */
    const context = inboxContextFrom(ctx);
    const row = await readMessage(context, messageId.data);
    if (!row) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'inbound_message_not_visible' },
      });
    }

    /*
     * `body` is nullable in `0004` — an image or a voice note produces no text, and the
     * ingestion path refuses to invent a placeholder that reads like tenant content.
     * There is nothing to classify, and saying so is better than sending an empty string
     * to a paid model call that would fail validation anyway.
     */
    const text = row.body?.trim() ?? '';
    if (text.length === 0) {
      throw new ApiRouteError('UNPROCESSABLE', {
        message: 'This message carries no text, so there is nothing to classify.',
        logFields: { reason: 'inbound_message_has_no_text' },
      });
    }

    /* 2. Who sent it, from rows the caller may read. */
    const directory = await senderDirectory(context);
    const sender = matchSender(row.from_identifier, directory);

    /*
     * The trusted half of the model request. Enums, counts and booleans only — the model
     * is told THAT a unit is known, never which unit, which tenant or which property.
     * `candidateUnitCount` is 1 or 0 here because the directory resolves a tenant to a
     * unit only when they hold exactly one active tenancy.
     */
    const unit: UnitContext = {
      resolution: sender.unitId ? 'resolved' : 'none',
      unitId: sender.unitId,
      propertyId: null,
      tenancyId: null,
      candidateUnitCount: sender.unitId ? 1 : 0,
    };

    /* 3. The model call. Validated or thrown — never partially believed. */
    let result: ClassificationResult;
    try {
      result = await getAiProvider().classify(
        {
          untrusted: { tenantMessage: text },
          trusted: {
            unitResolution: unit.resolution,
            candidateUnitCount: unit.candidateUnitCount,
            hasActiveTenancy: unit.resolution === 'resolved',
          },
        },
        { requestId: ctx.requestId },
      );
    } catch (error) {
      // Outcome only. Neither the message nor the model's reply is logged.
      logger.warn('inbox classification failed', {
        message_id: row.id,
        outcome: 'failed',
      });
      throw toApiRouteError(error);
    }

    /* 4. Priority is policy's decision, not the model's. */
    const priority = await decidePriority(ctx.supabase, {
      organizationId: membership.organization.id,
      category: result.classification.category,
      unit,
      suggestedPriority: result.classification.suggested_priority,
    });

    await markClassified(context, ctx.serviceRole, row.id);

    logger.info('inbox classification drafted', {
      message_id: row.id,
      unit_id: unit.unitId,
      category: result.classification.category,
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

    ctx.audit({
      entityId: row.id,
      metadata: {
        category: result.classification.category,
        priority: priority.priority,
        suggested_priority: priority.suggestedPriority,
        suggestion_capped: priority.suggestionCapped,
        model: result.model,
        version: result.promptVersion,
        unit_id: unit.unitId,
        sender_matched: sender.matched,
      },
    });

    return ok(
      {
        created: false as const,
        draft: result.classification,
        resolved_priority: priority.priority,
        suggested_priority: priority.suggestedPriority,
        suggestion_capped: priority.suggestionCapped,
        priority_reasons: [...priority.reasons],
        suggested_title: suggestTitle(result.classification),
        suggested_description: suggestDescription(result.classification),
        property_unit_id: unit.unitId,
        unit_label: sender.unitLabel,
        tenant_id: sender.tenantId,
        tenant_name: sender.tenantName,
        model: result.model,
        provider: result.providerId,
        prompt_version: result.promptVersion,
      },
      ctx.requestId,
    );
  },
);
