/**
 * The maintenance domain service — the lane's authorization choke point.
 *
 * Read `_support/fake-postgrest.ts` first: the database double records statements and
 * returns canned rows without evaluating a single predicate. So every claim below is
 * either about a thrown decision (the service refused) or about a recorded statement
 * (the service built the right filter, the right patch, the right activity rows). None
 * of them can be satisfied by the double behaving a particular way.
 *
 * What this file deliberately does not claim: that Postgres agrees. The RLS policies,
 * `enforce_ticket_transition()` and the append-only guarantee on
 * `maintenance_activities` are proven against a real database by `tests/rls/**`. At the
 * time of writing, the live project's anon and service_role keys were unavailable, so
 * supabase-js could not authenticate and no live HTTP assertion was possible from this
 * lane. The division is the right one regardless: a feature lane proving its own RLS
 * with its own fixtures is proving its fixtures.
 */

import { describe, expect, it } from 'vitest';
import { CreateTicketSchema } from '@shared/index';

import { ApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import {
  appendActivity,
  assignTicket,
  completeTicket,
  createTicket,
  getTicketDetail,
  listTicketPage,
  patchTicket,
  type MaintenanceContext,
} from '@/features/maintenance/domain';
import type { MemberRole } from '@shared/index';

import { eqValue, fakePostgrest, inValues, type FakePostgrest } from './_support/fake-postgrest';
import { worldResponder, type World } from './_support/world';
import {
  DOCUMENT_ID,
  INSIDE_BUSINESS_HOURS,
  ORG_A,
  OTHER_PROPERTY_ID,
  OTHER_PROVIDER_ID,
  OTHER_TENANT_ID,
  OUTSIDE_BUSINESS_HOURS,
  OWNER_MEMBER_ID,
  PROPERTY_ID,
  PROFILE_ID,
  PROVIDER_ID,
  TENANCY_ID,
  TENANT_ID,
  TICKET_ID,
  UNIT_ID,
  membershipFor,
  silentLogger,
  ticketRow,
} from './_support/fixtures';

/** A service context backed by the double, plus the double itself for assertions. */
function harness(
  role: MemberRole,
  world: World,
  options: { now?: Date; membershipOverrides?: Parameters<typeof membershipFor>[1] } = {},
): { context: MaintenanceContext; db: FakePostgrest } {
  const db = fakePostgrest(worldResponder(world));
  return {
    db,
    context: {
      supabase: db.client as AppSupabaseClient,
      membership: membershipFor(role, options.membershipOverrides ?? {}),
      logger: silentLogger(),
      now: options.now ?? INSIDE_BUSINESS_HOURS,
    },
  };
}

const CREATE_BODY = CreateTicketSchema.parse({
  property_unit_id: UNIT_ID,
  title: 'Air conditioning not cooling',
  description: 'The AC is running but not cooling the room.',
  category: 'hvac',
});

const UNIT = { id: UNIT_ID, property_id: PROPERTY_ID, unit_number: '1203', status: 'occupied' };
const TENANCY = { id: TENANCY_ID, tenant_id: TENANT_ID, status: 'active' };

/* ============================================================== create ==== */

describe('createTicket derives every column a request may not assert', () => {
  it('rejects a body that tries to assert a server-derived column', () => {
    // `.strict()` on the shared schema is the first layer: a mass-assignment attempt is
    // a 400 that shows up in the logs rather than a field silently ignored.
    for (const forbidden of [
      'organization_id',
      'tenant_id',
      'tenancy_id',
      'status',
      'property_id',
    ]) {
      const result = CreateTicketSchema.safeParse({
        ...CREATE_BODY,
        [forbidden]: '11111111-1111-4111-8111-111111111111',
      });
      expect(result.success, forbidden).toBe(false);
    }
  });

  it('takes property_id from the UNIT row, so the pair can never disagree', async () => {
    // The unit the caller named belongs to PROPERTY_ID. A ticket may only ever carry
    // that property, which is what keeps `unit_belongs_to_property()` in the tenant
    // INSERT policy from ever having to reject us.
    const { context, db } = harness('property_manager', { unit: UNIT, tenancy: TENANCY });
    await createTicket(context, CREATE_BODY);

    const insert = db.on('maintenance_tickets', 'insert')[0];
    expect(insert?.values[0]?.property_unit_id).toBe(UNIT_ID);
    expect(insert?.values[0]?.property_id).toBe(PROPERTY_ID);
    expect(insert?.values[0]?.property_id).not.toBe(OTHER_PROPERTY_ID);
  });

  it('pins organization_id to the membership, never to anything in the request', async () => {
    const { context, db } = harness('property_manager', { unit: UNIT, tenancy: TENANCY });
    await createTicket(context, CREATE_BODY);
    expect(db.on('maintenance_tickets', 'insert')[0]?.values[0]?.organization_id).toBe(ORG_A);
  });

  it('always inserts status open and no provider', async () => {
    const { context, db } = harness('property_manager', { unit: UNIT, tenancy: TENANCY });
    await createTicket(context, CREATE_BODY);
    const values = db.on('maintenance_tickets', 'insert')[0]?.values[0];
    expect(values?.status).toBe('open');
    expect(values?.assigned_provider_id).toBeNull();
  });

  it('pins a tenant’s tenancy lookup to their own tenant id', async () => {
    const { context, db } = harness('tenant', { unit: UNIT, tenancy: TENANCY });
    await createTicket(context, CREATE_BODY);

    const tenancyQuery = db.on('tenancies', 'select')[0];
    expect(eqValue(tenancyQuery!, 'tenant_id')).toBe(TENANT_ID);
    expect(eqValue(tenancyQuery!, 'property_unit_id')).toBe(UNIT_ID);
    expect(eqValue(tenancyQuery!, 'status')).toBe('active');
  });

  it('refuses a tenant with no active tenancy on the unit', async () => {
    const { context } = harness('tenant', { unit: UNIT, tenancy: null });
    await expect(createTicket(context, CREATE_BODY)).rejects.toThrow(ApiRouteError);
    await expect(createTicket(context, CREATE_BODY)).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
      status: 422,
    });
  });

  it('refuses a unit the caller cannot see', async () => {
    // RLS returned no row. A 422 says nothing about whether the unit exists.
    const { context } = harness('tenant', { unit: null });
    await expect(createTicket(context, CREATE_BODY)).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a staff create on a unit with no active tenancy', async () => {
    // `maintenance_tickets.tenant_id` is NOT NULL and no request may assert it, so a
    // vacant unit has no reporter to record.
    const { context } = harness('property_manager', { unit: UNIT, tenancy: null });
    await expect(createTicket(context, CREATE_BODY)).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
  });

  it('refuses a tenant-role member with no tenant record', async () => {
    const { context } = harness(
      'tenant',
      { unit: UNIT, tenancy: TENANCY },
      { membershipOverrides: { tenantId: null } },
    );
    await expect(createTicket(context, CREATE_BODY)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  for (const role of ['service_provider', 'property_owner'] as const) {
    it(`refuses a ${role}`, async () => {
      const { context } = harness(role, { unit: UNIT, tenancy: TENANCY });
      await expect(createTicket(context, CREATE_BODY)).rejects.toThrow(AuthorizationDeniedError);
    });
  }

  it('decides priority by policy, not from the request', async () => {
    const { context, db } = harness('tenant', { unit: UNIT, tenancy: TENANCY });
    await createTicket(context, { ...CREATE_BODY, priority: 'urgent' });
    // `hvac` baselines at `normal`; one capped step is `high`. The request asked for
    // `urgent` and did not get it.
    expect(db.on('maintenance_tickets', 'insert')[0]?.values[0]?.priority).toBe('high');
  });

  it('uses the injected clock for the out-of-hours escalation', async () => {
    const inHours = harness(
      'tenant',
      { unit: UNIT, tenancy: TENANCY },
      { now: INSIDE_BUSINESS_HOURS },
    );
    await createTicket(inHours.context, CREATE_BODY);
    expect(inHours.db.on('maintenance_tickets', 'insert')[0]?.values[0]?.priority).toBe('normal');

    const outOfHours = harness(
      'tenant',
      { unit: UNIT, tenancy: TENANCY },
      { now: OUTSIDE_BUSINESS_HOURS },
    );
    await createTicket(outOfHours.context, CREATE_BODY);
    expect(outOfHours.db.on('maintenance_tickets', 'insert')[0]?.values[0]?.priority).toBe('high');
  });

  it('writes exactly one creation activity and no transition row', async () => {
    const { context, db } = harness('tenant', { unit: UNIT, tenancy: TENANCY });
    const result = await createTicket(context, CREATE_BODY);

    const insert = db.on('maintenance_activities', 'insert');
    expect(insert).toHaveLength(1);
    expect(insert[0]?.values).toHaveLength(1);
    expect(insert[0]?.values[0]?.activity_type).toBe('ticket_created');
    expect(insert[0]?.values[0]?.actor_profile_id).toBe(PROFILE_ID);
    expect(result.activities.filter((a) => 'from_status' in a.metadata)).toHaveLength(0);
  });
});

/* =============================================================== patch ==== */

describe('patchTicket enforces the field allowlist', () => {
  it('lets staff set priority directly — an authorized human override', async () => {
    const { context, db } = harness('property_manager', { ticket: ticketRow() });
    await patchTicket(context, TICKET_ID, { priority: 'urgent' });

    expect(db.on('maintenance_tickets', 'update')[0]?.patch).toMatchObject({ priority: 'urgent' });
    const activities = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    expect(activities).toHaveLength(1);
    expect(activities[0]?.activity_type).toBe('priority_changed');
  });

  it('refuses a tenant setting priority', async () => {
    // The deterministic policy exists to withhold exactly this control.
    const { context } = harness('tenant', { ticket: ticketRow() });
    await expect(patchTicket(context, TICKET_ID, { priority: 'urgent' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('lets the reporting tenant correct their own report while it is open', async () => {
    const { context, db } = harness('tenant', { ticket: ticketRow({ status: 'open' }) });
    await patchTicket(context, TICKET_ID, { description: 'It is also leaking water now.' });
    expect(db.on('maintenance_tickets', 'update')[0]?.patch).toMatchObject({
      description: 'It is also leaking water now.',
    });
  });

  it('refuses the reporting tenant once the ticket is assigned', async () => {
    const { context } = harness('tenant', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
    });
    await expect(
      patchTicket(context, TICKET_ID, { description: 'Reworded after the fact.' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a provider editing any ticket field', async () => {
    // A provider may drive a status and append activity rows. Letting them rewrite the
    // description would let them rewrite the complaint they are judged against.
    const { context } = harness('service_provider', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
    });
    for (const patch of [
      { title: 'Nothing wrong here' },
      { description: 'Nothing wrong here at all' },
      { category: 'cleaning' as const },
      { priority: 'low' as const },
    ]) {
      await expect(patchTicket(context, TICKET_ID, patch)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
  });

  it('refuses a property_owner outright — read-only in the matrix', async () => {
    const { context } = harness('property_owner', { ticket: ticketRow() });
    await expect(patchTicket(context, TICKET_ID, { title: 'Renamed' })).rejects.toThrow(
      AuthorizationDeniedError,
    );
  });
});

describe('patchTicket and the state machine', () => {
  it('writes exactly one transition row for a status change', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
    });
    await patchTicket(context, TICKET_ID, { status: 'in_progress' });

    const rows = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    const transitions = rows.filter((row) => {
      const metadata = row.metadata as Record<string, unknown>;
      return 'from_status' in metadata && 'to_status' in metadata;
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.activity_type).toBe('status_changed');
  });

  it('writes one transition row and one priority row when a request does both', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
    });
    await patchTicket(context, TICKET_ID, { status: 'in_progress', priority: 'high' });

    const rows = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((row) => 'from_status' in (row.metadata as Record<string, unknown>)),
    ).toHaveLength(1);
  });

  it('guards the UPDATE on the status it read, so two clicks are one edge', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
    });
    await patchTicket(context, TICKET_ID, { status: 'in_progress' });

    const update = db.on('maintenance_tickets', 'update')[0];
    expect(eqValue(update!, 'status')).toBe('assigned');
    expect(eqValue(update!, 'id')).toBe(TICKET_ID);
    expect(eqValue(update!, 'organization_id')).toBe(ORG_A);
  });

  it('never puts organization_id in the patch', async () => {
    const { context, db } = harness('property_manager', { ticket: ticketRow() });
    await patchTicket(context, TICKET_ID, { title: 'Renamed title' });
    expect(db.on('maintenance_tickets', 'update')[0]?.patch).not.toHaveProperty('organization_id');
  });

  it('turns a no-row UPDATE into a 409 and writes no activity', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
      updated: null,
    });
    await expect(patchTicket(context, TICKET_ID, { status: 'in_progress' })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(db.on('maintenance_activities', 'insert')).toHaveLength(0);
  });

  it('rejects an illegal edge with a 409 before touching the database', async () => {
    const { context, db } = harness('property_manager', { ticket: ticketRow({ status: 'open' }) });
    await expect(patchTicket(context, TICKET_ID, { status: 'completed' })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
    expect(db.on('maintenance_tickets', 'update')).toHaveLength(0);
  });

  it('rejects a legal edge driven by the wrong role with a 403', async () => {
    const { context, db } = harness('service_provider', {
      ticket: ticketRow({ status: 'awaiting_approval', assignedProviderId: PROVIDER_ID }),
    });
    await expect(patchTicket(context, TICKET_ID, { status: 'completed' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(db.on('maintenance_tickets', 'update')).toHaveLength(0);
  });

  it('writes nothing at all when the body matches the stored row', async () => {
    const { context, db } = harness('property_manager', { ticket: ticketRow({ status: 'open' }) });
    const result = await patchTicket(context, TICKET_ID, { status: 'open', priority: 'normal' });
    expect(db.on('maintenance_tickets', 'update')).toHaveLength(0);
    expect(db.on('maintenance_activities', 'insert')).toHaveLength(0);
    expect(result.activities).toEqual([]);
  });

  it('re-runs the priority policy when the category changes', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ category: 'cleaning', priority: 'low' }),
    });
    await patchTicket(context, TICKET_ID, { category: 'electrical' });

    // `electrical` baselines at `high`, so the policy raises it. The floor means it
    // could never have been lowered.
    expect(db.on('maintenance_tickets', 'update')[0]?.patch).toMatchObject({
      category: 'electrical',
      priority: 'high',
    });
    const rows = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    expect(rows.map((row) => row.activity_type)).toEqual(['priority_changed']);
  });

  it('does not override an explicit staff priority with the policy', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ category: 'cleaning', priority: 'low' }),
    });
    await patchTicket(context, TICKET_ID, { category: 'electrical', priority: 'low' });
    expect(db.on('maintenance_tickets', 'update')[0]?.patch).toMatchObject({
      category: 'electrical',
    });
    expect(db.on('maintenance_tickets', 'update')[0]?.patch).not.toHaveProperty('priority');
  });

  it('refuses a ticket the caller cannot see with a 404', async () => {
    const { context } = harness('property_manager', { ticket: null });
    await expect(patchTicket(context, TICKET_ID, { title: 'Renamed title' })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
        status: 404,
      },
    );
  });
});

