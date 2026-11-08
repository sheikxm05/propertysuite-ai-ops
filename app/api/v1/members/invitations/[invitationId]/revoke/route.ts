/**
 * `POST /api/v1/members/invitations/{invitationId}/revoke` — withdraw a pending
 * invitation.
 *
 * A POST to a `/revoke` sub-resource rather than a `DELETE` on the invitation, because
 * no tenant-scoped table in this application has a DELETE path (CLAUDE.md rule 6). The
 * row survives with `status = 'revoked'`, so the audit trail still shows that an
 * invitation was issued and then withdrawn, by whom and when.
 *
 * `revoke_invitation` refuses in Postgres unless the caller is an `organization_admin`
 * **of the owning organization**, and it returns the *same* error for "no such
 * invitation" as for "exists but is not yours" — so this route is not a
 * cross-organization invitation oracle. `describeRpcFailure` preserves that: it maps
 * both to one flat refusal rather than splitting them for a friendlier message.
 */

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { describeRpcFailure, revokeInvitation } from '@/features/organizations/rpc';
import { InvitationPathParamsSchema } from '@shared/index';

export const POST = withApiHandler(
  {
    roles: ['organization_admin'],
    rateLimit: { key: 'members:revoke-invitation', perMinute: 20 },
  },
  async (ctx) => {
    const { invitationId } = InvitationPathParamsSchema.parse(ctx.params);

    let result;
    try {
      result = await revokeInvitation(ctx.supabase, invitationId);
    } catch (error) {
      throw describeRpcFailure(error);
    }

    // `revoke_invitation` writes its own audit row (`member.invitation_revoked`) inside
    // the same transaction, which is why the wrapper declares no `audit` option here:
    // one state change, one audit row.
    ctx.logger.info('invitation revoked', { entity_id: result.invitation_id });

    return ok(result, ctx.requestId);
  },
);
