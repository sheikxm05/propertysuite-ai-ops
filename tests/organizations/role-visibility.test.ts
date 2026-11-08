/**
 * An accepted member receives exactly their role's visibility — and nothing more.
 * Lane w1-l1 exit-gate assertion 3.
 *
 * The lane's exit gate is "an accepted member receives exactly their role's visibility".
 * That claim has two independent halves, and they are enforced in two different places:
 *
 *   which ROWS    Row Level Security. `organization_members_select_staff` grants the
 *                 roster to admin, manager and owner; `organization_members_select_self`
 *                 is all a tenant or a provider has. Proven against real Postgres by
 *                 `tests/rls/**` and by `live-invitation-lifecycle.test.ts`. A fake
 *                 client cannot prove it and this file does not pretend to.
 *
 *   which COLUMNS `authorize(…, 'read', { type: 'profile', … })`, called per row by
 *                 `features/organizations/queries.ts`. RLS is row-level: it can grant or
 *                 deny a row but cannot hide `email` and `phone` inside one. That half is
 *                 ours alone, it is the half with no second layer behind it, and it is
 *                 what this file proves.
 *
 * So the fake client here is deliberately *more permissive than the database*: it hands
 * back every row in the organization to every role, including rows RLS would have
 * refused. If the column projection depended on RLS having filtered first, these tests
 * would fail — which is exactly the regression worth catching.
 */

import { describe, expect, it } from 'vitest';

import { listInvitations, listMembers, MEMBER_SELECT } from '@/features/organizations/queries';
import { MEMBER_ROLES, type MemberRole } from '@shared/index';

import { createFakeClient, type RecordedQuery } from './_support/fake-postgrest';
import { membershipFor, ORG_A, ORGANIZATIONS } from './_support/principals';

/** One membership row per role, each with a populated profile. */
function rosterRows() {
  return MEMBER_ROLES.map((role, index) => {
    const membership = membershipFor('A', role);
    return {
      id: membership.memberId,
      organization_id: ORG_A,
      profile_id: membership.profile.id,
      role,
      status: 'active',
      created_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      profiles: {
        id: membership.profile.id,
        full_name: membership.profile.fullName,
        email: `${role}@example.test`,
        phone: '+971500000000',
      },
    };
  });
}

function clientReturningRoster() {
  return createFakeClient({
    onQuery: (query: RecordedQuery) =>
      query.table === 'organization_members' ? { data: rosterRows() } : { data: [], count: 0 },
  });
}

/* ------------------------------------------------------- column visibility -- */

describe('profile columns are projected by role, not by row filtering', () => {
  /**
   * The §4 matrix row for `profiles`:
   *   organization_admin / property_manager / property_owner  R self + same-org
   *   tenant / service_provider                               R self only
   */
  const seesEveryProfile: readonly MemberRole[] = [
    'organization_admin',
    'property_manager',
    'property_owner',
  ];

  for (const role of seesEveryProfile) {
    it(`${role} reads contact details for every same-organization profile`, async () => {
      const { client } = clientReturningRoster();
      const page = await listMembers(client, membershipFor('A', role));

      expect(page.items).toHaveLength(MEMBER_ROLES.length);
      for (const member of page.items) {
        expect(member.profile).not.toBeNull();
        expect(member.profile?.email).toMatch(/@example\.test$/);
      }
    });
  }

  for (const role of ['tenant', 'service_provider'] as const) {
    it(`${role} reads no profile but their own, even when the row is handed to them`, async () => {
      const membership = membershipFor('A', role);
      const { client } = clientReturningRoster();
      const page = await listMembers(client, membership);

      // Every row arrives — the fake client is more generous than RLS would be.
      expect(page.items).toHaveLength(MEMBER_ROLES.length);

      const own = page.items.filter((m) => m.profile_id === membership.profile.id);
      const others = page.items.filter((m) => m.profile_id !== membership.profile.id);

      expect(own).toHaveLength(1);
      expect(own[0]?.profile?.email).toBe(`${role}@example.test`);

      expect(others).toHaveLength(MEMBER_ROLES.length - 1);
      for (const other of others) {
        // Not "email is undefined" — the whole embedded profile is withheld, so a
        // future field added to MemberProfileSchema cannot leak through this path.
        expect(other.profile).toBeNull();
      }
    });
  }

  it('withholds every profile from a member whose status is not active', async () => {
    const membership = membershipFor('A', 'organization_admin', { status: 'disabled' });
    const { client } = clientReturningRoster();
    const page = await listMembers(client, membership);

    for (const member of page.items) expect(member.profile).toBeNull();
  });

  it('withholds every profile when the organization is suspended', async () => {
    const base = membershipFor('A', 'organization_admin');
    const membership = {
      ...base,
      organization: { ...base.organization, status: 'suspended' as const },
    };
    const { client } = clientReturningRoster();
    const page = await listMembers(client, membership);

    for (const member of page.items) expect(member.profile).toBeNull();
  });

  it('withholds a profile belonging to another organization', async () => {
    // A row RLS would never return. If it somehow did — a policy regression, a bad
    // embedding — the column layer must still refuse it.
    const { client } = createFakeClient({
      onQuery: () => ({
        data: [
          {
            id: '99999999-aaaa-4111-8aaa-999999999999',
            organization_id: ORGANIZATIONS.B.id,
            profile_id: '88888888-bbbb-4111-8bbb-888888888888',
            role: 'tenant',
            status: 'active',
            created_at: '2026-01-01T00:00:00.000Z',
            profiles: {
              id: '88888888-bbbb-4111-8bbb-888888888888',
              full_name: 'Another organization’s tenant',
              email: 'leak@example.test',
              phone: '+971500000001',
            },
          },
        ],
      }),
    });

    const page = await listMembers(client, membershipFor('A', 'organization_admin'));
    expect(page.items[0]?.profile).toBeNull();
  });
});

