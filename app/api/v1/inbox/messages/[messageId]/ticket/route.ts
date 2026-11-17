/**
 * `POST /api/v1/inbox/messages/{messageId}/ticket` — the human confirmation.
 *
 * This is the gate CLAUDE.md rule 7 is about: the only route in this lane where
 * something a model drafted can end up in a row, and a person has to put it there.
 *
 *  - **It cannot be reached by model output.** Nothing under `services/ai/**` calls it.
 *    It is an HTTP endpoint invoked by an authenticated browser session, and
 *    `CommitTicketSchema` requires `confirmed: true` as a Zod literal, so an absent,
 *    false or merely truthy value is a 400. A replayed or default-valued body is not a
 *    decision.
 *  - **The draft is not trusted.** The body carries a title, a description, a category
 *    and a unit — the operator's words, which they are responsible for. Everything
 *    security-relevant is re-derived: the unit is re-read in the caller's own
 *    organization, and `property_id` and `tenant_id` are derived by the maintenance
 *    domain from the unit, not echoed from here.
 *  - **It does not write `maintenance_tickets` itself.** Creation goes through the
 *    frozen `POST /api/v1/maintenance/tickets` contract via
 *    `getTicketCreationService()`, forwarding the caller's own credentials. The real
 *    handler runs: its authorization, its state machine, its activity row, its audit
 *    row. Two implementations of a state machine entry point is two sets of rules.
 *  - **`source` is `whatsapp`, and that is not cosmetic.** The column exists to say how
 *    a ticket actually arrived. A ticket raised from an inbound message did not arrive
 *    through the web form, and claiming otherwise would make the column useless for
 *    provenance — which is the one question anyone asks of a ticket the AI touched.
 *
 * The message is linked to the ticket only after the ticket exists, so the link can
 * never point at a ticket that does not.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { created } from '@/lib/api/responses';
import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { UuidSchema } from '@shared/index';
import { getTicketCreationService } from '@/services/ai';
import {
  CommitTicketSchema,
  inboxContextFrom,
  linkMessageToTicket,
  mayCommitTicket,
  readMessage,
  type CommitTicketInput,
} from '@/features/inbox/domain';

const COMMIT_RATE_LIMIT = { key: 'inbox:commit-ticket', perMinute: 10 } as const;

export const POST = withPrivilegedApiHandler<CommitTicketInput>(
  {
    bodySchema: CommitTicketSchema,
    rateLimit: COMMIT_RATE_LIMIT,
    audit: { action: 'inbound_message_committed', entityType: 'maintenance_ticket' },
  },
  async (ctx) => {
    const { body, membership, logger } = ctx;

    /* 1. Only an operator commits on somebody else's behalf. */
    if (!mayCommitTicket(membership.role)) {
      throw new ApiRouteError('FORBIDDEN', {
        logFields: { reason: 'role_cannot_commit_inbound', role: membership.role },
      });
    }

    const messageId = UuidSchema.safeParse(ctx.params.messageId);
    if (!messageId.success) {
      throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'message_id_not_a_uuid' } });
    }

    const context = inboxContextFrom(ctx);
    const message = await readMessage(context, messageId.data);
    if (!message) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'inbound_message_not_visible' },
      });
    }

    /* 2. One message, one ticket. A second commit is a conflict, not a second ticket. */
    if (message.ticket_id) {
      throw new ApiRouteError('CONFLICT', {
        message: 'This message has already been turned into a ticket.',
        logFields: { reason: 'inbound_message_already_committed' },
      });
    }

    /* 3. Re-authorize the unit. The body's id is a filter, never a grant. */
    const { data: unit, error } = await ctx.supabase
      .from('property_units')
      .select('id, organization_id')
      .eq('id', body.property_unit_id)
      .eq('organization_id', membership.organization.id)
      .maybeSingle();

    if (error) {
      throw new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'unit_read_failed' } });
    }
    if (!unit) {
      // Absent and inaccessible are the same answer, for the same reason they are in the
      // frozen envelope: a 403 here would confirm that the unit exists somewhere else.
      throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'unit_not_in_organization' } });
    }

    /* 4. Creation, through the maintenance domain's own frozen contract. */
    const service = getTicketCreationService();
    const ticket = await service.createTicket(
      {
        property_unit_id: unit.id,
        title: body.title,
        description: body.description,
        category: body.category,
        ...(body.priority ? { priority: body.priority } : {}),
        source: 'whatsapp',
      },
      {
        requestId: ctx.requestId,
        cookieHeader: ctx.request.headers.get('cookie'),
        authorizationHeader: ctx.request.headers.get('authorization'),
      },
    );

    /* 5. The link, after the fact. */
    if (!ctx.serviceRole) {
      // The ticket exists; only the back-link could not be written. Reported rather than
      // swallowed, because a committed message that still reads `received` would invite a
      // second ticket for the same complaint.
      throw new ApiRouteError('INTERNAL_ERROR', {
        logFields: { reason: 'service_role_unavailable_for_link', ticket_id: ticket.id },
      });
    }
    await linkMessageToTicket(context, ctx.serviceRole, message.id, ticket.id);

    logger.info('inbound message committed into a ticket', {
      message_id: message.id,
      ticket_id: ticket.id,
      unit_id: unit.id,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      provider: service.id,
      outcome: 'created',
    });

    ctx.audit({
      entityId: ticket.id,
      metadata: {
        message_id: message.id,
        unit_id: unit.id,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        source: 'whatsapp',
      },
    });

    return created(ticket, ctx.requestId, {
      location: `/api/v1/maintenance/tickets/${ticket.id}`,
    });
  },
);
