/**
 * Read paths for identity, membership and invitations. Lane w1-l1.
 *
 * Every function here takes a Supabase client rather than building one, so the same
 * query serves a server component (`createServerClient()`) and a route handler
 * (`ctx.supabase`). Both clients carry the caller's identity and Row Level Security is
 * in force for both — there is no service-role path anywhere in this lane.
 *
 * Three contracts this file exists to keep:
 *
 *  1. **`select *` is never written against `public.organization_invitations`.** The
 *     client grant in migration `0003` is COLUMN-LEVEL and deliberately omits
 *     `token_hash`, so a star select fails with a permission error. The readable set is
 *     `INVITATION_COLUMNS`, copied from the CONSUMER NOTE above that grant, and it is
 *     the only projection used.
 *  2. **`organizations` and `profiles` are never queried directly from here.**
 *     `eslint.config.mjs` restricts both table names outside `lib/**`, `app/api/**` and
 *     a few other paths, precisely so that organization and role resolution happens in
 *     `resolveMembership()`. Profile columns arrive as a PostgREST embedding through
 *     `organization_members`, which is a relationship traversal rather than an ad hoc
 *     query, and is still fully RLS-governed.
 *  3. **Column visibility is decided twice.** RLS grants or denies the *row*; it cannot
 *     hide a *column*. So every embedded profile is run through
 *     `authorize(membership, 'read', { type: 'profile', … })` and the personal fields
 *     are dropped when the matrix withholds them. A tenant reading the roster therefore
 *     cannot see another person's email even if a policy regression let the row through.
 */

import { throwIfPostgresError } from '@/lib/api/errors';
import { authorize } from '@/lib/auth/authorize';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import {
  DEFAULT_PAGE_SIZE,
  type Invitation,
  type InvitationStatus,
  type Member,
  type MemberRole,
  type MemberStatus,
} from '@shared/index';

import { decodeCursor, encodeCursor, type PageCursor } from './cursor';

/* ------------------------------------------------------------- projections -- */

/**
 * The readable columns of `public.organization_invitations`, verbatim from the
 * CONSUMER NOTE in `supabase/migrations/0003_domain_integrity.sql`.
 *
 * `token_hash` is absent because the grant omits it. Do not add a column here without
 * adding it to the grant first, and never replace this with `'*'`:
 * `tests/organizations/no-star-select.test.ts` greps this lane's own source to prove
 * that no star select against this table exists anywhere in it.
 */
export const INVITATION_COLUMNS = [
  'id',
  'organization_id',
  'email',
  'role',
  'status',
  'invited_by_profile_id',
  'accepted_profile_id',
  'expires_at',
  'accepted_at',
  'created_at',
] as const;

/** `INVITATION_COLUMNS` as a PostgREST select list. */
export const INVITATION_SELECT = INVITATION_COLUMNS.join(', ');

/**
 * Membership columns plus the embedded profile.
 *
 * The embedding is deliberately *not* `profiles!inner(...)`: an inner join would delete
 * a membership row from the roster whenever RLS hid its profile, silently turning a
 * column-visibility rule into a missing person. With a left embedding the row survives
 * and `profile` arrives as `null`, which the roster renders honestly.
 */
export const MEMBER_SELECT = `
  id,
  organization_id,
  profile_id,
  role,
  status,
  created_at,
  profiles ( id, full_name, email, phone )
`;

/* ------------------------------------------------------------------- types -- */

/** The row shape `MEMBER_SELECT` returns. A query DTO, not a shared domain type. */
interface MemberRow {
  id: string;
  organization_id: string;
  profile_id: string;
  role: MemberRole;
  status: MemberStatus;
  created_at: string;
  profiles: {
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
  } | null;
}

/** The row shape `INVITATION_SELECT` returns. */
interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: MemberRole;
  status: InvitationStatus;
  invited_by_profile_id: string | null;
  accepted_profile_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

/** One page of results plus the cursor that follows it. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface ListMembersOptions {
  limit?: number;
  cursor?: string | undefined;
  role?: MemberRole | undefined;
  status?: MemberStatus | undefined;
}

export interface ListInvitationsOptions {
  limit?: number;
  cursor?: string | undefined;
  status?: InvitationStatus | undefined;
}

/* ----------------------------------------------------------------- members -- */

/**
 * One page of the member roster for the caller's organization.
 *
 * `organizationId` comes from `membership.organization.id` — a trusted row — and never
 * from a request. It is applied as a filter anyway, on top of RLS, because the two
 * layers must each be sufficient alone (CLAUDE.md goal 1).
 *
 * What a caller actually sees is decided by policy, not by this function. A staff role
 * sees the whole roster; a tenant or a service provider sees exactly one row, their own,
 * because `organization_members_select_staff` excludes them and
 * `organization_members_select_self` is all that remains. That is the role boundary
 * being visible on screen rather than merely asserted in a test.
 */
export async function listMembers(
  client: AppSupabaseClient,
  membership: Membership,
  options: ListMembersOptions = {},
): Promise<Page<Member>> {
  const limit = clampLimit(options.limit);
  const cursor = decodeCursor(options.cursor);

  let query = client
    .from('organization_members')
    .select(MEMBER_SELECT)
    .eq('organization_id', membership.organization.id)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit + 1);

  if (options.role) query = query.eq('role', options.role);
  if (options.status) query = query.eq('status', options.status);
  query = applyCursor(query, cursor);

  const { data, error } = await query;
  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as MemberRow[];
  return paginate(rows, limit, (row) => toMember(row, membership));
}

