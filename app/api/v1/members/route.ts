/**
 * `GET  /api/v1/members` — the member roster, role-filtered by policy.
 * `POST /api/v1/members` — issue an invitation (`organization_admin` only).
 *
 * Route ownership: §5.5 assigns `/api/v1/members` to lane w1-l1.
 *
 * **The roster is not gated by role, and that is the point.** Every role may call `GET`,
 * and what comes back is decided by `0002`'s two SELECT policies: staff see the whole
 * roster, a tenant or a service provider sees exactly one row — their own. Gating the
 * route to staff would hide the boundary; letting policy answer it makes the boundary
 * visible on screen, which is how acceptance criterion 2 gets demonstrated rather than
 * merely asserted. `features/organizations/queries.ts` then strips personal columns the
 * §4 matrix withholds, because RLS is row-level and cannot.
 *
 * **The invitation POST is gated twice**: `roles: ['organization_admin']` on the wrapper
 * refuses a non-admin before the body is even parsed, and `invite_member` refuses again
 * in Postgres with SQLSTATE `42501`, which amendment A2 maps to 403. Deleting the
 * wrapper gate would not open the route; deleting the RPC check would not either.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { created, paginated } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { assertAuthorized } from '@/lib/auth/authorize';
import { listMembers } from '@/features/organizations/queries';
import { describeRpcFailure, inviteMember } from '@/features/organizations/rpc';
import {
  InviteMemberResultSchema,
  InviteMemberSchema,
  ListMembersQuerySchema,
  MemberListResponseSchema,
  type InviteMemberInput,
  type ListMembersQuery,
} from '@shared/index';

export const GET = withApiHandler({ querySchema: ListMembersQuerySchema }, async (ctx) => {
  const query: ListMembersQuery = ctx.query;

  assertAuthorized(ctx.membership, 'read', {
    type: 'organization_member',
    organizationId: ctx.membership.organization.id,
    // Self, so that the tenant and provider cells of the matrix ("R self") resolve to
    // allowed. Which *other* rows come back is RLS's answer, not this one's.
    profileId: ctx.membership.profile.id,
  });

  const page = await listMembers(ctx.supabase, ctx.membership, {
    limit: query.limit,
    cursor: query.cursor,
    role: query.role,
    status: query.status,
  });

  // Amendment A18: one list envelope for the whole application —
  // `{ data, page_info: { next_cursor, has_more, limit } }` — built by `paginated()` and
  // validated against the frozen `MemberListResponseSchema`, which is the contract source
  // when `packages/shared` and `lib/api/responses.ts` disagree.
  //
  // The schema is `.strict()`, which is the point on *this* route: the roster embeds a
  // profile, and a widened projection is exactly how a tenant's email would start
  // arriving in a response while every isolation test stayed green. `has_more` also
  // carries information `next_cursor` cannot — on an RLS-filtered list a short page is
  // normal, so without it a client cannot tell "last page" from "lost cursor".
  return paginated(page.items, page, ctx.requestId, { schema: MemberListResponseSchema });
});

/**
 * Issues an invitation.
 *
 * **Why this response carries the plaintext token, and under which frozen schema.**
 * `packages/shared` ships two frozen shapes for this moment and does not bind either to
 * a route: `IssuedInvitationResponseSchema` (no token) and `InviteMemberResultSchema`
 * (`{ invitation_id, token, role, expires_at }`). This route returns the latter, parsed
 * with it on the way out, because `invite_member` returns the plaintext exactly once —
 * only a SHA-256 hash is stored — and this build has **no out-of-band delivery channel**:
 * no mail transport is in the §5.1 dependency list and none may be installed. Dropping
 * the token here would leave every invitation permanently unredeemable, which fails the
 * lane's exit gate outright. Raised as a planning defect so the orchestrator can rule on
 * which of the two shapes is canonical.
 *
 * The token is handled as the credential it is: it is returned and then forgotten. It
 * does not reach a log line (`token` is absent from the logger's allowlist), an
 * `audit_logs` row (`invite_member` records only the role), an error message, or a URL.
 * `jsonResponse` sets `Cache-Control: no-store` on every response, so no shared cache
 * retains it either.
 *
 * No `audit` option on the wrapper: `invite_member` writes its own `audit_logs` row in
 * the same transaction, recording the role and never the invitee's email address. A
 * second row from the wrapper would make "one audit row per state change" false in the
 * other direction — and the wrapper reads the response body to find an entity id, which
 * is a body this one would rather nothing read.
 */
export const POST = withApiHandler(
  {
    roles: ['organization_admin'],
    bodySchema: InviteMemberSchema,
    rateLimit: { key: 'members:invite', perMinute: 10 },
  },
  async (ctx) => {
    const body: InviteMemberInput = ctx.body;

    assertAuthorized(ctx.membership, 'create', {
      type: 'organization_member',
      organizationId: ctx.membership.organization.id,
    });

    let result;
    try {
      result = await inviteMember(ctx.supabase, {
        organizationId: ctx.membership.organization.id,
        email: body.email,
        role: body.role,
      });
    } catch (error) {
      throw describeRpcFailure(error);
    }

    if (!result.invitation_id) {
      throw new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'rpc_returned_no_id' } });
    }

    // `entity_id` and `role` are on the logger's allowlist; `token` and `email` are not,
    // so neither can reach a log line even by mistake.
    ctx.logger.info('invitation issued', { entity_id: result.invitation_id, role: result.role });

    return created(InviteMemberResultSchema.parse(result), ctx.requestId);
  },
);
