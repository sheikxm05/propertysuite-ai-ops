/**
 * `resolveMemberDisplayNames` — the owner-picker read.
 *
 * The Supabase client is a hand-rolled fake rather than a mock library, because what
 * these tests need to assert is not "was a method called" but *what the query would have
 * carried*: which table, which `organization_id`, which ids, and which columns. A fake
 * that records the chain lets the tests assert the query itself, which is where the
 * security properties live.
 *
 * RLS cannot be simulated here, so it is modelled the only honest way: the fake returns
 * whatever rows the test says the database would return, and the tests assert the
 * application layer behaves correctly both when RLS did its job and when it is pretended
 * to have failed. The RLS half is proven for real by `tests/rls/**`.
 */

import { describe, expect, it, vi } from 'vitest';

import { ApiRouteError } from '@/lib/api/errors';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import { resolveMemberDisplayNames, type Membership } from '../roles';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const PROFILE_SELF = '22222222-2222-2222-2222-222222222222';
const PROFILE_OTHER = '2222aaaa-2222-2222-2222-222222222222';
const MEMBER_SELF = '33333333-3333-3333-3333-333333333333';
const MEMBER_OTHER = '3333aaaa-3333-3333-3333-333333333333';

interface Recorded {
  table: string | null;
  select: string | null;
  eq: [string, unknown][];
  in: [string, readonly string[]][];
}

interface FakeRow {
  id: string;
  role: string;
  organization_id: string;
  profiles: { id: string; full_name: string } | null;
}

/** A Supabase client stand-in that records the query it was asked to build. */
function fakeClient(result: {
  data: FakeRow[] | null;
  error: { code?: string; message?: string } | null;
}): { client: AppSupabaseClient; recorded: Recorded } {
  const recorded: Recorded = { table: null, select: null, eq: [], in: [] };

  const builder = {
    select(columns: string) {
      recorded.select = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      recorded.eq.push([column, value]);
      return builder;
    },
    in(column: string, values: readonly string[]) {
      recorded.in.push([column, values]);
      return Promise.resolve(result);
    },
  };

  const client = {
    from(table: string) {
      recorded.table = table;
      return builder;
    },
  } as unknown as AppSupabaseClient;

  return { client, recorded };
}

function membershipFor(role: Membership['role'], overrides: Partial<Membership> = {}): Membership {
  return {
    memberId: MEMBER_SELF,
    role,
    status: 'active',
    profile: { id: PROFILE_SELF, authUserId: 'auth-user-1', fullName: 'Self Person' },
    organization: { id: ORG_A, name: 'Organization A', slug: 'org-a', status: 'active' },
    tenantId: role === 'tenant' ? '44444444-4444-4444-4444-444444444444' : null,
    providerId: role === 'service_provider' ? '55555555-5555-5555-5555-555555555555' : null,
    ...overrides,
  };
}

const selfRow: FakeRow = {
  id: MEMBER_SELF,
  role: 'tenant',
  organization_id: ORG_A,
  profiles: { id: PROFILE_SELF, full_name: 'Self Person' },
};

const otherRow: FakeRow = {
  id: MEMBER_OTHER,
  role: 'property_owner',
  organization_id: ORG_A,
  profiles: { id: PROFILE_OTHER, full_name: 'Other Person' },
};

function uuidBatch(count: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  );
}

describe('the happy path', () => {
  it('resolves several members in a single query', async () => {
    const { client, recorded } = fakeClient({ data: [selfRow, otherRow], error: null });

    const names = await resolveMemberDisplayNames(client, membershipFor('property_manager'), [
      MEMBER_SELF,
      MEMBER_OTHER,
    ]);

    expect(recorded.table).toBe('organization_members');
    expect(recorded.in).toHaveLength(1);
    expect(names.get(MEMBER_SELF)).toEqual({ fullName: 'Self Person', role: 'tenant' });
    expect(names.get(MEMBER_OTHER)).toEqual({ fullName: 'Other Person', role: 'property_owner' });
  });

  it('deduplicates ids before querying', async () => {
    const { client, recorded } = fakeClient({ data: [selfRow], error: null });
    await resolveMemberDisplayNames(client, membershipFor('property_manager'), [
      MEMBER_SELF,
      MEMBER_SELF,
      MEMBER_SELF,
    ]);
    expect(recorded.in[0]?.[1]).toEqual([MEMBER_SELF]);
  });

  it('does not query at all for an empty list', async () => {
    const { client, recorded } = fakeClient({ data: [], error: null });
    const names = await resolveMemberDisplayNames(client, membershipFor('property_manager'), []);
    expect(names.size).toBe(0);
    expect(recorded.table).toBeNull();
  });
});

describe('the projection — name and role only', () => {
  it('never returns an email or phone key', async () => {
    const leaky: FakeRow = {
      ...otherRow,
      // Pretend the row arrived wider than it was asked for.
      profiles: {
        id: PROFILE_OTHER,
        full_name: 'Other Person',
        email: 'other.person@example.com',
        phone: '+971501234567',
      } as unknown as FakeRow['profiles'],
    };
    const { client } = fakeClient({ data: [leaky], error: null });

    const names = await resolveMemberDisplayNames(client, membershipFor('property_manager'), [
      MEMBER_OTHER,
    ]);

    const entry = names.get(MEMBER_OTHER);
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual(['fullName', 'role']);

    const serialised = JSON.stringify(Array.from(names.entries()));
    expect(serialised).not.toContain('email');
    expect(serialised).not.toContain('phone');
    expect(serialised).not.toContain('other.person@example.com');
    expect(serialised).not.toContain('971501234567');
  });

  it('asks the database for full_name only, never contact columns', async () => {
    const { client, recorded } = fakeClient({ data: [selfRow], error: null });
    await resolveMemberDisplayNames(client, membershipFor('property_manager'), [MEMBER_SELF]);

    const select = recorded.select ?? '';
    expect(select).toContain('full_name');
    expect(select).not.toContain('email');
    expect(select).not.toContain('phone');
  });
});

