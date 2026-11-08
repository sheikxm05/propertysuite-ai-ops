/**
 * `GET /api/v1/members/invitations` — pending and historical invitations.
 *
 * `organization_admin` only, in both layers: the wrapper's role gate refuses everyone
 * else, and `0003`'s single SELECT policy on `organization_invitations` grants the table
 * to an admin of the owning organization and to nobody else. A revoked or accepted
 * invitation stays listed — there is no DELETE path for it (CLAUDE.md rule 6), so the
 * list is a record rather than a queue.
 *
 * **`select *` is never written against this table.** The grant in `0003` is
 * column-level and omits `token_hash`, so a star select fails with a permission error.
 * The projection is `INVITATION_COLUMNS` in `features/organizations/queries.ts`, and
 * `tests/organizations/no-star-select.test.ts` greps this lane's source to prove no star
 * select exists anywhere in it.
 *
 * Static segment, so it is matched before `[memberId]` — `/api/v1/members/invitations`
 * can never be read as a member id.
 */

import { paginated } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { listInvitations } from '@/features/organizations/queries';
import {
  InvitationListResponseSchema,
  ListInvitationsQuerySchema,
  type ListInvitationsQuery,
} from '@shared/index';

export const GET = withApiHandler(
  {
    roles: ['organization_admin'],
    querySchema: ListInvitationsQuerySchema,
  },
  async (ctx) => {
    const query: ListInvitationsQuery = ctx.query;

    const page = await listInvitations(ctx.supabase, ctx.membership, {
      limit: query.limit,
      cursor: query.cursor,
      status: query.status,
    });

    // Amendment A18: one list envelope for the whole application,
    // `{ data, page_info: { next_cursor, has_more, limit } }`, built by `paginated()` and
    // validated against the frozen `InvitationListResponseSchema`. Passing the schema is
    // what makes this worth doing on a 25-row page: `listResponseSchema` is `.strict()`,
    // so a route projecting a column the contract does not declare fails here — and on
    // this table in particular, that is how `token_hash` would leak if the grant were
    // ever widened.
    //
    // `page` satisfies `PageInfoInput` structurally, so the keyset builder's own output
    // is passed straight through rather than restated field by field.
    return paginated(page.items, page, ctx.requestId, {
      schema: InvitationListResponseSchema,
    });
  },
);