/* ========================================================= read scoping ==== */

describe('a provider cannot read unassigned or other providers’ work', () => {
  it('refuses a ticket assigned to another provider', async () => {
    const { context } = harness('service_provider', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: OTHER_PROVIDER_ID }),
      property: { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: null },
    });
    await expect(getTicketDetail(context, TICKET_ID)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses an unassigned ticket', async () => {
    const { context } = harness('service_provider', {
      ticket: ticketRow({ status: 'open', assignedProviderId: null }),
      property: { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: null },
    });
    await expect(getTicketDetail(context, TICKET_ID)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses to mutate a ticket assigned to another provider', async () => {
    const { context, db } = harness('service_provider', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: OTHER_PROVIDER_ID }),
    });
    await expect(patchTicket(context, TICKET_ID, { status: 'in_progress' })).rejects.toThrow(
      AuthorizationDeniedError,
    );
    expect(db.on('maintenance_tickets', 'update')).toHaveLength(0);
  });

  it('allows their own assigned ticket', async () => {
    const { context } = harness('service_provider', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
      property: { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: null },
      unit: UNIT,
      tenant: { id: TENANT_ID, full_name: 'A Tenant' },
      provider: {
        id: PROVIDER_ID,
        organization_id: ORG_A,
        company_name: 'Cool Air',
        status: 'active',
      },
    });
    const detail = await getTicketDetail(context, TICKET_ID);
    expect(detail.id).toBe(TICKET_ID);
    expect(detail.available_transitions).toEqual(['in_progress']);
  });

  it('receives the tenant’s NAME ONLY, by projection and not by omission', async () => {
    const { context, db } = harness('service_provider', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
      property: { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: null },
      unit: UNIT,
      tenant: { id: TENANT_ID, full_name: 'A Tenant' },
      provider: {
        id: PROVIDER_ID,
        organization_id: ORG_A,
        company_name: 'Cool Air',
        status: 'active',
      },
    });
    const detail = await getTicketDetail(context, TICKET_ID);

    // The query itself asks for two columns. Row-level security cannot hide a column,
    // so this projection is the only thing standing between a provider and a tenant's
    // email and phone.
    expect(db.on('tenants', 'select')[0]?.columns).toBe('id,full_name');
    expect(Object.keys(detail.tenant ?? {})).toEqual(['id', 'full_name']);
  });
});

