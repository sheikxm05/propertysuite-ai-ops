/**
 * `PATCH /api/v1/members/{memberId}` — change a member's role, or disable them.
 *
 * `organization_admin` only, audited, and with **no DELETE counterpart**: removing
 * somebody means `status = 'disabled'`, which keeps the row, its history and its audit
 * trail (CLAUDE.md rule 6). `UpdateMemberSchema` offers exactly `role` and
 * `status: 'active' | 'disabled'`, so `'invited'` cannot be set by hand either — that
 * state belongs to the invitation flow.
 *
 * This is the one mutation in the lane that is a direct statement rather than an RPC, so
 * it is the one that declares `audit` on the wrapper. The guards live in
 * `features/organizations/members.ts`; see its header for why each exists.
 */

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { updateMember } from '@/features/organizations/members';
import {
  MemberPathParamsSchema,
  MemberSchema,
  UpdateMemberSchema,
  type UpdateMemberInput,
} from '@shared/index';

export const PATCH = withApiHandler(
  {
    roles: ['organization_admin'],
    bodySchema: UpdateMemberSchema,
    rateLimit: { key: 'members:update', perMinute: 30 },
    audit: { action: 'member.role_changed', entityType: 'organization_member' },
  },
  async (ctx) => {
    const { memberId } = MemberPathParamsSchema.parse(ctx.params);
    const patch: UpdateMemberInput = ctx.body;

    const member = await updateMember(ctx.supabase, ctx.membership, memberId, patch);

    // The audit row records which fields changed and to what — identifiers and
    // decisions only. No name, no email, no phone number ever enters `audit_logs`.
    ctx.audit({
      entityId: member.id,
      metadata: {
        role: member.role,
        status: member.status,
        changed: Object.keys(patch),
      },
    });

    return ok(MemberSchema.parse(member), ctx.requestId);
  },
);
