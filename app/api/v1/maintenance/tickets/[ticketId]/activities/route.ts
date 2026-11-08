/**
 * `GET  /api/v1/maintenance/tickets/{ticketId}/activities` — the immutable timeline.
 * `POST /api/v1/maintenance/tickets/{ticketId}/activities` — append a note.
 *
 * There is no PATCH and no DELETE here, and there never will be.
 * `maintenance_activities` has UPDATE and DELETE revoked from client roles in `0002`,
 * and `0003`'s trigger rejects UPDATE, DELETE and TRUNCATE for every caller including
 * the table owner — verified live as `postgres`. A mistaken entry is corrected by
 * appending a contradicting one.
 *
 * POST accepts only the client-postable activity types (`comment_added`,
 * `evidence_attached`). The transition types are written by the mutation routes alone,
 * because a client that could POST `status_changed` could manufacture a second
 * transition row and make the timeline lie without ever changing a ticket — and the row
 * could never be removed.
 */

import {
  CreateActivitySchema,
  ListActivitiesQuerySchema,
  type CreateActivityInput,
  type ListActivitiesQuery,
} from '@shared/index';

import { created, jsonResponse } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import {
  TICKET_TRANSITION_ROLES,
  appendActivity,
  listTicketActivities,
  maintenanceContextFrom,
  ticketIdFrom,
  toActivity,
} from '@/features/maintenance/domain';

/**
 * No role gate: every role that can read the ticket can read its history, including a
 * `property_owner`, whose read is scoped by `maintenance_activities_select_owner` and
 * re-checked in application space against `properties.owner_member_id`.
 *
 * `{ data, page_info }` matches `ActivityListResponseSchema` in `packages/shared` — see
 * the envelope note in `../../route.ts`.
 */
export const GET = withApiHandler<undefined, ListActivitiesQuery>(
  { querySchema: ListActivitiesQuerySchema },
  async (ctx) => {
    const page = await listTicketActivities(
      maintenanceContextFrom(ctx),
      ticketIdFrom(ctx.params),
      ctx.query,
    );
    return jsonResponse(
      { data: page.items.map(toActivity), page_info: page.pageInfo },
      ctx.requestId,
    );
  },
);

/**
 * The roles that may append: staff, the reporting tenant, the assigned provider — the
 * same set as the transition roles, because the §4 matrix grants `CR` on activities to
 * exactly the roles that can act on a ticket. `property_owner` reads only.
 *
 * `actor_profile_id` is never a request field. It is the authenticated caller's profile,
 * and every INSERT policy on the table pins it to `current_profile_id()`.
 */
export const POST = withApiHandler<CreateActivityInput, undefined>(
  {
    roles: TICKET_TRANSITION_ROLES,
    bodySchema: CreateActivitySchema,
    audit: { action: 'ticket_activity_added', entityType: 'maintenance_activity' },
  },
  async (ctx) => {
    const ticketId = ticketIdFrom(ctx.params);
    const activity = await appendActivity(maintenanceContextFrom(ctx), ticketId, ctx.body);

    ctx.audit({
      entityId: activity.id,
      metadata: { ticket_id: ticketId, event: activity.activity_type },
    });

    return created(toActivity(activity), ctx.requestId);
  },
);
