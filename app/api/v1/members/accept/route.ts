/**
 * `POST /api/v1/members/accept` — redeem an invitation token.
 *
 * **Read this before assuming the route is the whole story.** `withApiHandler` resolves
 * membership before the handler runs and answers `FORBIDDEN` when the caller has none.
 * An invitee accepting their *first* invitation has none by definition, so this route
 * cannot serve them — it serves someone who already belongs to one organization and is
 * joining a second. First-time acceptance goes through the server action in
 * `app/(auth)/actions.ts`, which calls the same `acceptInvitation()` function against
 * the same RPC. Raised as a planning defect; the shared implementation is what keeps the
 * two transports from diverging.
 *
 * The token travels in the **body**, never in the path or query string. `0003` stores
 * only its SHA-256 hash, and `AcceptInvitationSchema`'s own comment says why the body is
 * the right place: a URL ends up in access logs, browser history and referrer headers.
 * It is not logged here either — `token` is absent from the logger's allowlist.
 *
 * Possession of the token is necessary but not sufficient: the RPC requires the
 * authenticated account's email to match the invitation, so an intercepted token is
 * useless to whoever intercepted it.
 */

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { acceptInvitation, describeRpcFailure } from '@/features/organizations/rpc';
import { AcceptInvitationSchema, type AcceptInvitationInput } from '@shared/index';

export const POST = withApiHandler(
  {
    bodySchema: AcceptInvitationSchema,
    // Tighter than the lane's other buckets: this is the one endpoint where a wrong
    // answer is still informative, so guessing must be expensive.
    rateLimit: { key: 'members:accept-invitation', perMinute: 5 },
  },
  async (ctx) => {
    const body: AcceptInvitationInput = ctx.body;

    let result;
    try {
      result = await acceptInvitation(ctx.supabase, body.invitation_token);
    } catch (error) {
      throw describeRpcFailure(error);
    }

    // `accept_invitation` audits itself (`invitation.accepted`) in the same transaction.
    ctx.logger.info('invitation accepted', {
      organization_id: result.organization_id,
      member_id: result.member_id,
      role: result.role,
    });

    return ok(result, ctx.requestId);
  },
);
