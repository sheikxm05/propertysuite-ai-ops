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

import { resolveMembership, type Membership } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/supabase/server';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import { throwIfPostgresError } from '@/lib/api/errors';
import { STAFF_ROLES, isStaffRole } from '@shared/index';

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
 * `organization_members` carries `profile_id` but not a name, and `profiles` is reachable
 * only through `lib/auth/roles.ts` (`eslint.config.mjs` restricts the table by name, and
 * the briefing makes `lib/**` read-only to this lane), so there is no lane-legal source of
 * display names for this picker. The options are therefore labelled by role and a short
 * membership id. Reported as a planning defect with this lane.
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
    .limit(100);
  throwIfPostgresError(error);

  return (data ?? []).map((row) => ({ memberId: row.id, role: row.role }));
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