/**
 * Strips the profile fields the §4 matrix withholds from this caller.
 *
 * `authorize` is asked about the *profile* resource, not the membership, because the two
 * have different scopes: a property manager may read every membership in the
 * organization and every profile in it, while a tenant may read its own membership and
 * only its own profile. Asking the matrix rather than testing a role literal keeps this
 * file from becoming a second, drifting copy of the policy table.
 */
function toMember(row: MemberRow, membership: Membership): Member {
  const base = {
    id: row.id,
    organization_id: row.organization_id,
    profile_id: row.profile_id,
    role: row.role,
    status: row.status,
    created_at: row.created_at,
  };

  if (!row.profiles) return { ...base, profile: null };

  const mayRead = authorize(membership, 'read', {
    type: 'profile',
    organizationId: row.organization_id,
    profileId: row.profile_id,
  });

  if (!mayRead.allowed) return { ...base, profile: null };

  return {
    ...base,
    profile: {
      id: row.profiles.id,
      full_name: row.profiles.full_name,
      email: row.profiles.email,
      phone: row.profiles.phone,
    },
  };
}

/* ------------------------------------------------------------- invitations -- */

/**
 * One page of invitations for the caller's organization.
 *
 * Only an `organization_admin` has a SELECT policy on this table, so every other role
 * receives an empty page rather than an error — a 403 would confirm that invitations
 * exist. The route gates on role as well, so a non-admin never reaches here in practice;
 * this is the second layer.
 */
export async function listInvitations(
  client: AppSupabaseClient,
  membership: Membership,
  options: ListInvitationsOptions = {},
): Promise<Page<Invitation>> {
  const limit = clampLimit(options.limit);
  const cursor = decodeCursor(options.cursor);

  // INVITATION_SELECT, never '*'. See the file header, contract 1.
  let query = client
    .from('organization_invitations')
    .select(INVITATION_SELECT)
    .eq('organization_id', membership.organization.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (options.status) query = query.eq('status', options.status);
  query = applyCursor(query, cursor, 'desc');

  const { data, error } = await query;
  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as InvitationRow[];
  return paginate(rows, limit, (row) => ({
    id: row.id,
    organization_id: row.organization_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invited_by_profile_id: row.invited_by_profile_id,
    accepted_profile_id: row.accepted_profile_id,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
  }));
}

/* ----------------------------------------------------------------- summary -- */

/**
 * The organization summary the dashboard widget and the organization page render.
 *
 * Counts come from `head: true` count queries, so no row data crosses the wire for a
 * number that is only displayed. `pendingInvitations` is `null` for a role with no
 * SELECT policy on the invitations table, which is honest — zero would be a lie.
 */
export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  role: MemberRole;
  memberStatus: Membership['status'];
  activeMembers: number | null;
  pendingInvitations: number | null;
}

export async function getOrganizationSummary(
  client: AppSupabaseClient,
  membership: Membership,
): Promise<OrganizationSummary> {
  const activeMembers = await countOrNull(
    client
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', membership.organization.id)
      .eq('status', 'active'),
  );

  const canSeeInvitations = authorize(membership, 'read', {
    type: 'organization_member',
    organizationId: membership.organization.id,
  }).allowed;

  const pendingInvitations =
    canSeeInvitations && membership.role === 'organization_admin'
      ? await countOrNull(
          client
            .from('organization_invitations')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', membership.organization.id)
            .eq('status', 'pending'),
        )
      : null;

  return {
    id: membership.organization.id,
    name: membership.organization.name,
    slug: membership.organization.slug,
    status: membership.organization.status,
    role: membership.role,
    memberStatus: membership.status,
    activeMembers,
    pendingInvitations,
  };
}

/* ----------------------------------------------------------------- helpers -- */

/**
 * Runs a count query and returns `null` rather than throwing when the caller has no
 * policy for the table. A widget that cannot count is a widget that says "—"; it is not
 * a 500.
 */
async function countOrNull(builder: PromiseLike<{ count: number | null }>): Promise<number | null> {
  const result = await builder;
  return typeof result.count === 'number' ? result.count : null;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_PAGE_SIZE;
  return Math.trunc(limit);
}

/**
 * The keyset predicate for the page after `cursor`.
 *
 * Keyset rather than offset, because with Row Level Security the visible row set differs
 * per caller and an offset is not stable across requests — `packages/shared`'s
 * pagination constants say the same thing. The compound comparison is spelled out
 * because PostgREST has no row-value syntax.
 */
function applyCursor<T extends { or(filter: string): T }>(
  query: T,
  cursor: PageCursor | null,
  direction: 'asc' | 'desc' = 'asc',
): T {
  if (!cursor) return query;
  const op = direction === 'asc' ? 'gt' : 'lt';
  return query.or(
    `created_at.${op}.${cursor.createdAt},` +
      `and(created_at.eq.${cursor.createdAt},id.${op}.${cursor.id})`,
  );
}

/**
 * Turns `limit + 1` rows into a page of `limit`.
 *
 * Over-fetching by one is how `has_more` is known without a second count query, and it
 * is why `limit + 1` appears in every query above.
 */
function paginate<TRow extends { id: string; created_at: string }, TItem>(
  rows: readonly TRow[],
  limit: number,
  map: (row: TRow) => TItem,
): Page<TItem> {
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const last = visible[visible.length - 1];

  return {
    items: visible.map(map),
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
    hasMore,
    limit,
  };
}
