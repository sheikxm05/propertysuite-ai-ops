/**
 * Membership mutation — the one write in this lane that is a direct statement rather
 * than an RPC. Lane w1-l1.
 *
 * The §4 matrix gives `organization_admin` RW on `organization_members`, and `0002`'s
 * `organization_members_update_admin` policy implements it with the predicate repeated
 * in `with check`, so a membership cannot be *moved* into another organization by an
 * UPDATE. Role changes therefore need no security-definer function: the policy is
 * already exactly the rule.
 *
 * Three guards sit on top of the policy, and each exists for a reason RLS cannot cover:
 *
 *  1. **Read the row first, authorize against the row.** `assertAuthorized` is called
 *     with the `organization_id` *as stored*, never with a value from the request. A
 *     member id from another organization reads as absent and becomes a 404 — not a 403,
 *     which would confirm that the id exists.
 *  2. **Only two columns are writable.** The patch is rebuilt field by field from
 *     `UpdateMemberSchema`'s output, so `organization_id`, `profile_id` and `id` are not
 *     merely rejected — they are unreachable.
 *  3. **The last administrator cannot be removed.** An organization whose only admin
 *     demotes or disables themselves has no legal path back: there is no INSERT policy
 *     on `organization_members` and `invite_member` requires an admin to call it. The
 *     database would happily allow it, so this is a genuine application-layer
 *     invariant rather than a duplicated check.
 *
 * No DELETE path exists. Removing someone means `status = 'disabled'`, which keeps the
 * row, its history and its audit trail (CLAUDE.md rule 6).
 */

import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import { assertAuthorized } from '@/lib/auth/authorize';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import type { Member, MemberRole, MemberStatus, UpdateMemberInput } from '@shared/index';

import { MEMBER_SELECT } from './queries';

/** The columns a role change may touch. Everything else is structurally unreachable. */
const MUTABLE_COLUMNS = ['role', 'status'] as const;

interface MemberIdentityRow {
  id: string;
  organization_id: string;
  profile_id: string;
  role: MemberRole;
  status: MemberStatus;
}

/**
 * Applies a role or status change to one membership row.
 *
 * Returns the updated row in the shared `Member` shape. The audit row is written by
 * `withApiHandler`, which is why this function takes no audit argument: a mutation that
 * decided its own audit semantics would be a mutation that could choose not to.
 */
export async function updateMember(
  client: AppSupabaseClient,
  membership: Membership,
  memberId: string,
  patch: UpdateMemberInput,
): Promise<Member> {
  const target = await readMember(client, memberId);

  // Authorization against the stored organization_id, per guard 1 above.
  assertAuthorized(membership, 'update', {
    type: 'organization_member',
    organizationId: target.organization_id,
    profileId: target.profile_id,
  });

  await assertOrganizationKeepsAnAdministrator(client, membership, target, patch);

  const update = buildUpdate(patch);

  const { data, error } = await client
    .from('organization_members')
    .update(update)
    .eq('id', memberId)
    .eq('organization_id', membership.organization.id)
    .select(MEMBER_SELECT)
    .maybeSingle();

  throwIfPostgresError(error);
  if (!data) {
    // The UPDATE matched no row the caller may write. RLS already denied it, so this is
    // the second layer reporting an absent-or-inaccessible resource.
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'member_update_no_row' } });
  }

  const row = data as unknown as {
    id: string;
    organization_id: string;
    profile_id: string;
    role: MemberRole;
    status: MemberStatus;
    created_at: string;
  };

  return {
    id: row.id,
    organization_id: row.organization_id,
    profile_id: row.profile_id,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
    profile: null,
  };
}

/* ----------------------------------------------------------------- helpers -- */

/**
 * Reads the target row, or raises 404.
 *
 * The projection is narrow on purpose — this read exists to establish identity and
 * organization, not to render anything, so it carries no personal data at all.
 */
async function readMember(client: AppSupabaseClient, memberId: string): Promise<MemberIdentityRow> {
  const { data, error } = await client
    .from('organization_members')
    .select('id, organization_id, profile_id, role, status')
    .eq('id', memberId)
    .maybeSingle();

  throwIfPostgresError(error);
  if (!data) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'member_not_found' } });
  }
  return data as unknown as MemberIdentityRow;
}

/**
 * Rebuilds the patch from the allowlist, so an unexpected key cannot reach the UPDATE.
 *
 * The return type names the two columns explicitly rather than widening to
 * `Record<string, unknown>`: the generated `TablesUpdate` type rejects excess properties,
 * so a third column added here would be a compile error rather than a silent write.
 */
function buildUpdate(patch: UpdateMemberInput): { role?: MemberRole; status?: MemberStatus } {
  const update: { role?: MemberRole; status?: MemberStatus } = {};
  for (const column of MUTABLE_COLUMNS) {
    const value = patch[column];
    if (value === undefined) continue;
    if (column === 'role') update.role = value as MemberRole;
    else update.status = value as MemberStatus;
  }
  return update;
}

/**
 * Refuses a change that would leave the organization with no active administrator.
 *
 * Counted rather than assumed, and counted through the caller's own client so the number
 * is one an administrator could verify themselves. The check runs for *any* target, not
 * only for self: an admin demoting the organization's last other admin while they
 * themselves are disabled would strand it just as effectively.
 */
async function assertOrganizationKeepsAnAdministrator(
  client: AppSupabaseClient,
  membership: Membership,
  target: MemberIdentityRow,
  patch: UpdateMemberInput,
): Promise<void> {
  const wasActiveAdmin = target.role === 'organization_admin' && target.status === 'active';
  if (!wasActiveAdmin) return;

  const nextRole = patch.role ?? target.role;
  const nextStatus = patch.status ?? target.status;
  const staysActiveAdmin = nextRole === 'organization_admin' && nextStatus === 'active';
  if (staysActiveAdmin) return;

  const { count, error } = await client
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', membership.organization.id)
    .eq('role', 'organization_admin')
    .eq('status', 'active')
    .neq('id', target.id);

  throwIfPostgresError(error);

  if ((count ?? 0) === 0) {
    throw new ApiRouteError('CONFLICT', {
      message: 'An organization must keep at least one active administrator.',
      logFields: { reason: 'last_administrator' },
    });
  }
}
