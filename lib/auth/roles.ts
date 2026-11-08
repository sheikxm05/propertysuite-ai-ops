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
import type { Logger } from '@/lib/observability/logger';
import { MAX_PAGE_SIZE, type MemberRole } from '@/lib/shared';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import { authorize } from './authorize';

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

/* ---------------------------------------------------- member display names -- */

/**
 * What a picker needs to label a person, and nothing more.
 *
 * `email` and `phone` are absent, and the absence is the point. A name picker does not
 * need contact details, and returning them would recreate the provider/tenant projection
 * problem on a second table — the §4 matrix lets staff *read* a same-organization
 * profile, but "readable" is not "needed here".
 */
export interface MemberDisplayName {
  fullName: string;
  role: MemberRole;
}

/**
 * Only `id` and `organization_id` are ever interpolated into a PostgREST filter string,
 * and both are UUID columns. Ids that are not UUID-shaped are dropped before the query
 * rather than escaped.
 *
 * `.in('id', ids)` serialises to `id=in.(a,b,c)`, where the comma and the parentheses
 * are structural in that grammar. A value containing either would break out of the
 * filter. In practice these ids come from a `uuid` column so they cannot, but the guard
 * costs one regex and removes the need to trust that every future caller knows it.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves `organization_members.id` → display name, for a bounded batch.
 *
 * Why it lives here: `eslint.config.mjs` restricts the `profiles` table by name to this
 * module, and a feature lane cannot write in `lib/**`. Lane w1-l2 needs owner names for
 * `properties.owner_member_id` and was reduced to labelling people `Member a1b2c3d4`.
 * This is the read, in the one place the rule already permits it.
 *
 * Three layers decide what comes back, and they are independent on purpose:
 *
 *  1. **Row Level Security.** The query runs on the CALLER's client, never service-role.
 *     The §4 matrix already says staff and owners may read a same-organization profile
 *     while a tenant or provider may read only their own, so RLS returns the correct set
 *     without this function encoding any of it. Service-role here would hand every
 *     caller every name in the organization.
 *  2. **An explicit organization filter.** `organization_id` is pinned to the trusted
 *     membership, so the application layer denies cross-organization reads even if a
 *     policy regressed. This is the "assume RLS has a bug" half of the contract.
 *  3. **`authorize()` per row.** Every returned row is re-checked against the matrix
 *     before it enters the map, so a leaked row is dropped rather than rendered.
 *
 * Degrades rather than throws. A tenant asking about another member simply gets no entry
 * for them, and the caller falls back to its id-based label — the matrix says a tenant
 * may not see that name, so an empty result is the correct answer, not an error.
 */
export async function resolveMemberDisplayNames(
  client: AppSupabaseClient,
  membership: Membership,
  memberIds: readonly string[],
  logger?: Logger,
): Promise<Map<string, MemberDisplayName>> {
  const out = new Map<string, MemberDisplayName>();

  // Deduplicate and drop anything that is not a uuid — see UUID_SHAPE above.
  const ids = Array.from(new Set(memberIds)).filter((id) => UUID_SHAPE.test(id));
  if (ids.length === 0) return out;

  // Bounded by the frozen maximum page size (§5.7) rather than by a number invented
  // here: a caller labelling one page of rows can never legitimately exceed it, and the
  // cap is what stops this becoming an "enumerate every profile" surface.
  if (ids.length > MAX_PAGE_SIZE) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'member_display_name_batch_too_large', count: ids.length },
    });
  }

  const { data, error } = await client
    .from('organization_members')
    .select('id, role, organization_id, profiles!inner ( id, full_name )')
    .eq('organization_id', membership.organization.id)
    .in('id', ids);

  if (error) {
    // Degrade, loudly. The caller renders its id-based label; the log carries the
    // correlation id so a silent downgrade is still visible in Wave 2's traces.
    logger?.error('member display name lookup failed', {
      reason: 'member_display_name_query_failed',
      pg_code: error.code ?? 'unknown',
      organization_id: membership.organization.id,
      count: ids.length,
    });
    return out;
  }

  const rows = (data ?? []) as unknown as MemberDisplayNameRow[];

  for (const row of rows) {
    const profile = row.profiles;
    if (!profile) continue;

    // Layer 3. Independent of both RLS and the filter above.
    const decision = authorize(membership, 'read', {
      type: 'profile',
      organizationId: row.organization_id,
      profileId: profile.id,
    });
    if (!decision.allowed) continue;

    out.set(row.id, { fullName: profile.full_name, role: row.role as MemberRole });
  }

  return out;
}

/** The row shape the display-name select returns. A query DTO, not a domain type. */
interface MemberDisplayNameRow {
  id: string;
  role: string;
  organization_id: string;
  profiles: { id: string; full_name: string } | null;
}
