/**
 * `POST /api/v1/maintenance/tickets/{ticketId}/assign` — manager triage.
 *
 * Assignment is a route rather than a field on PATCH because it is three decisions at
 * once, each with its own failure mode:
 *
 *   the transition  `open -> assigned`, admin or manager only            403 / 409
 *   the provider    must exist, be active, and be in THIS organization   422
 *   the priority    re-decided by `resolvePriority()`, never requested   —
 *
 * `AssignTicketSchema` has no `priority` field, and that absence is the design: the
 * deterministic policy owns the final priority, so neither a manager's haste nor a
 * model's suggestion can set `urgent` without a trusted escalation signal.
 *
 * The role gate is read from `TRANSITION_ROLES.open.assigned` in `packages/shared`
 * rather than written out, so the coarse gate on this route and the state machine can
 * never disagree about who may assign.
 */

import { AssignTicketSchema, type AssignTicketInput } from '@shared/index';

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import {
  TICKET_ASSIGN_ROLES,
  assignTicket,
  availableTransitions,
  maintenanceContextFrom,
  ticketIdFrom,
  toTicket,
} from '@/features/maintenance/domain';

export const POST = withApiHandler<AssignTicketInput, undefined>(
  {
    roles: TICKET_ASSIGN_ROLES,
    bodySchema: AssignTicketSchema,
    audit: { action: 'ticket_assigned', entityType: 'ticket' },
  },
  async (ctx) => {
    const ticketId = ticketIdFrom(ctx.params);
    const { ticket } = await assignTicket(maintenanceContextFrom(ctx), ticketId, ctx.body);

    ctx.audit({
      entityId: ticket.id,
      metadata: {
        provider_id: ticket.assigned_provider_id,
        from_status: 'open',
        to_status: ticket.status,
        priority: ticket.priority,
      },
    });

    return ok(
      {
        ...toTicket(ticket),
        available_transitions: [...availableTransitions(ticket, ctx.membership)],
      },
      ctx.requestId,
    );
  },
);
