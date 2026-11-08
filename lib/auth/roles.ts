/**
 * Membership resolution — the single most security-critical function in `lib/**`.
 *
 * **Everything here comes from trusted database rows.** `organization_id` is never read
 * from a request body, query string, header or cookie, and there is no parameter on any
 * exported function through which a caller could supply one. That is CLAUDE.md rule 5,
 * and it is the reason organization A cannot ask for organization B's data by simply
 * saying so.
 *
 * The only input is `userId`, which must come from a verified session —
 * `supabase.auth.getUser()`, which validates the JWT against the auth server, not
 * `getSession()`, which decodes it locally. `resolveMembership` re-checks that the row
 * it found actually belongs to the user it was asked about, so a mismatch is a thrown
 * error rather than a silent impersonation.
 *
 * The query runs through the **caller-scoped** client, so Row Level Security applies to
 * membership resolution itself. A user who is not a member sees no rows, and the
 * service-role client is not involved anywhere in this file.
 */

import { ApiRouteError } from '@/lib/api/errors';
import type { MemberRole } from '@/lib/shared';
import type { AppSupabaseClient } from '@/lib/supabase/types';

/** The profile fields `lib/**` needs. Not every column — PII stays out of contexts. */
export interface MembershipProfile {
  id: string;
  authUserId: string;
  fullName: string;
}

export interface MembershipOrganization {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
}

/**
 * Who the caller is, inside exactly one organization.
 *
 * `tenantId` and `providerId` are the caller's identity *as a party to the business
 * domain*, resolved from `tenants.profile_id` and `service_providers.profile_id`. They
 * are what lets `authorize()` answer "is this your tenancy?" without a second query and
 * without trusting a path parameter.
 */
export interface Membership {
  /** `organization_members.id`. Matched against `properties.owner_member_id`. */
  memberId: string;
  role: MemberRole;
  status: 'invited' | 'active' | 'disabled';
  profile: MembershipProfile;
  organization: MembershipOrganization;
  /** `tenants.id` in this organization, or `null` if the caller is not a tenant. */
  tenantId: string | null;
  /** `service_providers.id` in this organization, or `null`. */
  providerId: string | null;
}

/* ------------------------------------------------------------------ query -- */

/**
 * One round trip.
 *
 * `organizations` and `profiles` are reached as PostgREST embeddings rather than as
 * separate `.from('organizations')` / `.from('profiles')` calls. Two reasons: it is one
 * query instead of three, and `eslint.config.mjs` restricts those two table names
 * precisely so that membership is resolved here and nowhere else.
 *
 * `tenants` and `service_providers` are nested a level deeper, through `profiles`, which
 * is the only relationship Postgres has between them (`tenants.profile_id →
 * profiles.id`).
 */
const MEMBERSHIP_SELECT = `
  id,
  role,
  status,
  organization_id,
  created_at,
  organizations!inner ( id, name, slug, status ),
  profiles!inner (
    id,
    auth_user_id,
    full_name,
    tenants ( id, organization_id ),
    service_providers ( id, organization_id )
  )
`;

/** The row shape `MEMBERSHIP_SELECT` returns. A query DTO, not a shared domain type. */
interface MembershipRow {
  id: string;
  role: string;
  status: string;
  organization_id: string;
  created_at: string;
  organizations: {
    id: string;
    name: string;
    slug: string;
    status: string;
  } | null;
  profiles: {
    id: string;
    auth_user_id: string;
    full_name: string;
    tenants: { id: string; organization_id: string }[] | null;
    service_providers: { id: string; organization_id: string }[] | null;
  } | null;
}

/**
 * Every active membership the user holds, oldest first.
 *
 * Exported for a future organization switcher. Note what is *not* here: a way to choose
 * one by passing an id. When that switcher is built, the chosen organization must be
 * validated against this list — which is exactly what `resolveMembershipFor` does.
 */
