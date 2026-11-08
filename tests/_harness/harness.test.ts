/**
 * Harness self-tests. Lane w0-l6.
 *
 * These run with no database and no Docker, and they guard the two things that would
 * otherwise make the isolation suite quietly incomplete:
 *
 *   - the table list drifting behind the migrations, so a table added later never gets
 *     a cross-organization test;
 *   - scripts/make-jwts.mjs changing shape, so the TypeScript facade over it silently
 *     narrows to `undefined` and every client turns out to be unauthenticated.
 *
 * Deliberately NOT in tests/rls: these are unit tests of the harness and belong in the
 * default `npm test` run, where they protect the suite even when nobody has Docker up.
 */

import { describe, expect, it } from 'vitest';
import {
  TENANT_SCOPED_TABLES,
  TABLES_WITH_ORGANIZATION_ID,
  migrationFiles,
  parsePolicies,
  parseRevokes,
  parseRlsEnabledTables,
  parseTablesWithOrganizationId,
} from './tables';
import { loadJwtFactory, REQUIRED_FACTORY_EXPORTS } from './jwt-factory';
import { pathTo } from './scratch';

describe('migration parsing', () => {
  it('finds the migrations', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toMatch(/^0001_/);
  });

  it('every table with an organization_id column is in the registry', () => {
    const parsed = parseTablesWithOrganizationId();
    expect(parsed.length).toBeGreaterThan(0);
    const missing = parsed.filter((t) => !(TENANT_SCOPED_TABLES as readonly string[]).includes(t));
    expect(
      missing,
      'A table carrying organization_id has no entry in TENANT_SCOPED_TABLES, so the ' +
        'cross-organization suite never touches it. Add it to tests/_harness/tables.ts ' +
        'and give it a probe.',
    ).toEqual([]);
  });

  it('every table any migration enables RLS on is in the registry', () => {
    const rlsTables = parseRlsEnabledTables().filter((t) => t !== 'jobs');
    const missing = rlsTables.filter(
      (t) => !(TENANT_SCOPED_TABLES as readonly string[]).includes(t),
    );
    expect(missing, 'RLS is enabled on a table the suite does not test').toEqual([]);
  });

  it('every registry table has RLS enabled by some migration', () => {
    const rlsTables = new Set(parseRlsEnabledTables());
    const unprotected = TENANT_SCOPED_TABLES.filter((t) => !rlsTables.has(t));
    expect(
      unprotected,
      'A tenant-scoped table with no `enable row level security`. In 0001 this is true ' +
        'of organizations and profiles — findings 1 and 2 — and 0002 is what closes it.',
    ).toEqual([]);
  });

  it('grants no DELETE policy on any tenant-scoped table', () => {
    const deletePolicies = parsePolicies().filter(
      (p) =>
        p.command === 'delete' && (TENANT_SCOPED_TABLES as readonly string[]).includes(p.table),
    );
    expect(
      deletePolicies.map((p) => `${p.table}:${p.name}`),
      'docs/implementation-plan.md §4: no DELETE is granted on any table. Archive instead.',
    ).toEqual([]);
  });

  it('uses no `for all` policy on a tenant-scoped table', () => {
    // Finding 5: a `for all` policy grants DELETE as a side effect of granting write.
    const forAll = parsePolicies().filter(
      (p) => p.command === 'all' && (TENANT_SCOPED_TABLES as readonly string[]).includes(p.table),
    );
    expect(
      forAll.map((p) => `${p.table}:${p.name} (${p.file})`),
      'A `for all` policy silently grants DELETE (finding 5). Per-operation policies only.',
    ).toEqual([]);
  });

  it('revokes UPDATE and DELETE on maintenance_activities from client roles', () => {
    // Finding 6: "immutable by omission of a policy" is not immutability.
    const revokes = parseRevokes().filter((r) => r.table === 'maintenance_activities');
    const privileges = new Set(revokes.flatMap((r) => r.privileges));
    const covers = (p: string) => privileges.has(p) || privileges.has('all');
    expect(covers('update'), 'UPDATE is not revoked on maintenance_activities').toBe(true);
    expect(covers('delete'), 'DELETE is not revoked on maintenance_activities').toBe(true);
  });

  it('excludes organizations and profiles from the organization_id-keyed set', () => {
    expect(TABLES_WITH_ORGANIZATION_ID).not.toContain('organizations');
    expect(TABLES_WITH_ORGANIZATION_ID).not.toContain('profiles');
  });
});

