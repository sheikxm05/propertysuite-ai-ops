/**
 * `GET /api/v1/maintenance/tickets/{ticketId}`   — detail with timeline.
 * `PATCH /api/v1/maintenance/tickets/{ticketId}` — fields and/or one transition.
 *
 * The 404 on both is load-bearing. A ticket the caller may not see is read through their
 * own RLS-scoped client, returns no row, and becomes `NOT_FOUND` — never `FORBIDDEN`.
 * Answering 403 would confirm the ticket exists, which for a provider probing ticket ids
 * is exactly the disclosure acceptance criterion 7 forbids.
 *
 * PATCH carries both the content fields and the status transition, because that is the
 * shape `UpdateTicketSchema` froze. The two are checked separately and in a fixed order:
 * the transition (409 for an edge that does not exist, 403 for an edge this role or this
 * row denies) before the field allowlist, so a provider attempting
 * `completed -> open` learns only that they may not touch the ticket.
 */

import { UpdateTicketSchema, type UpdateTicketInput } from '@shared/index';

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import {
  TICKET_TRANSITION_ROLES,
  availableTransitions,
  getTicketDetail,
  maintenanceContextFrom,
  patchTicket,
  ticketIdFrom,
  toTicket,
} from '@/features/maintenance/domain';

/** No role gate: the matrix cell is evaluated against the row, which the wrapper cannot read. */
export const GET = withApiHandler({}, async (ctx) => {
  const detail = await getTicketDetail(maintenanceContextFrom(ctx), ticketIdFrom(ctx.params));
  return ok(detail, ctx.requestId);
});

/**
 * The roles with any write path to a ticket: staff, the reporting tenant, the assigned
 * provider. `property_owner` is absent — read-only in the §4 matrix — so an owner is
 * refused before a body is parsed rather than after.
 *
 * Which of the three may write WHAT is `writableTicketFields()`, and which transitions
 * they may drive is `canTransition()`. Both are in the domain layer, and both are
 * enforced again by RLS and by `0003`'s trigger.
 */
export const PATCH = withApiHandler<UpdateTicketInput, undefined>(
  {
    roles: TICKET_TRANSITION_ROLES,
    bodySchema: UpdateTicketSchema,
    audit: { action: 'ticket_updated', entityType: 'ticket' },
  },
  async (ctx) => {
    const ticketId = ticketIdFrom(ctx.params);
    const { ticket, activities } = await patchTicket(
      maintenanceContextFrom(ctx),
      ticketId,
      ctx.body,
    );

    ctx.audit({
      entityId: ticket.id,
      metadata: {
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        // How many timeline rows this request appended. One per transition, plus at
        // most one priority row — enough to spot a double-write in the audit trail
        // without copying the timeline into it.
        count: activities.length,
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
