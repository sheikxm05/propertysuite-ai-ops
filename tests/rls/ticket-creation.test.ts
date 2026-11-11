/**
 * Ticket creation — acceptance criterion 5. Lane w0-l6.
 *
 * This file exists because of a defect that execution found and static reading did not.
 *
 * On the first live apply, `insert into maintenance_tickets` failed for every
 * authenticated role with `42P17: infinite recursion detected in policy for relation
 * "maintenance_tickets"`. No tenant could file a maintenance request at all, so
 * criterion 5 was broken outright — and nothing in the suite noticed, because the
 * cross-role INSERT case asserted only that the tenant's own insert SUCCEEDS, while a
 * recursion error is still an error and the strict SQLSTATE check lives on the DENY
 * path. A denial for the wrong reason is the failure mode this harness is built to
 * catch; this was its mirror image, a *rejection* for the wrong reason.
 *
 * The cause was a policy cycle, not a policy mistake. The ticket INSERT policy tested
 * the unit with an inline `EXISTS` over `property_units`; that subquery is itself
 * subject to `property_units` RLS; and `property_units_select_provider` reads
 * `maintenance_tickets` to find out which units a provider is working in. Postgres
 * therefore had to evaluate the ticket policy to evaluate the ticket policy. The fix in
 * 0002 is the `unit_belongs_to_property` security-definer helper, which breaks the cycle
 * by stepping outside RLS for that one structural question.
 *
 * Two lessons are encoded here deliberately:
 *   - a bare SELECT on either table was fine, so only the INSERT path reveals the
 *     cycle. Reading the policies would not have found it; running them did.
 *   - a recursion failure is asserted against BY CODE, so it can never again hide
 *     behind a generic "the insert was refused" expectation.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  clientFor,
  getWorld,
  org as orgFixture,
  recordCoverage,
  recordPass,
  type Row,
  type World,
} from '../_harness';

let world: World;

/** `infinite recursion detected in policy for relation ...` */
const RECURSION = '42P17';

beforeAll(async () => {
  world = await getWorld();
});

const ticketFor = (overrides: Row): Row => ({
  id: randomUUID(),
  title: 'Air conditioning not cooling',
  description: 'Filed by the isolation suite.',
  category: 'hvac',
  priority: 'normal',
  status: 'open',
  source: 'web',
  ...overrides,
});

describe('a tenant can file a request for their own unit', () => {
  it('succeeds, and specifically does not hit a policy cycle', async () => {
    const f = orgFixture(world, 'A');
    const { data, error } = await clientFor(world, 'A', 'tenant').insert(
      'maintenance_tickets',
      ticketFor({
        organization_id: f.organizationId,
        property_id: f.properties.p1,
        property_unit_id: f.units.p1u1,
        tenancy_id: f.tenancies.tc1,
        tenant_id: f.tenants.t1,
      }),
    );

    // Checked first and by code, because this is the failure that shipped once.
    expect(
      error?.code,
      'The ticket INSERT policy is recursive again. A policy that reads a table whose ' +
        'own policy reads this one cannot be evaluated, so NO authenticated user can ' +
        'create a ticket and acceptance criterion 5 is broken. Keep the structural unit ' +
        'check inside a security-definer helper (unit_belongs_to_property) rather than ' +
        'an inline EXISTS over property_units.',
    ).not.toBe(RECURSION);

    expect(
      error,
      `a tenant could not file a request for their own leased unit: ${error?.code} ` +
        `${error?.message}`,
    ).toBeNull();
    expect((data ?? []).length, 'the insert returned no row').toBe(1);

    recordCoverage({
      dimension: 'in_org',
      table: 'maintenance_tickets',
      role: 'tenant',
      operation: 'insert',
      outcome: 'allow',
      policies: ['maintenance_tickets_insert_tenant'],
      label: 'own leased unit',
    });
  });

  it('staff can file on a tenant`s behalf without hitting the cycle either', async () => {
    const f = orgFixture(world, 'A');
    const { error } = await clientFor(world, 'A', 'property_manager').insert(
      'maintenance_tickets',
      ticketFor({
        organization_id: f.organizationId,
        property_id: f.properties.p2,
        property_unit_id: f.units.p2u1,
        tenancy_id: f.tenancies.tc3,
        tenant_id: f.tenants.t2,
      }),
    );
    expect(error?.code, 'the staff INSERT policy is recursive').not.toBe(RECURSION);
    expect(error, `a manager could not file a ticket: ${error?.message}`).toBeNull();
    recordPass({ dimension: 'integrity', label: 'staff ticket creation works' }, 'allow');
  });

  it('reading the two tables involved in the cycle still works', async () => {
    // The regression was INSERT-only: a plain SELECT on either table was unaffected, so
    // a suite that only reads would have reported everything as healthy.
    const f = orgFixture(world, 'A');
    const tenant = clientFor(world, 'A', 'tenant');

    const tickets = await tenant.select('maintenance_tickets', { columns: 'id' });
    expect(tickets.error, `tenant ticket SELECT failed: ${tickets.error?.message}`).toBeNull();

    const units = await tenant.select('property_units', { columns: 'id' });
    expect(units.error, `tenant unit SELECT failed: ${units.error?.message}`).toBeNull();

    // And the same two reads as a provider, whose policy is the other half of the cycle.
    const provider = clientFor(world, 'A', 'service_provider');
    const providerUnits = await provider.select('property_units', {
      columns: 'id',
      eq: { id: f.units.p1u1 },
    });
    expect(
      providerUnits.error,
      `provider unit SELECT failed: ${providerUnits.error?.message}`,
    ).toBeNull();

    recordPass({ dimension: 'integrity', label: 'no policy cycle on the read paths' }, 'allow');
  });
});

