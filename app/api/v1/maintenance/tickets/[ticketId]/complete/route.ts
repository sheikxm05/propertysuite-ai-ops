/**
 * `POST /api/v1/maintenance/tickets/{ticketId}/complete` — the `awaiting_approval ->
 * completed` close.
 *
 * Who may call it is read from `TRANSITION_ROLES.awaiting_approval.completed`: an
 * organization admin, a property manager, or the reporting tenant. A
 * `service_provider` is absent, and that is the whole point of having a separate
 * `awaiting_approval` state — a provider cannot approve its own work.
 *
 * The role gate here is coarse; the ownership binding is not. A tenant calling this must
 * be THE reporting tenant of THIS ticket, which `assertTicketTransition` checks against
 * the row, `maintenance_tickets_update_tenant_confirm` checks in RLS, and
 * `enforce_ticket_transition()` checks a third time in the trigger.
 *
 * `confirmed: true` is a `z.literal` in `CompleteTicketSchema`, so this endpoint cannot
 * fire on an empty body, a default-valued body or a truthy-but-not-true value.
 * `completed` is terminal and there is no reopen edge, so the close must be an explicit
 * act by an authenticated human — which is also what keeps this route unreachable from
 * model output.
 */

import { CompleteTicketSchema, type CompleteTicketInput } from '@shared/index';

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import {
  TICKET_COMPLETE_ROLES,
  completeTicket,
  maintenanceContextFrom,
  ticketIdFrom,
  toTicket,
} from '@/features/maintenance/domain';

export const POST = withApiHandler<CompleteTicketInput, undefined>(
  {
    roles: TICKET_COMPLETE_ROLES,
    bodySchema: CompleteTicketSchema,
    audit: { action: 'ticket_completed', entityType: 'ticket' },
  },
  async (ctx) => {
    const ticketId = ticketIdFrom(ctx.params);
    const { ticket } = await completeTicket(maintenanceContextFrom(ctx), ticketId, ctx.body);

    ctx.audit({
      entityId: ticket.id,
      metadata: {
        from_status: 'awaiting_approval',
        to_status: ticket.status,
        // Identifier count only. The resolution summary is domain text and belongs in
        // the immutable timeline, not duplicated into the audit log (CLAUDE.md rule 8).
        count: ctx.body.evidence_document_ids?.length ?? 0,
      },
    });

    // `available_transitions` is deliberately empty here: `completed` is terminal, and
    // the client should render no further action. Computed, not asserted.
    return ok({ ...toTicket(ticket), available_transitions: [] }, ctx.requestId);
  },
);