describe('a tenant cannot read another tenant’s ticket', () => {
  it('refuses it in application space even if RLS handed the row over', async () => {
    const { context } = harness('tenant', {
      ticket: ticketRow({ tenantId: OTHER_TENANT_ID }),
      property: { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: null },
    });
    await expect(getTicketDetail(context, TICKET_ID)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('returns a 404 for a ticket RLS hid, never a 403', async () => {
    // Absent and inaccessible must be indistinguishable: a 403 would confirm the ticket
    // is real.
    const { context } = harness('tenant', { ticket: null });
    await expect(getTicketDetail(context, TICKET_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('a property_owner is checked against the property row', () => {
  it('is allowed on a property they own', async () => {
    const { context } = harness(
      'property_owner',
      {
        ticket: ticketRow(),
        property: { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: OWNER_MEMBER_ID },
        unit: UNIT,
        tenant: { id: TENANT_ID, full_name: 'A Tenant' },
      },
      { membershipOverrides: { memberId: OWNER_MEMBER_ID } },
    );
    const detail = await getTicketDetail(context, TICKET_ID);
    expect(detail.available_transitions).toEqual([]);
  });

  it('is refused on a property owned by someone else', async () => {
    const { context } = harness('property_owner', {
      ticket: ticketRow(),
      property: { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: 'another-member' },
    });
    await expect(getTicketDetail(context, TICKET_ID)).rejects.toThrow(AuthorizationDeniedError);
  });
});

/* ============================================================== assign ==== */

describe('assignTicket', () => {
  const ACTIVE_PROVIDER = {
    id: PROVIDER_ID,
    organization_id: ORG_A,
    company_name: 'Cool Air',
    status: 'active',
  };

  it('assigns, transitions and re-decides priority in one statement', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'open', priority: 'normal' }),
      provider: ACTIVE_PROVIDER,
    });
    await assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID });

    const update = db.on('maintenance_tickets', 'update')[0];
    expect(update?.patch).toMatchObject({
      assigned_provider_id: PROVIDER_ID,
      status: 'assigned',
      priority: 'normal',
    });
    expect(eqValue(update!, 'status')).toBe('open');
  });

  it('writes exactly one activity row for the assignment', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: ACTIVE_PROVIDER,
    });
    await assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID });

    const rows = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activity_type).toBe('provider_assigned');
    const metadata = rows[0]?.metadata as Record<string, unknown>;
    expect(metadata.from_status).toBe('open');
    expect(metadata.to_status).toBe('assigned');
  });

  it('adds a second NON-transition row when a note is supplied', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: ACTIVE_PROVIDER,
    });
    await assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID, note: 'Call before 9am.' });

    const rows = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((row) => 'from_status' in (row.metadata as Record<string, unknown>)),
    ).toHaveLength(1);
  });

  it('scopes the provider lookup to the caller’s organization', async () => {
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: ACTIVE_PROVIDER,
    });
    await assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID });
    expect(eqValue(db.on('service_providers', 'select')[0]!, 'organization_id')).toBe(ORG_A);
  });

  it('refuses a provider that is not in this organization', async () => {
    // RLS returned no row for the id, which is what a cross-organization provider id
    // looks like from inside.
    const { context, db } = harness('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: null,
    });
    await expect(
      assignTicket(context, TICKET_ID, { provider_id: OTHER_PROVIDER_ID }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', status: 422 });
    expect(db.on('maintenance_tickets', 'update')).toHaveLength(0);
  });

  it('refuses a provider row whose organization does not match, belt and braces', async () => {
    const { context } = harness('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: { ...ACTIVE_PROVIDER, organization_id: '22222222-2222-4222-8222-222222222222' },
    });
    await expect(
      assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
  });

  it('refuses an inactive provider', async () => {
    // `current_provider_id()` returns null for a deactivated provider, so assigning one
    // would create a ticket nobody can see.
    const { context } = harness('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: { ...ACTIVE_PROVIDER, status: 'inactive' },
    });
    await expect(
      assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE' });
  });

  it('refuses reassignment with a 409, because it is not a modelled edge', async () => {
    const { context } = harness('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: OTHER_PROVIDER_ID }),
      provider: ACTIVE_PROVIDER,
    });
    await expect(
      assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID }),
    ).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  it('refuses a tenant with a 403', async () => {
    const { context } = harness('tenant', {
      ticket: ticketRow({ status: 'open' }),
      provider: ACTIVE_PROVIDER,
    });
    await expect(
      assignTicket(context, TICKET_ID, { provider_id: PROVIDER_ID }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});

/* ============================================================ complete ==== */

describe('completeTicket', () => {
  const AWAITING = ticketRow({ status: 'awaiting_approval', assignedProviderId: PROVIDER_ID });
  const BODY = { resolution_summary: 'Replaced the compressor.', confirmed: true as const };

  it('closes the ticket for a manager and writes exactly one activity row', async () => {
    const { context, db } = harness('property_manager', { ticket: AWAITING });
    await completeTicket(context, TICKET_ID, BODY);

    expect(db.on('maintenance_tickets', 'update')[0]?.patch).toEqual({ status: 'completed' });
    const rows = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.activity_type).toBe('completion_confirmed');
    expect(rows[0]?.description).toBe(BODY.resolution_summary);
  });

  it('closes the ticket for the reporting tenant', async () => {
    const { context, db } = harness('tenant', { ticket: AWAITING });
    await completeTicket(context, TICKET_ID, BODY);
    expect(db.on('maintenance_tickets', 'update')[0]?.patch).toEqual({ status: 'completed' });
  });

  it('refuses a tenant who is not the reporter', async () => {
    const { context } = harness('tenant', {
      ticket: ticketRow({
        status: 'awaiting_approval',
        tenantId: OTHER_TENANT_ID,
        assignedProviderId: PROVIDER_ID,
      }),
    });
    await expect(completeTicket(context, TICKET_ID, BODY)).rejects.toThrow(
      AuthorizationDeniedError,
    );
  });

  it('refuses the assigned provider — nobody approves their own work', async () => {
    const { context, db } = harness('service_provider', { ticket: AWAITING });
    await expect(completeTicket(context, TICKET_ID, BODY)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(db.on('maintenance_tickets', 'update')).toHaveLength(0);
  });

  it('refuses a close from the wrong status with a 409', async () => {
    const { context } = harness('property_manager', {
      ticket: ticketRow({ status: 'in_progress' }),
    });
    await expect(completeTicket(context, TICKET_ID, BODY)).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('verifies every evidence id is already attached to THIS ticket', async () => {
    const { context, db } = harness('property_manager', { ticket: AWAITING, evidenceCount: 1 });
    await completeTicket(context, TICKET_ID, { ...BODY, evidence_document_ids: [DOCUMENT_ID] });

    const query = db.on('documents', 'select')[0];
    expect(eqValue(query!, 'ticket_id')).toBe(TICKET_ID);
    expect(eqValue(query!, 'organization_id')).toBe(ORG_A);
    expect(inValues(query!, 'id')).toEqual([DOCUMENT_ID]);
  });

  it('refuses a completion citing evidence that is not attached', async () => {
    const { context, db } = harness('property_manager', { ticket: AWAITING, evidenceCount: 0 });
    await expect(
      completeTicket(context, TICKET_ID, { ...BODY, evidence_document_ids: [DOCUMENT_ID] }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', status: 422 });
    expect(db.on('maintenance_tickets', 'update')).toHaveLength(0);
  });

  it('writes no document row of its own — documents belong to lane w1-l6', async () => {
    const { context, db } = harness('property_manager', { ticket: AWAITING, evidenceCount: 1 });
    await completeTicket(context, TICKET_ID, { ...BODY, evidence_document_ids: [DOCUMENT_ID] });
    expect(db.on('documents', 'insert')).toHaveLength(0);
    expect(db.on('documents', 'update')).toHaveLength(0);
  });

  it('refuses a summary longer than the immutable timeline can hold', async () => {
    // `CompleteTicketSchema` permits 2000 characters and the activity row permits 1000.
    // Truncating would silently shorten a permanent record, so this is a 422.
    const { context } = harness('property_manager', { ticket: AWAITING });
    await expect(
      completeTicket(context, TICKET_ID, { ...BODY, resolution_summary: 'x'.repeat(1001) }),
    ).rejects.toMatchObject({ code: 'UNPROCESSABLE', status: 422 });
  });
});

/* ========================================================== activities ==== */

describe('appendActivity', () => {
  it('appends a comment in the caller’s own name', async () => {
    const { context, db } = harness('service_provider', {
      ticket: ticketRow({ status: 'in_progress', assignedProviderId: PROVIDER_ID }),
    });
    await appendActivity(context, TICKET_ID, {
      activity_type: 'comment_added',
      description: 'Waiting on a part.',
    });

    const rows = db.on('maintenance_activities', 'insert')[0]?.values ?? [];
    expect(rows[0]?.actor_profile_id).toBe(PROFILE_ID);
    expect(rows[0]?.ticket_id).toBe(TICKET_ID);
    expect(rows[0]?.organization_id).toBe(ORG_A);
  });

  it('refuses every server-written activity type with a 422', async () => {
    const { context, db } = harness('property_manager', { ticket: ticketRow() });
    for (const type of [
      'status_changed',
      'provider_assigned',
      'completion_confirmed',
      'ticket_cancelled',
      'priority_changed',
      'ticket_created',
    ] as const) {
      await expect(
        appendActivity(context, TICKET_ID, { activity_type: type, description: 'Forged.' }),
      ).rejects.toMatchObject({ code: 'UNPROCESSABLE', status: 422 });
    }
    expect(db.on('maintenance_activities', 'insert')).toHaveLength(0);
  });

  it('refuses a provider on work that is not theirs', async () => {
    const { context } = harness('service_provider', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: OTHER_PROVIDER_ID }),
    });
    await expect(
      appendActivity(context, TICKET_ID, { activity_type: 'comment_added', description: 'Hello.' }),
    ).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses a tenant on another tenant’s ticket', async () => {
    const { context } = harness('tenant', { ticket: ticketRow({ tenantId: OTHER_TENANT_ID }) });
    await expect(
      appendActivity(context, TICKET_ID, { activity_type: 'comment_added', description: 'Hello.' }),
    ).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses a property_owner — the matrix grants them read only', async () => {
    const { context } = harness('property_owner', { ticket: ticketRow() });
    await expect(
      appendActivity(context, TICKET_ID, { activity_type: 'comment_added', description: 'Hello.' }),
    ).rejects.toThrow(AuthorizationDeniedError);
  });

  it('never issues an UPDATE or DELETE against the activity table', async () => {
    const { context, db } = harness('property_manager', { ticket: ticketRow() });
    await appendActivity(context, TICKET_ID, {
      activity_type: 'comment_added',
      description: 'Noted.',
    });
    expect(db.on('maintenance_activities', 'update')).toHaveLength(0);
    expect(
      db.statements.every((s) => s.kind !== 'update' || s.table !== 'maintenance_activities'),
    ).toBe(true);
  });
});

/* ================================================================ list ==== */

describe('listTicketPage applies the scope to the statement', () => {
  const page = { cursor: undefined, limit: 25 } as const;

  it('pins a provider to their own queue and the permitted statuses', async () => {
    const { context, db } = harness('service_provider', { ticketList: [] });
    await listTicketPage(context, { ...page, limit: 25 });

    const select = db.on('maintenance_tickets', 'select')[0];
    expect(eqValue(select!, 'organization_id')).toBe(ORG_A);
    expect(eqValue(select!, 'assigned_provider_id')).toBe(PROVIDER_ID);
    expect(inValues(select!, 'status')).toEqual(['assigned', 'in_progress', 'awaiting_approval']);
  });

  it('pins a tenant to their own reports', async () => {
    const { context, db } = harness('tenant', { ticketList: [] });
    await listTicketPage(context, { ...page, limit: 25 });
    expect(eqValue(db.on('maintenance_tickets', 'select')[0]!, 'tenant_id')).toBe(TENANT_ID);
  });

  it('issues NO query at all when the scope is impossible', async () => {
    // A provider with no provider record. Not an empty result from a query that could
    // have matched — no query.
    const { context, db } = harness(
      'service_provider',
      { ticketList: [ticketRow()] },
      { membershipOverrides: { providerId: null } },
    );
    const result = await listTicketPage(context, { ...page, limit: 25 });
    expect(db.statements).toHaveLength(0);
    expect(result.items).toEqual([]);
    expect(result.pageInfo.has_more).toBe(false);
    expect(result.pageInfo.next_cursor).toBeNull();
  });

  it('fetches limit + 1 rows so has_more is a fact and not a guess', async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      ticketRow({ id: `3333333${index}-3333-4333-8333-333333333333` }),
    );
    const { context, db } = harness('property_manager', { ticketList: rows });
    const result = await listTicketPage(context, { ...page, limit: 2 });

    expect(db.on('maintenance_tickets', 'select')[0]?.limit).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.pageInfo.has_more).toBe(true);
    expect(result.pageInfo.next_cursor).not.toBeNull();
  });

  it('orders by (created_at desc, id desc) so the keyset is total', async () => {
    const { context, db } = harness('property_manager', { ticketList: [] });
    await listTicketPage(context, { ...page, limit: 25 });
    expect(db.on('maintenance_tickets', 'select')[0]?.order).toEqual([
      { column: 'created_at', ascending: false },
      { column: 'id', ascending: false },
    ]);
  });

  it('applies a cursor as a keyset predicate, with the values quoted', async () => {
    const { context: seed, db: seedDb } = harness('property_manager', {
      ticketList: [ticketRow(), ticketRow({ id: '33333333-3333-4333-8333-333333333334' })],
    });
    const first = await listTicketPage(seed, { ...page, limit: 1 });
    expect(seedDb.on('maintenance_tickets', 'select')).toHaveLength(1);

    const { context, db } = harness('property_manager', { ticketList: [] });
    await listTicketPage(context, { cursor: first.pageInfo.next_cursor!, limit: 1 });

    const or = db.on('maintenance_tickets', 'select')[0]?.or ?? [];
    expect(or).toHaveLength(1);
    expect(or[0]).toContain('created_at.lt."');
    expect(or[0]).toContain(`id.lt."${TICKET_ID}"`);
  });

  it('never selects * — the column list is explicit', async () => {
    const { context, db } = harness('property_manager', { ticketList: [] });
    await listTicketPage(context, { ...page, limit: 25 });
    const columns = db.on('maintenance_tickets', 'select')[0]?.columns ?? '';
    expect(columns).not.toContain('*');
    expect(columns).toContain('organization_id');
  });
});

