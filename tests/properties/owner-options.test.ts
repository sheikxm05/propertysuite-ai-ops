/**
 * The owner-association picker and the owner name on the detail page.
 *
 * Both now go through `resolveMemberDisplayNames` in `lib/auth/roles.ts`, which w0-l5
 * added in response to this lane's planning defect — `eslint.config.mjs` restricts the
 * `profiles` table by name to that module, so it is the only place the read is permitted.
 * The helper is the **real** implementation here, including its per-row `authorize()`
 * check, so these tests also prove this lane consumes it without widening what it returns.
 *
 * The behaviour that matters is the degradation path. The helper returns no entry for a
 * profile the §4 matrix says the caller may not read, and that is a correct answer rather
 * than a failure — so the picker must fall back to a role-and-id label instead of throwing
 * or rendering `undefined`.
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * `features/properties/page-data.ts` also exports `resolvePageContext`, which imports
 * `createServerClient` — and that module validates `NEXT_PUBLIC_SUPABASE_ANON_KEY` at
 * import time. This lane has no anon key (see `support/fake-supabase.ts`), so the import
 * would throw before a single test ran.
 *
 * Stubbed, not mocked-away: neither function under test calls it. Both take the Supabase
 * client as a parameter, so the fake is injected directly and `resolveMemberDisplayNames`
 * — the code this file is actually about — runs for real.
 */
vi.mock('@/lib/supabase/server', () => ({
  createServerClient: async () => {
    throw new Error('not used by these tests');
  },
}));

import { listOwnerOptions, resolveOwnerName } from '@/features/properties/page-data';
import { OWNER_ASSOCIABLE_ROLES } from '@/features/properties/authorization';
import { MAX_PAGE_SIZE } from '@shared/index';

import {
  createFakeClient,
  eqValue,
  inValues,
  limitValue,
  queriesFor,
  sequence,
  type Responder,
} from './support/fake-supabase';
import { IDS, MANAGER_A, ORG_A, TENANT_A, memberRow } from './support/world';

function fake(responders: Record<string, Responder>) {
  return createFakeClient(responders);
}

/** The row shape `resolveMemberDisplayNames` selects: the embedded profile, nothing more. */
function displayNameRow(
  overrides: Partial<{ id: string; role: string; profileId: string; fullName: string }> = {},
) {
  return {
    id: overrides.id ?? IDS.a.owner.member,
    role: overrides.role ?? 'property_owner',
    organization_id: ORG_A,
    profiles: {
      id: overrides.profileId ?? IDS.a.owner.profile,
      full_name: overrides.fullName ?? 'Layla Haddad',
    },
  };
}

describe('listOwnerOptions', () => {
  it('offers only active members whose role the write path would accept', async () => {
    const client = fake({
      'organization_members:select': sequence(
        { rows: [memberRow()] },
        { rows: [displayNameRow()] },
      ),
    });

    await listOwnerOptions(client.client, MANAGER_A);

    const [members] = queriesFor(client, 'organization_members', 'select');
    expect(eqValue(members!, 'organization_id')).toBe(ORG_A);
    expect(eqValue(members!, 'status')).toBe('active');
    // The same set `assertOwnerAssociable` enforces, so the picker cannot offer an option
    // the server will refuse with a 422.
    expect(inValues(members!, 'role')).toEqual([...OWNER_ASSOCIABLE_ROLES]);
    expect(inValues(members!, 'role')).not.toContain('tenant');
    expect(inValues(members!, 'role')).not.toContain('service_provider');
    // The frozen §5.7 maximum, which is also the helper's batch cap.
    expect(limitValue(members!)).toBe(MAX_PAGE_SIZE);
  });

  it('labels an option with the resolved display name', async () => {
    const client = fake({
      'organization_members:select': sequence(
        { rows: [memberRow()] },
        { rows: [displayNameRow({ fullName: 'Layla Haddad' })] },
      ),
    });

    const options = await listOwnerOptions(client.client, MANAGER_A);

    expect(options).toEqual([
      { memberId: IDS.a.owner.member, role: 'property_owner', fullName: 'Layla Haddad' },
    ]);
  });

  it('falls back to role and id when the name is withheld', async () => {
    // The helper degrades to an empty map on a failed or empty lookup. The option must
    // still be offerable — the association is valid whether or not the name is readable.
    const client = fake({
      'organization_members:select': sequence({ rows: [memberRow()] }, { rows: [] }),
    });

    const options = await listOwnerOptions(client.client, MANAGER_A);

    expect(options).toEqual([{ memberId: IDS.a.owner.member, role: 'property_owner' }]);
    expect(options[0]).not.toHaveProperty('fullName');
  });

  it('asks for names only for the members it actually listed', async () => {
    const client = fake({
      'organization_members:select': sequence(
        { rows: [memberRow({ id: IDS.a.owner.member }), memberRow({ id: IDS.a.manager.member })] },
        { rows: [displayNameRow()] },
      ),
    });

    await listOwnerOptions(client.client, MANAGER_A);

    const [, names] = queriesFor(client, 'organization_members', 'select');
    expect(inValues(names!, 'id')).toEqual([IDS.a.owner.member, IDS.a.manager.member]);
    expect(eqValue(names!, 'organization_id')).toBe(ORG_A);
  });
});

describe('resolveOwnerName', () => {
  it('returns the name for a staff caller', async () => {
    const client = fake({ 'organization_members:select': () => ({ rows: [displayNameRow()] }) });

    const name = await resolveOwnerName(client.client, MANAGER_A, IDS.a.owner.member);
    expect(name).toBe('Layla Haddad');
  });

  it('issues no query for a property with no owner', async () => {
    const client = fake({});

    expect(await resolveOwnerName(client.client, MANAGER_A, null)).toBeNull();
    expect(client.queries).toHaveLength(0);
  });

  it('withholds another member’s name from a tenant', async () => {
    // The matrix gives a tenant `R self only` on `profiles`. The fake returns the row
    // anyway — the bugged-RLS case — and the helper's per-row `authorize()` drops it, so
    // the page renders an id-based label rather than a neighbour's name.
    const client = fake({
      'organization_members:select': () => ({
        rows: [displayNameRow({ profileId: IDS.a.owner.profile, fullName: 'Layla Haddad' })],
      }),
    });

    const name = await resolveOwnerName(client.client, TENANT_A, IDS.a.owner.member);
    expect(name).toBeNull();
  });

  it('does not return contact details even when the row carries them', async () => {
    // `MemberDisplayName` is `{ fullName, role }` and nothing else. A name picker has no
    // need of an email or a phone number, and this asserts none can leak through.
    const client = fake({
      'organization_members:select': () => ({
        rows: [
          {
            ...displayNameRow(),
            profiles: {
              id: IDS.a.owner.profile,
              full_name: 'Layla Haddad',
              email: 'layla@example.test',
              phone: '+971500000000',
            },
          },
        ],
      }),
    });

    const name = await resolveOwnerName(client.client, MANAGER_A, IDS.a.owner.member);

    expect(name).toBe('Layla Haddad');
    expect(JSON.stringify(name)).not.toContain('@');
    expect(JSON.stringify(name)).not.toContain('+971');
  });
});