export async function resolveMemberships(
  userId: string,
  client: AppSupabaseClient,
): Promise<Membership[]> {
  if (!userId) return [];

  const { data, error } = await client
    .from('organization_members')
    .select(MEMBERSHIP_SELECT)
    .eq('status', 'active')
    .eq('profiles.auth_user_id', userId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'membership_query_failed', pg_code: error.code ?? 'unknown' },
      cause: error,
    });
  }

  const rows = (data ?? []) as unknown as MembershipRow[];
  return rows.map((row) => toMembership(row, userId)).filter((m): m is Membership => m !== null);
}

/**
 * The caller's membership.
 *
 * Returns `null` when the user has no active membership — authenticated but not a
 * member of anything is a legitimate state (an invitation not yet accepted), and
 * `withApiHandler` turns it into a 403 rather than a 500.
 *
 * A user with more than one active membership resolves to the **oldest**, which is
 * deterministic and does not depend on request data. Picking from a cookie or a header
 * would reintroduce exactly the client-supplied `organization_id` that rule 5 forbids.
 */
export async function resolveMembership(
  userId: string,
  client: AppSupabaseClient,
): Promise<Membership | null> {
  const all = await resolveMemberships(userId, client);
  return all[0] ?? null;
}

/**
 * The caller's membership in a specific organization.
 *
 * The id may come from a route path — that is safe here *because* it is used as a
 * filter over rows the caller can already see, not as the source of the organization
 * identity. A non-member gets `null`, never a membership.
 */
export async function resolveMembershipFor(
  userId: string,
  organizationId: string,
  client: AppSupabaseClient,
): Promise<Membership | null> {
  const all = await resolveMemberships(userId, client);
  return all.find((m) => m.organization.id === organizationId) ?? null;
}

/** `resolveMembership`, as an assertion. Throws a 403 when there is no membership. */
export async function requireMembership(
  userId: string,
  client: AppSupabaseClient,
): Promise<Membership> {
  const membership = await resolveMembership(userId, client);
  if (!membership) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'no_active_membership' },
    });
  }
  return membership;
}

/* ----------------------------------------------------------------- mapping -- */

/**
 * Maps a row to a `Membership`, or `null` if it is not trustworthy.
 *
 * The `auth_user_id` re-check is the important line. PostgREST applied the filter, RLS
 * applied the policy, and this asserts the result anyway — three independent chances to
 * catch a bad embedding or a policy regression before a membership is minted for the
 * wrong person.
 */
function toMembership(row: MembershipRow, expectedUserId: string): Membership | null {
  const organization = row.organizations;
  const profile = row.profiles;
  if (!organization || !profile) return null;

  if (profile.auth_user_id !== expectedUserId) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'membership_identity_mismatch' },
    });
  }

  const organizationId = row.organization_id;

  // Scope the domain identities to this organization. A profile can be a tenant in one
  // organization and nothing in another; taking the first row would cross the boundary.
  const tenantId =
    (profile.tenants ?? []).find((t) => t.organization_id === organizationId)?.id ?? null;
  const providerId =
    (profile.service_providers ?? []).find((p) => p.organization_id === organizationId)?.id ?? null;

  return {
    memberId: row.id,
    role: row.role as MemberRole,
    status: normaliseMemberStatus(row.status),
    profile: {
      id: profile.id,
      authUserId: profile.auth_user_id,
      fullName: profile.full_name,
    },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status === 'active' ? 'active' : 'suspended',
    },
    tenantId,
    providerId,
  };
}

function normaliseMemberStatus(value: string): Membership['status'] {
  if (value === 'active' || value === 'invited' || value === 'disabled') return value;
  // An unrecognised status is treated as the least privileged, not as active.
  return 'disabled';
}

/** Log fields that identify the actor without naming them. Used by `withApiHandler`. */
export function membershipLogFields(membership: Membership): Record<string, unknown> {
  return {
    organization_id: membership.organization.id,
    profile_id: membership.profile.id,
    member_id: membership.memberId,
    role: membership.role,
  };
}
