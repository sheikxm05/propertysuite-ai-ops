/**
 * Cross-organization isolation. Lane w0-l6, task 5.
 *
 * The central claim of the whole project: Organization A provably cannot reach
 * Organization B's data. Not "has no UI for it" — cannot, at the database level, with a
 * real signed-in session and a hand-crafted request.
 *
 * Generated from the table registry rather than hand-written, so a table added in a
 * later sprint cannot slip through without a test (tests/_harness/tables.ts parses the
 * migrations and harness.test.ts fails if the registry falls behind).
 *
 * Every assertion runs as a REAL authenticated principal. The service-role client
 * appears nowhere below; it seeded the world and that is all. An assertion made with it
 * would pass against a database with no policies whatsoever.
 *
 * The two organizations hold deliberately identical-looking data — same property names,
 * same unit numbers, same tenant names, same ticket titles. So a leak cannot be spotted
 * by eye, and every assertion compares identifiers.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  PROBES,
  ROLES,
  assertProbeCoverage,
  clientFor,
  expectDeleteDenied,
  expectInsertDenied,
  expectSelectDenied,
  expectUpdateDenied,
  getWorld,
  keyForRole,
  org as orgFixture,
  otherOrg,
  probeColumns,
  recordPass,
  TENANT_SCOPED_TABLES,
  type World,
} from '../_harness';
import type { MemberRole, OrgKey } from '../_harness';

let world: World;

beforeAll(async () => {
  assertProbeCoverage();
  world = await getWorld();
});

/**
 * A→B for every role, plus B→A for the two privileged roles. One direction proves the
 * policy; the reverse direction proves the policy is not accidentally asymmetric — a
 * predicate written with the organization hard-coded the wrong way round would pass in
 * one direction only.
 */
const DIRECTIONS: { actor: OrgKey; target: OrgKey; roles: readonly MemberRole[] }[] = [
  { actor: 'A', target: 'B', roles: ROLES },
  { actor: 'B', target: 'A', roles: ['organization_admin', 'property_manager'] },
];

for (const table of TENANT_SCOPED_TABLES) {
  const probe = PROBES[table];
  const columns = probeColumns(table);

  describe(`${table} across the organization boundary`, () => {
    for (const { actor, target, roles } of DIRECTIONS) {
      for (const role of roles) {
        const who = `${role} of organization ${actor}`;
        const tag = (operation: string) => ({
          dimension: 'cross_org' as const,
          table,
          role,
          operation,
          policies: [] as string[],
        });

        it(`${who} cannot SELECT organization ${target}'s row`, async () => {
          const client = clientFor(world, actor, role);
          const rowId = probe.anyRow(orgFixture(world, target));
          await expectSelectDenied(client, table, rowId, tag('select'), columns);
        });

        it(`${who} cannot INSERT into organization ${target}`, async () => {
          const client = clientFor(world, actor, role);
          const row = probe.insertRow({
            f: orgFixture(world, target),
            role,
            // The attacker's own profile: the realistic shape of the attack, and what
            // `uploaded_by = current_profile_id()` style checks actually see.
            actorProfileId: orgFixture(world, actor).profiles[keyForRole(actor, role)] ?? '',
            capabilities: world.fixture.capabilities,
          });
          await expectInsertDenied(client, table, row, tag('insert'));
        });

        it(`${who} cannot UPDATE organization ${target}'s row`, async () => {
          const client = clientFor(world, actor, role);
          const rowId = probe.anyRow(orgFixture(world, target));
          await expectUpdateDenied(client, table, rowId, probe.patch.patch, tag('update'), {
            // Verified by an authenticated admin of the TARGET organization: the only
            // principal entitled to see the row, and still not the service role.
            verifyWith: clientFor(world, target, 'organization_admin'),
            verifyColumn: probe.patch.column,
          });
        });

        it(`${who} cannot DELETE organization ${target}'s row`, async () => {
          const client = clientFor(world, actor, role);
          const rowId = probe.anyRow(orgFixture(world, target));
          await expectDeleteDenied(client, table, rowId, tag('delete'), {
            verifyWith: clientFor(world, target, 'organization_admin'),
          });
        });
      }
    }
  });
}

describe('the boundary holds for filters as well as for row ids', () => {
  it('filtering by the other organization_id returns nothing, for every role', async () => {
    for (const actor of ['A', 'B'] as const) {
      const target = otherOrg(actor);
      const targetOrgId = orgFixture(world, target).organizationId;

      for (const role of ROLES) {
        const client = clientFor(world, actor, role);
        for (const table of TENANT_SCOPED_TABLES) {
          if (table === 'organizations' || table === 'profiles') continue; // no such column
          const { data, error } = await client.select(table, {
            columns: 'id',
            eq: { organization_id: targetOrgId },
          });

          if (error) {
            // A revoked grant (audit_logs, organization_invitations) is a denial too.
            // Anything else — a deadlock, a timeout — is contention, not a policy
            // decision, and must not be read as one.
            expect(
              /permission denied|row-level security/i.test(error.message),
              `${table}: ${role} of ${actor} got ${error.code ?? '-'}: ${error.message}. ` +
                'That is not an authorization refusal, so it says nothing about ' +
                'isolation. 40P01/57014 mean another session is holding locks — check ' +
                'for a leftover psql process or an idle-in-transaction backend.',
            ).toBe(true);
          } else {
            expect(
              data ?? [],
              `${table}: ${role} of organization ${actor} enumerated rows of organization ` +
                `${target} by filtering on organization_id. This is the leak the project ` +
                'exists to prevent.',
            ).toEqual([]);
          }
        }
      }
    }
    recordPass({ dimension: 'integrity', label: 'organization_id filter enumeration' });
  });

  it('a row id from the other organization never resolves, even unfiltered', async () => {
    // A caller who already knows an identifier — from a log, a URL, a screenshot — must
    // still get nothing. This is the IDOR shape of the same attack.
    for (const role of ROLES) {
      const client = clientFor(world, 'A', role);
      const b = orgFixture(world, 'B');
      const targets: [string, string][] = [
        ['properties', b.properties.p1],
        ['property_units', b.units.p1u1],
        ['tenants', b.tenants.t1],
        ['tenancies', b.tenancies.tc1],
        ['maintenance_tickets', b.tickets.k1],
        ['documents', b.documents.d1],
      ];
      for (const [table, id] of targets) {
        const { data } = await client.select(table, { columns: 'id', eq: { id } });
        expect(
          data ?? [],
          `${table}: ${role} of organization A resolved organization B's row by id`,
        ).toEqual([]);
      }
    }
    recordPass({ dimension: 'integrity', label: 'cross-organization IDOR by row id' });
  });
});

describe('an unauthenticated caller', () => {
  it('reads nothing from any tenant-scoped table', async () => {
    for (const table of TENANT_SCOPED_TABLES) {
      const { data, error } = await world.anon.select(table, {
        columns: probeColumns(table),
        limit: 1,
      });
      if (error) {
        expect(
          /permission denied|row-level security|JWT|not authorized/i.test(error.message),
          `${table}: unexpected anonymous error: ${error.message}`,
        ).toBe(true);
      } else {
        expect(data ?? [], `${table}: readable without authentication`).toEqual([]);
      }
    }
    recordPass({ dimension: 'integrity', label: 'anonymous read denied on every table' });
  });
});
