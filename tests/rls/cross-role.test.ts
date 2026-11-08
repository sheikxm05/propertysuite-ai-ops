/**
 * Role boundaries INSIDE one organization. Lane w0-l6, task 6.
 *
 * Cross-organization isolation is the headline, but the subtler half of the goal is
 * that being a member of an organization is not the same as being entitled to its data.
 * A tenant and a property manager are both legitimate members of organization A; the
 * tenant must still be unable to read the manager's view of it.
 *
 * Generated from the §4 matrix in tests/_harness/policy-matrix.ts, which is the
 * specification. Where the matrix says a role may do something, this suite asserts it
 * CAN — a suite that only ever asserts refusals would pass against a database that
 * denies everything, which is not isolation, it is an outage.
 *
 * Mutating cases are deliberately absent here and live where state can be set up
 * safely; see COVERED_ELSEWHERE.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  NO_IN_ORG_NEGATIVE,
  PROBES,
  POLICY_MATRIX,
  ROLES,
  clientFor,
  expectDeleteDenied,
  expectInsertAllowed,
  expectInsertDenied,
  expectNothingVisible,
  expectSelectAllowed,
  expectSelectDenied,
  expectUpdateAllowed,
  expectUpdateDenied,
  getWorld,
  keyForRole,
  org as orgFixture,
  probeColumns,
  TENANT_SCOPED_TABLES,
  type World,
} from '../_harness';
import type { MemberRole, OrgKey } from '../_harness';

let world: World;

beforeAll(async () => {
  world = await getWorld();
});

/**
 * Cells whose assertion needs state the shared fixture cannot safely provide, covered
 * by name in another file. Listed explicitly so the coverage gate still demands them.
 */
const COVERED_ELSEWHERE = new Set<string>([
  // Driving a ticket requires a throwaway ticket at a known status.
  'maintenance_tickets.tenant.update',
  'maintenance_tickets.service_provider.update',
  // Amendment A7 needs a clearly-worded failure when documents.ticket_id is absent.
  'documents.service_provider.select',
  'documents.service_provider.insert',
]);

/** One organization is enough for a role boundary; the other proves nothing new here. */
const ACTOR_ORG: OrgKey = 'A';