describe('a tenant cannot file a request outside their tenancy', () => {
  const denied = async (label: string, row: Row, note: string): Promise<void> => {
    const { error } = await clientFor(world, 'A', 'tenant').insert('maintenance_tickets', row);

    expect(error, `${label}: the insert was accepted. ${note}`).not.toBeNull();
    expect(error?.code, `${label}: refused by a policy cycle rather than by the policy`).not.toBe(
      RECURSION,
    );

    recordCoverage({
      dimension: 'in_org',
      table: 'maintenance_tickets',
      role: 'tenant',
      operation: 'insert',
      outcome: 'deny',
      policies: ['maintenance_tickets_insert_tenant'],
      label,
    });
  };

  it('a unit/property pair that does not belong together is refused', async () => {
    // Both ids are real and both are in the caller's organization; only the pairing is
    // wrong. This is the case the security-definer helper answers, and it is also the
    // shape of an attempt to attach a request to a building the caller can see but has
    // no tenancy in.
    const f = orgFixture(world, 'A');
    await denied(
      'mismatched unit and property',
      ticketFor({
        organization_id: f.organizationId,
        property_id: f.properties.p2,
        property_unit_id: f.units.p1u1,
        tenancy_id: f.tenancies.tc1,
        tenant_id: f.tenants.t1,
      }),
      'A unit of property P1 was accepted while the ticket claimed property P2, so the ' +
        'ticket`s property_id is not trustworthy and every owner-scoped read built on ' +
        'it is wrong.',
    );
  });

  it('a unit the caller does not lease is refused', async () => {
    const f = orgFixture(world, 'A');
    await denied(
      'unit not leased by the caller',
      ticketFor({
        organization_id: f.organizationId,
        property_id: f.properties.p1,
        property_unit_id: f.units.p1u2,
        tenancy_id: f.tenancies.tc2,
        tenant_id: f.tenants.t2,
      }),
      'A tenant filed a request against the neighbouring apartment, in another ' + 'tenant`s name.',
    );
  });

  it('a unit in the other organization is refused', async () => {
    const a = orgFixture(world, 'A');
    const b = orgFixture(world, 'B');
    await denied(
      'unit in the other organization',
      ticketFor({
        organization_id: a.organizationId,
        property_id: b.properties.p1,
        property_unit_id: b.units.p1u1,
        tenant_id: a.tenants.t1,
      }),
      'The isolation boundary was crossed by a ticket insert.',
    );
  });

  it('filing in the caller`s own name but against someone else`s unit is refused', async () => {
    // tenant_id is the caller's own, so a policy that checked only "is this my tenant
    // record?" would accept it. The unit has to be checked too.
    const f = orgFixture(world, 'A');
    await denied(
      'own tenant_id, another tenant`s unit',
      ticketFor({
        organization_id: f.organizationId,
        property_id: f.properties.p1,
        property_unit_id: f.units.p1u2,
        tenancy_id: f.tenancies.tc1,
        tenant_id: f.tenants.t1,
      }),
      'The tenant_id check passed on its own and the unit was never verified.',
    );
  });

  it('a service provider cannot create a ticket at all', async () => {
    // The matrix gives a provider no INSERT on tickets: work is assigned to them, never
    // invented by them. A provider who could file tickets could bill for them.
    const f = orgFixture(world, 'A');
    const { error } = await clientFor(world, 'A', 'service_provider').insert(
      'maintenance_tickets',
      ticketFor({
        organization_id: f.organizationId,
        property_id: f.properties.p1,
        property_unit_id: f.units.p1u1,
        tenancy_id: f.tenancies.tc1,
        tenant_id: f.tenants.t1,
      }),
    );
    expect(error, 'a service provider created a maintenance ticket').not.toBeNull();
    expect(error?.code, 'refused by a policy cycle rather than by the policy').not.toBe(RECURSION);
    recordCoverage({
      dimension: 'in_org',
      table: 'maintenance_tickets',
      role: 'service_provider',
      operation: 'insert',
      outcome: 'deny',
      policies: ['maintenance_tickets_insert_staff'],
      label: 'provider cannot create',
    });
  });
});