describe('a tenant sees only themselves', () => {
  it('returns nothing for another member, even when the row comes back', async () => {
    // Models an RLS regression: the database handed back a row it should have withheld.
    // The per-row authorize() check must drop it anyway.
    const { client } = fakeClient({ data: [otherRow], error: null });

    const names = await resolveMemberDisplayNames(client, membershipFor('tenant'), [MEMBER_OTHER]);

    expect(names.size).toBe(0);
    expect(names.get(MEMBER_OTHER)).toBeUndefined();
  });

  it('still returns their own name', async () => {
    const { client } = fakeClient({ data: [selfRow], error: null });
    const names = await resolveMemberDisplayNames(client, membershipFor('tenant'), [MEMBER_SELF]);
    expect(names.get(MEMBER_SELF)).toEqual({ fullName: 'Self Person', role: 'tenant' });
  });

  it('applies the same rule to a service provider', async () => {
    const { client } = fakeClient({ data: [selfRow, otherRow], error: null });
    const names = await resolveMemberDisplayNames(client, membershipFor('service_provider'), [
      MEMBER_SELF,
      MEMBER_OTHER,
    ]);
    expect(Array.from(names.keys())).toEqual([MEMBER_SELF]);
  });

  it('lets a property owner read same-organization names', async () => {
    const { client } = fakeClient({ data: [otherRow], error: null });
    const names = await resolveMemberDisplayNames(client, membershipFor('property_owner'), [
      MEMBER_OTHER,
    ]);
    expect(names.get(MEMBER_OTHER)?.fullName).toBe('Other Person');
  });
});

describe('organization scoping', () => {
  it('pins organization_id to the trusted membership', async () => {
    const { client, recorded } = fakeClient({ data: [], error: null });
    await resolveMemberDisplayNames(client, membershipFor('property_manager'), [MEMBER_OTHER]);
    expect(recorded.eq).toContainEqual(['organization_id', ORG_A]);
  });

  it('drops a row from another organization even if the query returned one', async () => {
    const foreign: FakeRow = { ...otherRow, organization_id: ORG_B };
    const { client } = fakeClient({ data: [foreign], error: null });
    const names = await resolveMemberDisplayNames(client, membershipFor('organization_admin'), [
      MEMBER_OTHER,
    ]);
    expect(names.size).toBe(0);
  });
});

describe('bounds and input hygiene', () => {
  it('refuses a batch larger than the frozen maximum page size', async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(
      resolveMemberDisplayNames(client, membershipFor('property_manager'), uuidBatch(101)),
    ).rejects.toThrow(ApiRouteError);
  });

  it('accepts a batch exactly at the maximum', async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(
      resolveMemberDisplayNames(client, membershipFor('property_manager'), uuidBatch(100)),
    ).resolves.toBeInstanceOf(Map);
  });

  it('drops a non-uuid id before it can reach the filter string', async () => {
    // `.in()` serialises to `id=in.(a,b)`; a value with a comma or paren would break out.
    const { client, recorded } = fakeClient({ data: [selfRow], error: null });
    await resolveMemberDisplayNames(client, membershipFor('property_manager'), [
      MEMBER_SELF,
      'x,y)',
      'drop table profiles',
    ]);
    expect(recorded.in[0]?.[1]).toEqual([MEMBER_SELF]);
  });

  it('does not query when every id was malformed', async () => {
    const { client, recorded } = fakeClient({ data: [], error: null });
    const names = await resolveMemberDisplayNames(client, membershipFor('property_manager'), [
      'not-a-uuid',
    ]);
    expect(names.size).toBe(0);
    expect(recorded.table).toBeNull();
  });
});

describe('degradation', () => {
  it('returns an empty map and logs on a query failure, rather than throwing', async () => {
    const { client } = fakeClient({ data: null, error: { code: '42501', message: 'denied' } });
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      requestId: 'r1',
    };

    const names = await resolveMemberDisplayNames(
      client,
      membershipFor('property_manager'),
      [MEMBER_OTHER],
      logger,
    );

    expect(names.size).toBe(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({
      reason: 'member_display_name_query_failed',
      pg_code: '42501',
    });
  });

  it('tolerates an absent logger', async () => {
    const { client } = fakeClient({ data: null, error: { code: 'X', message: 'y' } });
    await expect(
      resolveMemberDisplayNames(client, membershipFor('property_manager'), [MEMBER_OTHER]),
    ).resolves.toEqual(new Map());
  });

  it('skips a row whose profile embedding came back null', async () => {
    const { client } = fakeClient({ data: [{ ...otherRow, profiles: null }], error: null });
    const names = await resolveMemberDisplayNames(client, membershipFor('property_manager'), [
      MEMBER_OTHER,
    ]);
    expect(names.size).toBe(0);
  });
});