/* -------------------------------------------------------------- the query -- */

describe('the roster query itself', () => {
  it('scopes to the caller’s organization on top of RLS', async () => {
    const { client, queries } = clientReturningRoster();
    const membership = membershipFor('A', 'organization_admin');
    await listMembers(client, membership);

    const query = queries[0];
    expect(query?.table).toBe('organization_members');
    expect(query?.filters).toEqual(
      expect.arrayContaining([{ op: 'eq', args: ['organization_id', ORG_A] }]),
    );
  });

  it('projects named columns, never a star', async () => {
    const { client, queries } = clientReturningRoster();
    await listMembers(client, membershipFor('A', 'organization_admin'));

    expect(queries[0]?.columns).toBe(MEMBER_SELECT);
    expect(queries[0]?.columns).not.toContain('*');
  });

  it('embeds profiles with a left join so a withheld profile does not delete the member', () => {
    // `profiles!inner(...)` would drop the row entirely whenever RLS hid the profile,
    // silently turning a column rule into a missing person.
    expect(MEMBER_SELECT).toContain('profiles (');
    expect(MEMBER_SELECT).not.toContain('profiles!inner');
  });

  it('over-fetches by exactly one row to decide has_more', async () => {
    const { client, queries } = clientReturningRoster();
    await listMembers(client, membershipFor('A', 'organization_admin'), { limit: 10 });
    expect(queries[0]?.limit).toBe(11);
  });

  it('defaults to the frozen page size and tolerates a missing limit', async () => {
    const { client, queries } = clientReturningRoster();
    await listMembers(client, membershipFor('A', 'organization_admin'));
    // DEFAULT_PAGE_SIZE is 25 (§5.7), plus the over-fetch row.
    expect(queries[0]?.limit).toBe(26);
  });

  it('returns a cursor only when another page exists', async () => {
    const rows = rosterRows();
    const { client } = createFakeClient({ onQuery: () => ({ data: rows }) });

    const full = await listMembers(client, membershipFor('A', 'organization_admin'), {
      limit: rows.length,
    });
    expect(full.hasMore).toBe(false);
    expect(full.nextCursor).toBeNull();

    const partial = await listMembers(client, membershipFor('A', 'organization_admin'), {
      limit: rows.length - 1,
    });
    expect(partial.hasMore).toBe(true);
    expect(partial.nextCursor).not.toBeNull();
    expect(partial.items).toHaveLength(rows.length - 1);
  });
});

/* ------------------------------------------------------------ invitations -- */

describe('the invitation query', () => {
  it('projects the granted columns and never a star', async () => {
    const { client, queries } = createFakeClient({ onQuery: () => ({ data: [] }) });
    await listInvitations(client, membershipFor('A', 'organization_admin'));

    const columns = queries[0]?.columns ?? '';
    expect(columns).not.toContain('*');
    expect(columns).not.toContain('token_hash');
    expect(columns).toContain('email');
  });

  it('scopes to the caller’s organization', async () => {
    const { client, queries } = createFakeClient({ onQuery: () => ({ data: [] }) });
    await listInvitations(client, membershipFor('A', 'organization_admin'));

    expect(queries[0]?.filters).toEqual(
      expect.arrayContaining([{ op: 'eq', args: ['organization_id', ORG_A] }]),
    );
  });

  it('returns an empty page rather than an error for a role with no policy', async () => {
    // Postgres answers an RLS-denied *read* with zero rows and no error. A 403 here
    // would confirm that invitations exist, which is a disclosure.
    const { client } = createFakeClient({ onQuery: () => ({ data: [] }) });
    const page = await listInvitations(client, membershipFor('A', 'tenant'));

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
