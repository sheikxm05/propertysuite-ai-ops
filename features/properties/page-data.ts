/**
 * Server-side plumbing for the `/properties` pages.
 *
 * The three things every page in this section needs — a caller-scoped client, the
 * caller's membership, and the list of memberships that may be named as a property
 * owner — resolved once, here.
 *
 * `resolveMembership` from `lib/auth/roles.ts` is the only way the organization is
 * established. Nothing in this module takes an `organization_id`, a role, or any other
 * scope input from a request, a prop, a cookie or a search parameter (CLAUDE.md rule 5).
 *
 * These pages are a convenience boundary, not a security one. `middleware.ts` gates the
 * `(dashboard)` group, every API route re-authorizes through `withApiHandler`, and RLS
 * denies independently — so a page rendering a control the caller cannot use is a
 * cosmetic defect, not a vulnerability.
 */

import { resolveMemberDisplayNames, resolveMembership, type Membership } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/supabase/server';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import { throwIfPostgresError } from '@/lib/api/errors';
import { MAX_PAGE_SIZE, STAFF_ROLES, isStaffRole } from '@shared/index';

import { OWNER_ASSOCIABLE_ROLES } from './authorization';
import type { OwnerOption } from './property-form';

/** What a page gets when the caller is signed in and belongs to an organization. */
export interface PageContext {
  supabase: AppSupabaseClient;
  membership: Membership;
  /** `organization_admin` or `property_manager`. Presentation only — the server re-checks. */
  canWrite: boolean;
}

/**
 * Resolves the page context, or `null`.
 *
 * `null` covers both "no session" and "authenticated but a member of nothing" — a real
 * state while an invitation is pending. Neither is an error and neither redirects from
 * here: `middleware.ts` already handles the unauthenticated case for this route group, and
 * a page that redirected an invitation-pending user would bounce them away from the only
 * place that can fix it.
 */
export async function resolvePageContext(): Promise<PageContext | null> {
  const supabase = await createServerClient();

  const session = await getSession(supabase);
  if (!session) return null;

  const membership = await resolveMembership(session.userId, supabase);
  if (!membership) return null;

  return { supabase, membership, canWrite: isStaffRole(membership.role) };
}

/** The roles that may write a property, for the "you can read this" copy on a page. */
export const PROPERTY_WRITE_ROLES = STAFF_ROLES;

/**
 * Memberships that may be recorded as `properties.owner_member_id`.
 *
 * Filtered to `OWNER_ASSOCIABLE_ROLES` and to active members, which is the same rule
 * `assertOwnerAssociable` enforces on the write path — this list is the UI half, so the
 * picker cannot offer an option the server will refuse.
 *
 * Display names come from `resolveMemberDisplayNames` in `lib/auth/roles.ts`, which
 * w0-l5 added in response to this lane's planning defect: `eslint.config.mjs` restricts
 * the `profiles` table by name to that module, so it is the one place the read is
 * permitted. It degrades rather than throws — a caller the matrix says may not see a name
 * simply gets no entry — so `fullName` is optional here and the picker falls back to a
 * role-and-id label.
 *
 * `.limit(MAX_PAGE_SIZE)` is the frozen §5.7 maximum rather than a number invented here,
 * and it is also the batch cap `resolveMemberDisplayNames` enforces, so the two cannot
 * disagree about how large one page of names may be.
 */
export async function listOwnerOptions(
  client: AppSupabaseClient,
  membership: Membership,
): Promise<OwnerOption[]> {
  const { data, error } = await client
    .from('organization_members')
    .select('id, role, status')
    .eq('organization_id', membership.organization.id)
    .eq('status', 'active')
    .in('role', [...OWNER_ASSOCIABLE_ROLES])
    .order('created_at', { ascending: true })
    .limit(MAX_PAGE_SIZE);
  throwIfPostgresError(error);

  const members = data ?? [];
  const names = await resolveMemberDisplayNames(
    client,
    membership,
    members.map((row) => row.id),
  );

  return members.map((row) => {
    const name = names.get(row.id);
    return name
      ? { memberId: row.id, role: row.role, fullName: name.fullName }
      : { memberId: row.id, role: row.role };
  });
}

/**
 * The display name for a single membership, or `null`.
 *
 * Used by the property detail page for `owner_member_id`. `null` means "not resolvable by
 * this caller", which for a tenant or a provider is the matrix answering correctly rather
 * than a failure — so the caller renders an id-based label instead of an error.
 */
export async function resolveOwnerName(
  client: AppSupabaseClient,
  membership: Membership,
  ownerMemberId: string | null,
): Promise<string | null> {
  if (!ownerMemberId) return null;
  const names = await resolveMemberDisplayNames(client, membership, [ownerMemberId]);
  return names.get(ownerMemberId)?.fullName ?? null;
}

/**
 * Reads one search parameter as a single string.
 *
 * Next.js hands a repeated parameter back as an array. Taking `[0]` rather than joining
 * means `?status=active&status=archived` resolves to one value the schema can judge,
 * instead of the string `active,archived`, which would fail validation for a reason the
 * user cannot see.
 */
export function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
