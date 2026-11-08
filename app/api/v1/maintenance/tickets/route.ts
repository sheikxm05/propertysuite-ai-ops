/**
 * `GET /api/v1/maintenance/tickets` — role-filtered, cursor-paginated list.
 * `POST /api/v1/maintenance/tickets` — tenant- or staff-created ticket.
 *
 * Both go through `withApiHandler` (§5.2), which supplies authentication, the coarse
 * role gate, Zod validation, rate limiting, the audit row and the frozen error
 * envelope. Nothing in this file hand-rolls any of those.
 *
 * The handlers are thin on purpose. Every decision — which rows this role may see,
 * which columns they may write, which transitions they may drive — lives in
 * `features/maintenance/domain`, so it can be proven by a pure unit test rather than by
 * an HTTP round trip. A route that made its own authorization decision would be a
 * decision with no test behind it.
 *
 * ON THE LIST ENVELOPE: `{ data, page_info }` from `listResponseSchema` in
 * `packages/shared`, emitted by `paginated()` (§5.7 amendment A18, which resolved the
 * disagreement this route previously worked around by writing the body itself).
 *
 * `TicketListResponseSchema` is passed as the schema, so the body that ships is the
 * PARSED one and no undeclared column can reach a client. One precision worth recording,
 * because it differs from A18's general description: `TicketSchema` is `.strict()`, not a
 * plain `z.object()`, so an undeclared key is REJECTED rather than stripped —
 * `paginated()` raises `INTERNAL_ERROR` and a 500 ships instead of a quietly sanitised
 * body. Either way nothing undeclared leaves the process, which is the property that
 * matters; the strict variant just fails loudly, which is the better default for a
 * contract this lane already satisfies by construction (`toTicket` builds the declared
 * fields and nothing else).
 *
 * It earns its keep as the third guard, not the first. The §4 matrix limits a
 * `service_provider` to a tenant's NAME, and row-level security cannot hide a column, so
 * the chain is: explicit projections in the repository, narrow mappers in `view.ts`, and
 * this contract — the only one of the three that still holds if someone later widens a
 * `select`.
 */

import {
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TICKET_CREATE_ROLES,
  TicketListResponseSchema,
  type CreateTicketInput,
  type ListTicketsQuery,
} from '@shared/index';

import { created, paginated } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import {
  asPageInfoInput,
  availableTransitions,
  createTicket,
  listTicketPage,
  maintenanceContextFrom,
  toTicket,
} from '@/features/maintenance/domain';

/**
 * Any active member may call this; what they get back differs by role.
 *
 * No `roles` gate, because every role has a legitimate view: staff see the
 * organization, an owner sees their properties, a tenant sees their own reports, a
 * provider sees assigned work only. The narrowing is `ticketListScope()` plus RLS, not
 * a 403 — an empty page discloses nothing, a 403 would disclose that the collection
 * exists for other people.
 */
export const GET = withApiHandler<undefined, ListTicketsQuery>(
  { querySchema: ListTicketsQuerySchema },
  async (ctx) => {
    const page = await listTicketPage(maintenanceContextFrom(ctx), ctx.query);
    return paginated(page.items.map(toTicket), asPageInfoInput(page.pageInfo), ctx.requestId, {
      schema: TicketListResponseSchema,
    });
  },
);

/**
 * `TICKET_CREATE_ROLES` from `packages/shared` is the gate: organization admin,
 * property manager, tenant. A `service_provider` and a `property_owner` cannot report
 * work, which `authorize()` also denies on the `maintenance_ticket` `create` cell — the
 * coarse gate here just stops the request before the body is even parsed.
 *
 * 201 with a `Location` header. The response carries `available_transitions` so the
 * client can render the next legal action without a second round trip, computed from the
 * same rule set the server enforces.
 */
export const POST = withApiHandler<CreateTicketInput, undefined>(
  {
    roles: TICKET_CREATE_ROLES,
    bodySchema: CreateTicketSchema,
    audit: { action: 'ticket_created', entityType: 'ticket' },
  },
  async (ctx) => {
    const context = maintenanceContextFrom(ctx);
    const { ticket } = await createTicket(context, ctx.body);

    ctx.audit({
      entityId: ticket.id,
      metadata: {
        property_id: ticket.property_id,
        unit_id: ticket.property_unit_id,
        tenant_id: ticket.tenant_id,
        priority: ticket.priority,
        category: ticket.category,
        status: ticket.status,
      },
    });

    return created(
      {
        ...toTicket(ticket),
        available_transitions: [...availableTransitions(ticket, ctx.membership)],
      },
      ctx.requestId,
      { location: `/api/v1/maintenance/tickets/${ticket.id}` },
    );
  },
);