/* ====================================================== error translation == */

describe('database errors reach the frozen codes', () => {
  it('maps P0001 from the transition trigger to 409', async () => {
    const { context } = harness('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
      errorOn: {
        table: 'maintenance_tickets',
        error: {
          code: 'P0001',
          message:
            'ticket_status_transition_invalid: assigned -> completed is not an allowed transition',
        },
      },
    });
    await expect(patchTicket(context, TICKET_ID, { status: 'in_progress' })).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
    });
  });

  it('maps 42501 — a wrong-role edge or an RLS write denial — to 403', async () => {
    const { context } = harness('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
      errorOn: {
        table: 'maintenance_tickets',
        error: {
          code: '42501',
          message: 'ticket_status_transition_forbidden_for_role: this role may not drive it',
        },
      },
    });
    await expect(patchTicket(context, TICKET_ID, { status: 'in_progress' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });

  it('never leaks a raw Postgres message to the caller', async () => {
    const { context } = harness('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      errorOn: {
        table: 'maintenance_tickets',
        error: { code: 'P0001', message: 'ticket_provider_organization_mismatch: secret row data' },
      },
    });
    try {
      await patchTicket(context, TICKET_ID, { status: 'assigned' });
      expect.unreachable();
    } catch (error) {
      expect((error as ApiRouteError).publicMessage).not.toContain('secret row data');
    }
  });
});