for (const table of TENANT_SCOPED_TABLES) {
  const probe = PROBES[table];
  const columns = probeColumns(table);

  describe(`${table} role boundaries`, () => {
    for (const role of ROLES) {
      const spec = POLICY_MATRIX[table][role];
      const f = () => orgFixture(world, ACTOR_ORG);
      const client = () => clientFor(world, ACTOR_ORG, role);
      const actorProfileId = () => f().profiles[keyForRole(ACTOR_ORG, role)] ?? '';
      const ctx = (role_: MemberRole) => ({
        f: f(),
        role: role_,
        actorProfileId: actorProfileId(),
        capabilities: world.fixture.capabilities,
      });
      const tag = (operation: string) => ({
        dimension: 'in_org' as const,
        table,
        role,
        operation,
        policies: [...(spec.policies ?? [])],
      });
      const skip = (operation: string) => COVERED_ELSEWHERE.has(`${table}.${role}.${operation}`);

      /* ------------------------------------------------------------- select -- */

      if (!skip('select')) {
        if (spec.select === 'org') {
          it(`${role} reads any row in its own organization`, async () => {
            const rowId = (probe.orgRow ?? probe.anyRow)(f(), role);
            await expectSelectAllowed(client(), table, rowId, tag('select'), columns);
          });
        }

        if (spec.select === 'scoped') {
          it(`${role} reads the row it is entitled to`, async () => {
            const rowId = probe.inScope(f(), role);
            expect(
              rowId,
              `No in-scope row defined for ${table}/${role}. The matrix grants a scoped ` +
                'read, so the fixture must contain something for this role to read.',
            ).not.toBeNull();
            await expectSelectAllowed(client(), table, String(rowId), tag('select'), columns);
          });

          // `organizations` is the one scoped read with no sibling row to be refused —
          // an organization has exactly one row of itself. policy-matrix.ts records the
          // same exemption so the coverage gate does not demand the impossible.
          if (!NO_IN_ORG_NEGATIVE.has(`${table}.${role}.select`)) {
            it(`${role} cannot read a row in its own organization that is outside its scope`, async () => {
              const rowId = probe.outOfScope(f(), role);
              expect(
                rowId,
                `No out-of-scope row defined for ${table}/${role}. Without one, a policy ` +
                  'that accidentally grants organization-wide read would pass this suite.',
              ).not.toBeNull();
              await expectSelectDenied(client(), table, String(rowId), tag('select'), columns);
            });
          }
        }

        if (spec.select === 'none') {
          it(`${role} sees nothing at all in this table`, async () => {
            await expectNothingVisible(client(), table, tag('select'), columns);
          });
        }
      }

      /* ------------------------------------------------------------- insert -- */

      if (!skip('insert')) {
        if (spec.insert === false) {
          it(`${role} cannot INSERT`, async () => {
            await expectInsertDenied(client(), table, probe.insertRow(ctx(role)), tag('insert'));
          });
        } else {
          it(`${role} can INSERT within its scope`, async () => {
            await expectInsertAllowed(client(), table, probe.insertRow(ctx(role)), tag('insert'));
          });

          const insertOutOfScope = probe.insertOutOfScope;
          if (spec.insert === 'scoped' && insertOutOfScope) {
            it(`${role} cannot INSERT a row outside its scope`, async () => {
              await expectInsertDenied(client(), table, insertOutOfScope(ctx(role)), tag('insert'));
            });
          }
        }
      }

      /* ------------------------------------------------------------- update -- */

      if (!skip('update')) {
        if (spec.update === false) {
          it(`${role} cannot UPDATE`, async () => {
            const rowId = probe.inScope(f(), role) ?? probe.anyRow(f());
            await expectUpdateDenied(client(), table, rowId, probe.patch.patch, tag('update'), {
              verifyWith: clientFor(world, ACTOR_ORG, 'organization_admin'),
              verifyColumn: probe.patch.column,
            });
          });
        } else {
          it(`${role} can UPDATE within its scope`, async () => {
            const rowId =
              spec.update === 'scoped'
                ? probe.inScope(f(), role)
                : (probe.orgRow ?? probe.anyRow)(f(), role);
            expect(rowId, `No updatable row defined for ${table}/${role}`).not.toBeNull();
            // A patch that re-asserts the current value. The policy is exercised; the
            // shared fixture is not disturbed for the files that run after this one.
            const patch = probe.noopPatch ?? probe.patch;
            await expectUpdateAllowed(client(), table, String(rowId), patch.patch, tag('update'));
          });

          if (spec.update === 'scoped') {
            it(`${role} cannot UPDATE a row outside its scope`, async () => {
              const rowId = (probe.writeOutOfScope ?? probe.outOfScope)(f(), role);
              expect(rowId, `No write-negative row defined for ${table}/${role}`).not.toBeNull();
              await expectUpdateDenied(
                client(),
                table,
                String(rowId),
                probe.patch.patch,
                tag('update'),
                {
                  verifyWith: clientFor(world, ACTOR_ORG, 'organization_admin'),
                  verifyColumn: probe.patch.column,
                },
              );
            });
          }
        }
      }

      /* ------------------------------------------------------------- delete -- */

      // §4 grants DELETE to nobody, on any table, in any role. Business records are
      // archived; financial and audit history is append-only (finding 5).
      it(`${role} cannot DELETE`, async () => {
        const rowId = probe.inScope(f(), role) ?? probe.anyRow(f());
        await expectDeleteDenied(client(), table, rowId, tag('delete'), {
          verifyWith: clientFor(world, ACTOR_ORG, 'organization_admin'),
        });
      });
    }
  });
}
