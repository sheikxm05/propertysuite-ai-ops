/**
 * `POST /api/v1/ai/maintenance/confirm` — the human confirmation that creates the ticket.
 *
 * This is the gate CLAUDE.md rule 7 is about, so it is worth being explicit about what
 * makes it one rather than a rubber stamp.
 *
 *  - **It cannot be reached by model output.** Nothing in `services/ai/**` calls it. It
 *    is an HTTP endpoint invoked by an authenticated browser session, and
 *    `ConfirmTicketSchema` requires `confirmed: true` as a Zod *literal*, so an absent,
 *    `false` or merely truthy value is a 400. A replayed or default-valued body is not a
 *    decision.
 *  - **The draft is re-validated, and then not trusted.** `ClassificationSchema` runs
 *    again on arrival, but passing it only means the payload is well formed. Every
 *    security-relevant value is re-derived server-side:
 *      · the unit, from the caller's own active tenancies (`resolveUnitContext`), never
 *        from the echoed `property_unit_id` alone;
 *      · the property, read from the unit row, so the
 *        `(property_id, property_unit_id)` pair is consistent — an inconsistent pair is
 *        rejected by RLS and by a composite foreign key, and §5.9a records what happens
 *        when this INSERT path is improvised around;
 *      · the priority, by re-running `resolvePriority()` against trusted facts. A
 *        tampered `suggested_priority` is still capped below `urgent`.
 *    What a tampered draft *can* change is the ticket's wording — which the confirming
 *    human is looking at, and is responsible for. That is the correct division.
 *  - **It refuses to create a ticket from a draft that asked for clarification.** A
 *    draft whose `requires_clarification` is true has an unanswered question in it;
 *    committing it would mean committing a ticket nobody could act on.
 *  - **It does not write `maintenance_tickets` itself.** Creation goes through w1-l4's
 *    domain service via `services/ai/maintenance/ticket-creation.ts`, with the caller's
 *    own credentials, so the state machine, the activity row and the audit row are the
 *    ones the manual path produces.
 *
 * `withPrivilegedApiHandler` is used for one thing: appending the `system` turn that
 * records the confirmation. `0002` restricts client inserts on `ai_messages` to
 * `sender_type = 'user'`.
 */

import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { ApiRouteError } from '@/lib/api/errors';
import { created } from '@/lib/api/responses';
import {
  ConfirmTicketResponseSchema,
  ConfirmTicketSchema,
  type ConfirmTicketInput,
} from '@shared/index';
import {
  decidePriority,
  getTicketCreationService,
  recordServerTurn,
  resolveUnitContext,
} from '@/services/ai';

/**
 * Confirmation is not a model call, but it lives under `/api/v1/ai/*` and so is capped at
 * the AI ceiling by `applyAiCeiling` regardless. Declared explicitly to say so.
 */
const CONFIRM_RATE_LIMIT = { key: 'ai:maintenance:confirm', perMinute: 10 } as const;

export const POST = withPrivilegedApiHandler<ConfirmTicketInput>(
  {
    // §4: `maintenance_tickets` is `CR own` for a tenant. The AI intake path is the
    // tenant's path; staff create tickets through `/api/v1/maintenance/tickets` directly.
    roles: ['tenant'],
    bodySchema: ConfirmTicketSchema,
    rateLimit: CONFIRM_RATE_LIMIT,
    audit: { action: 'ai_ticket_confirmed', entityType: 'maintenance_ticket' },
  },
  async (ctx) => {
    const { body, membership, supabase, logger } = ctx;
    const organizationId = membership.organization.id;

    /* 1. Re-derive authorization. The echoed unit id is a filter, never a grant. */
    const unit = await resolveUnitContext(supabase, membership, body.property_unit_id);
    if (unit.resolution !== 'resolved' || unit.unitId !== body.property_unit_id) {
      // `resolveUnitContext` already throws 404 for a unit the caller does not lease.
      // Reaching here means the two disagreed, which is a defect, so it fails closed.
      throw new ApiRouteError('FORBIDDEN', {
        logFields: { reason: 'confirm_unit_resolution_mismatch' },
      });
    }

    /* 2. A draft that asked a question is not a decision. */
    if (body.classification.requires_clarification) {
      throw new ApiRouteError('UNPROCESSABLE', {
        message: 'Answer the clarification question before submitting this report.',
        logFields: { reason: 'confirm_draft_requires_clarification', unit_id: unit.unitId },
      });
    }

    /* 3. Priority is re-decided here. The body's opinion is not an input. */
    const priority = await decidePriority(supabase, {
      organizationId,
      category: body.classification.category,
      unit,
      suggestedPriority: body.classification.suggested_priority,
    });

    /* 4. Creation, through the maintenance domain service. */
    const service = getTicketCreationService();
    const ticket = await service.createTicket(
      {
        property_unit_id: unit.unitId,
        title: body.title,
        description: body.description,
        category: body.classification.category,
        priority: priority.priority,
        source: 'web',
      },
      {
        requestId: ctx.requestId,
        cookieHeader: ctx.request.headers.get('cookie'),
        authorizationHeader: ctx.request.headers.get('authorization'),
      },
    );

    logger.info('ai draft confirmed into ticket', {
      ticket_id: ticket.id,
      unit_id: unit.unitId,
      property_id: unit.propertyId,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      provider: service.id,
      outcome: 'created',
    });

    /*
     * 5. Transcript note, after the fact and best effort.
     *
     * The ticket exists by now. Failing the response because the evidence note could not
     * be appended would tell the client to retry a creation that succeeded, which is a
     * worse outcome than a gap in the transcript — and the gap is logged.
     */
    if (body.conversation_id) {
      await recordServerTurn(
        ctx.serviceRole,
        {
          organizationId,
          conversationId: body.conversation_id,
          senderType: 'system',
          content: `Confirmed by the tenant and created as ticket ${ticket.id}.`,
          metadata: {
            event: 'ai_ticket_confirmed',
            ticket_id: ticket.id,
            category: ticket.category,
            resolved_priority: priority.priority,
            suggested_priority: priority.suggestedPriority,
            suggestion_capped: priority.suggestionCapped,
            priority_reasons: [...priority.reasons],
          },
        },
        logger,
      );
    }

    ctx.audit({
      entityId: ticket.id,
      metadata: {
        unit_id: unit.unitId,
        property_id: unit.propertyId,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        provider: service.id,
      },
    });

    const payload = ConfirmTicketResponseSchema.parse({ data: ticket });
    return created(payload.data, ctx.requestId, {
      location: `/api/v1/maintenance/tickets/${ticket.id}`,
    });
  },
);
