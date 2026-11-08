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
 * ON THE LIST ENVELOPE: the body is `{ data, page_info }`, which is what
 * `listResponseSchema`/`TicketListResponseSchema` in `packages/shared` define. It is
 * emitted through `jsonResponse` from `lib/api/responses.ts` — the single JSON writer,
 * so the correlation header and `cache-control: no-store` still apply — rather than
 * through that module's `paginated()` helper, which returns a flat `{ data,
 * next_cursor }`. The two Wave 0 deliverables disagree and neither §5.2, §5.7 nor
 * `api-contracts.md` freezes a list envelope. Reported as a planning defect; the shared
 * schema wins here because five lanes import it and a response that does not satisfy
 * `TicketListResponseSchema` would make that schema dead code.
 */

import {
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TICKET_CREATE_ROLES,
  type CreateTicketInput,
  type ListTicketsQuery,
} from '@shared/index';

import { created, jsonResponse } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import {
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
    return jsonResponse(
      { data: page.items.map(toTicket), page_info: page.pageInfo },
      ctx.requestId,
    );
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