describe('principal catalog', () => {
  it('exports everything the harness facade narrows to', async () => {
    const factory = await loadJwtFactory();
    const missing = REQUIRED_FACTORY_EXPORTS.filter(
      (name) => (factory as unknown as Record<string, unknown>)[name] === undefined,
    );
    expect(
      missing,
      'scripts/make-jwts.mjs no longer exports what tests/_harness/jwt-factory.ts ' +
        'declares. The facade would silently hand every test an undefined client.',
    ).toEqual([]);
  });

  it('describes exactly ten core principals: five roles x two organizations', async () => {
    const { PRINCIPALS, CORE_PRINCIPALS } = await loadJwtFactory();

    expect(CORE_PRINCIPALS).toHaveLength(10);

    for (const org of ['A', 'B'] as const) {
      const roles = CORE_PRINCIPALS.filter((p) => p.org === org).map((p) => p.role);
      expect(new Set(roles).size, `organization ${org} must cover five distinct roles`).toBe(5);
    }

    // The secondary tenants exist so "a tenant cannot read another tenant's row" is
    // asserted from a real second session rather than inferred.
    expect(PRINCIPALS.filter((p) => !p.core)).toHaveLength(2);
  });

  it('gives every principal a distinct identity and deterministic ids', async () => {
    const { PRINCIPALS, fixtureId } = await loadJwtFactory();

    const emails = PRINCIPALS.map((p) => p.email);
    expect(new Set(emails).size, 'duplicate email: two principals would share a session').toBe(
      emails.length,
    );

    const profileIds = PRINCIPALS.map((p) => p.profileId);
    expect(new Set(profileIds).size).toBe(profileIds.length);

    const memberIds = PRINCIPALS.map((p) => p.memberId);
    expect(new Set(memberIds).size).toBe(memberIds.length);

    // Deterministic ids are what make re-seeding an upsert rather than a duplicate.
    expect(fixtureId('A:property:1')).toBe(fixtureId('A:property:1'));
    expect(fixtureId('A:property:1')).not.toBe(fixtureId('B:property:1'));
    expect(fixtureId('A:property:1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('separates the two organizations by slug and by id', async () => {
    const { ORGANIZATIONS, fixtureId } = await loadJwtFactory();
    expect(ORGANIZATIONS.A.slug).not.toBe(ORGANIZATIONS.B.slug);
    expect(fixtureId('A:organization')).not.toBe(fixtureId('B:organization'));
  });

  it('refuses a non-local stack unless that is made explicit', async () => {
    const { resolveStackCredentials } = await loadJwtFactory();
    const saved = { ...process.env };
    try {
      process.env.SUPABASE_URL = 'https://some-project.supabase.co';
      process.env.SUPABASE_ANON_KEY = 'anon';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
      delete process.env.PS_ALLOW_REMOTE_STACK;
      expect(() => resolveStackCredentials({ allowStatusProbe: false })).toThrow(/non-local/i);
    } finally {
      process.env = saved;
    }
  });
});

describe('scratch ticket paths', () => {
  it('walks only legal edges to each reachable status', () => {
    expect(pathTo('open')).toEqual([]);
    expect(pathTo('assigned')).toEqual(['assigned']);
    expect(pathTo('in_progress')).toEqual(['assigned', 'in_progress']);
    expect(pathTo('awaiting_approval')).toEqual(['assigned', 'in_progress', 'awaiting_approval']);
    expect(pathTo('completed')).toEqual([
      'assigned',
      'in_progress',
      'awaiting_approval',
      'completed',
    ]);
    expect(pathTo('cancelled')).toEqual(['cancelled']);
  });

  it('refuses to invent a path to an unknown status', () => {
    expect(() => pathTo('reopened')).toThrow(/no legal path/i);
  });
});
