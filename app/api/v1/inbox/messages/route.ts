/**
 * `GET /api/v1/inbox/messages` — the inbound queue, newest first.
 *
 * No `roles` gate. Every role that has a legitimate view gets one and the rest get an
 * empty page: staff see their organization's queue, a tenant sees messages from their
 * own number, an owner and a provider see nothing. `audienceFor()` in
 * `features/inbox/domain/scope.ts` decides the filter, RLS on `inbound_messages` denies
 * independently in Postgres, and a 403 is deliberately not used — an empty page
 * discloses nothing, a 403 would disclose that a populated inbox exists for other
 * people.
 *
 * The response is the standard `{ data, page_info }` envelope from `paginated()`
 * (§5.7 amendment A18). `has_more` comes from asking for `limit + 1` rows, not from
 * whether the page came back full.
 *
 * No `schema` is passed to `paginated()`. Every other list route passes its shared
 * `*ListResponseSchema`, and this one has none to pass: `packages/shared` is read-only
 * in Wave 3 and nothing there describes an inbound message. Reported as a planning
 * defect. The projection is still explicit — `MESSAGE_COLUMNS` in the repository and a
 * hand-built view object — so nothing undeclared can ride along; what is missing is the
 * third guard, not the first two.
 */

import { paginated } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import {
  ListInboxQuerySchema,
  inboxContextFrom,
  listMessages,
  senderDirectory,
  toMessageView,
  type ListInboxQuery,
} from '@/features/inbox/domain';

export const GET = withApiHandler<undefined, ListInboxQuery>(
  { querySchema: ListInboxQuerySchema },
  async (ctx) => {
    const context = inboxContextFrom(ctx);

    // The directory is read with the caller's own credentials, so a sender can only
    // resolve to a tenant the caller was already entitled to see.
    const [page, directory] = await Promise.all([
      listMessages(context, ctx.query),
      senderDirectory(context),
    ]);

    return paginated(
      page.items.map((row) => toMessageView(row, directory)),
      { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: page.limit },
      ctx.requestId,
    );
  },
);
