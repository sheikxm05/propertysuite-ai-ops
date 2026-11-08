/**
 * The ticket state machine, enforced by the DATABASE. Lane w0-l6, task 8.
 *
 * Driven entirely by `ALLOWED_TRANSITIONS` and `TRANSITION_ROLES` imported from
 * packages/shared, which is the one place the rule lives (§5.4). Nothing about the
 * graph is restated here: the illegal set is derived as "every ordered pair of statuses
 * minus the legal ones", so adding an edge to the shared table automatically moves a
 * case from the illegal suite to the legal one, and the two can never disagree.
 *
 * The claim under test is specifically about the trigger delivered by lane w0-l3, not
 * about the domain service: an attacker with a valid session speaks to PostgREST
 * directly and never runs the application's TypeScript. Both layers must hold
 * independently (docs/implementation-plan.md §1).
 *
 * Each case gets its own throwaway ticket, walked to its starting status with the
 * service-role client. Arriving at the starting state must not depend on the policy
 * being tested, and the shared fixture must survive the file.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  TICKET_STATUSES,
  TRANSITION_ROLES,
  canTransition,
  isAllowedTransition,
  type TicketStatus,
} from '@shared/index';
import {
  TRIGGER_CONFLICT_CODE,
  clientFor,
  createScratchTicket,
  getWorld,
  org as orgFixture,
  readScratchStatus,
  recordCoverage,
  recordPass,
  type World,
} from '../_harness';
import type { MemberRole } from '../_harness';

let world: World;

beforeAll(async () => {
  world = await getWorld();
});

/** Every ordered pair of distinct statuses, partitioned by the shared rule set. */
const EDGES = TICKET_STATUSES.flatMap((from) =>
  TICKET_STATUSES.filter((to) => to !== from).map((to) => ({
    from,
    to,
    legal: isAllowedTransition(from, to),
  })),
);

const ILLEGAL = EDGES.filter((e) => !e.legal);
const LEGAL = EDGES.filter((e) => e.legal);

const recordTicketUpdate = (role: MemberRole, outcome: 'allow' | 'deny', label: string) =>
  recordCoverage({
    dimension: 'in_org',
    table: 'maintenance_tickets',
    role,
    operation: 'update',
    outcome,
    policies:
      role === 'tenant'
        ? ['maintenance_tickets_update_tenant_confirm', 'maintenance_tickets_update_tenant_cancel']
        : role === 'service_provider'
          ? ['maintenance_tickets_update_assigned_provider']
          : ['maintenance_tickets_update_staff'],
    label,
  });

describe('the shared rule set is the specification', () => {
  it('describes a graph with the shape §4 states', () => {
    // Guards against a silently reshaped table making the generated suite vacuous: if
    // ALLOWED_TRANSITIONS were ever emptied, every illegal case below would still pass.
    expect(LEGAL.length, 'no legal edges — the derived illegal suite would prove nothing').toBe(9);
    expect(ILLEGAL.length).toBe(EDGES.length - LEGAL.length);
    expect(ALLOWED_TRANSITIONS.completed, '`completed` is terminal').toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled, '`cancelled` is terminal').toEqual([]);
    expect(isAllowedTransition('awaiting_approval', 'in_progress'), 'rework edge (A9)').toBe(true);
    recordPass({ dimension: 'state_machine', label: 'shared transition table shape' });
  });
});

describe('the database rejects every illegal transition', () => {
  for (const { from, to } of ILLEGAL) {
    it(`${from} -> ${to} is refused, even for an organization admin`, async () => {
      const f = orgFixture(world, 'A');
      const ticketId = await createScratchTicket(world.service, f, { status: from });

      const { error } = await clientFor(world, 'A', 'organization_admin')
        .from('maintenance_tickets')
        .update({ status: to })
        .eq('id', ticketId)
        .select('id');

      expect(
        error,
        `${from} -> ${to} was accepted. The edge is not in ALLOWED_TRANSITIONS, so the ` +
          'trigger must refuse it regardless of who asks.',
      ).not.toBeNull();

      // Amendment A2 maps P0001 to CONFLICT / 409. A different code means the refusal
      // came from somewhere else and the API would report the wrong status.
      expect(
        error?.code,
        `${from} -> ${to} was refused with ${error?.code}: ${error?.message}. The ` +
          `transition trigger should raise ${TRIGGER_CONFLICT_CODE}, which §5.8 A2 maps ` +
          'to CONFLICT 409.',
      ).toBe(TRIGGER_CONFLICT_CODE);

      expect(await readScratchStatus(world.service, ticketId)).toBe(from);
      recordCoverage({
        dimension: 'state_machine',
        table: 'maintenance_tickets',
        operation: 'update',
        outcome: 'deny',
        policies: [],
        label: `${from} -> ${to}`,
      });
    });
  }
});

describe('the database accepts every legal transition', () => {
  // Without these, a trigger that rejected everything would make the suite above pass
  // completely while the product did not work at all.
  for (const { from, to } of LEGAL) {
    it(`${from} -> ${to} succeeds for a permitted role`, async () => {
      const f = orgFixture(world, 'A');
      const permitted = TRANSITION_ROLES[from][to] ?? [];
      expect(permitted.length, `no role may drive ${from} -> ${to}`).toBeGreaterThan(0);

      const ticketId = await createScratchTicket(world.service, f, { status: from });
      const patch: Record<string, unknown> = { status: to };
      if (to === 'assigned') patch.assigned_provider_id = f.providers.sp1;

      const { data, error } = await clientFor(world, 'A', 'organization_admin')
        .from('maintenance_tickets')
        .update(patch)
        .eq('id', ticketId)
        .select('id');

      expect(error, `${from} -> ${to} was refused: ${error?.message}`).toBeNull();
      expect((data ?? []).length, `${from} -> ${to} affected no rows`).toBe(1);
      expect(await readScratchStatus(world.service, ticketId)).toBe(to);

      recordCoverage({
        dimension: 'state_machine',
        table: 'maintenance_tickets',
        operation: 'update',
        outcome: 'allow',
        policies: ['maintenance_tickets_update_staff'],
        label: `${from} -> ${to}`,
      });
      recordTicketUpdate('organization_admin', 'allow', `${from} -> ${to}`);
    });
  }
});

describe('a service provider drives only its own two edges', () => {
  it('moves an assigned ticket to in_progress and then to awaiting_approval', async () => {
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'service_provider');
    const ticketId = await createScratchTicket(world.service, f, {
      status: 'assigned',
      provider: 'sp1',
    });

    for (const to of ['in_progress', 'awaiting_approval'] as const) {
      const { data, error } = await client
        .from('maintenance_tickets')
        .update({ status: to })
        .eq('id', ticketId)
        .select('id');
      expect(error, `provider could not move its own job to ${to}: ${error?.message}`).toBeNull();
      expect((data ?? []).length).toBe(1);
    }

    expect(await readScratchStatus(world.service, ticketId)).toBe('awaiting_approval');
    recordTicketUpdate('service_provider', 'allow', 'assigned -> in_progress -> awaiting_approval');
  });

  it('cannot approve its own work', async () => {
    // §4: only a manager, an admin, or the reporting tenant closes to `completed`. A
    // provider signing off its own job is the self-approval hole.
    const f = orgFixture(world, 'A');
    const ticketId = await createScratchTicket(world.service, f, {
      status: 'awaiting_approval',
      provider: 'sp1',
    });

    expect(canTransition('awaiting_approval', 'completed', 'service_provider')).toBe(false);

    const { data, error } = await clientFor(world, 'A', 'service_provider')
      .from('maintenance_tickets')
      .update({ status: 'completed' })
      .eq('id', ticketId)
      .select('id');

    expect(
      error !== null || (data ?? []).length === 0,
      'a service provider approved its own completion',
    ).toBe(true);
    expect(await readScratchStatus(world.service, ticketId)).toBe('awaiting_approval');
    recordTicketUpdate('service_provider', 'deny', 'awaiting_approval -> completed');
  });

  it('cannot cancel, and cannot send work back to itself as rework', async () => {
    const f = orgFixture(world, 'A');
    for (const [from, to] of [
      ['assigned', 'cancelled'],
      ['in_progress', 'cancelled'],
      ['awaiting_approval', 'in_progress'],
    ] as const) {
      expect(canTransition(from, to, 'service_provider')).toBe(false);

      const ticketId = await createScratchTicket(world.service, f, {
        status: from,
        provider: 'sp1',
      });
      const { data, error } = await clientFor(world, 'A', 'service_provider')
        .from('maintenance_tickets')
        .update({ status: to })
        .eq('id', ticketId)
        .select('id');

      expect(
        error !== null || (data ?? []).length === 0,
        `a service provider drove ${from} -> ${to}, which §4 reserves for staff`,
      ).toBe(true);
      expect(await readScratchStatus(world.service, ticketId)).toBe(from);
    }
    recordTicketUpdate('service_provider', 'deny', 'provider cannot cancel or rework');
  });
});

describe('a tenant may withdraw only while nobody has started', () => {
  it('cancels its own open ticket', async () => {
    const f = orgFixture(world, 'A');
    const ticketId = await createScratchTicket(world.service, f, { status: 'open', tenant: 't1' });

    const { data, error } = await clientFor(world, 'A', 'tenant')
      .from('maintenance_tickets')
      .update({ status: 'cancelled' })
      .eq('id', ticketId)
      .select('id');

    expect(
      error,
      `a tenant could not withdraw their own open request: ${error?.message}`,
    ).toBeNull();
    expect((data ?? []).length).toBe(1);
    recordTicketUpdate('tenant', 'allow', 'open -> cancelled');
  });

  it('cannot cancel once a provider is assigned', async () => {
    // A9: once work is scheduled the cancellation is no longer the tenant's to make.
    const f = orgFixture(world, 'A');
    expect(canTransition('assigned', 'cancelled', 'tenant')).toBe(false);

    const ticketId = await createScratchTicket(world.service, f, {
      status: 'assigned',
      tenant: 't1',
      provider: 'sp1',
    });

    const { data, error } = await clientFor(world, 'A', 'tenant')
      .from('maintenance_tickets')
      .update({ status: 'cancelled' })
      .eq('id', ticketId)
      .select('id');

    expect(
      error !== null || (data ?? []).length === 0,
      'a tenant cancelled a ticket that had already been assigned',
    ).toBe(true);
    expect(await readScratchStatus(world.service, ticketId)).toBe('assigned');
    recordTicketUpdate('tenant', 'deny', 'assigned -> cancelled');
  });

  it('confirms completion of its own ticket', async () => {
    const f = orgFixture(world, 'A');
    expect(canTransition('awaiting_approval', 'completed', 'tenant')).toBe(true);

    const ticketId = await createScratchTicket(world.service, f, {
      status: 'awaiting_approval',
      tenant: 't1',
      provider: 'sp1',
    });

    const { data, error } = await clientFor(world, 'A', 'tenant')
      .from('maintenance_tickets')
      .update({ status: 'completed' })
      .eq('id', ticketId)
      .select('id');

    expect(
      error,
      `the reporting tenant could not confirm completion: ${error?.message}`,
    ).toBeNull();
    expect((data ?? []).length).toBe(1);
    recordTicketUpdate('tenant', 'allow', 'awaiting_approval -> completed');
  });

  it('cannot assign a provider to its own ticket', async () => {
    const f = orgFixture(world, 'A');
    expect(canTransition('open', 'assigned', 'tenant')).toBe(false);

    const ticketId = await createScratchTicket(world.service, f, { status: 'open', tenant: 't1' });
    const { data, error } = await clientFor(world, 'A', 'tenant')
      .from('maintenance_tickets')
      .update({ status: 'assigned', assigned_provider_id: f.providers.sp1 })
      .eq('id', ticketId)
      .select('id');

    expect(
      error !== null || (data ?? []).length === 0,
      'a tenant assigned a contractor, which is a manager`s decision and a cost',
    ).toBe(true);
    expect(await readScratchStatus(world.service, ticketId)).toBe('open');
    recordTicketUpdate('tenant', 'deny', 'open -> assigned');
  });
});

describe('a property owner never drives a ticket', () => {
  it('is refused on every legal edge', async () => {
    // The matrix gives property_owner read-only access to tickets, and TRANSITION_ROLES
    // puts them on no edge at all.
    const f = orgFixture(world, 'A');
    for (const { from, to } of LEGAL) {
      expect(canTransition(from, to, 'property_owner')).toBe(false);

      const ticketId = await createScratchTicket(world.service, f, {
        status: from,
        provider: 'sp1',
      });
      const { data, error } = await clientFor(world, 'A', 'property_owner')
        .from('maintenance_tickets')
        .update({ status: to })
        .eq('id', ticketId)
        .select('id');

      expect(
        error !== null || (data ?? []).length === 0,
        `a property owner drove ${from} -> ${to}`,
      ).toBe(true);
      expect(await readScratchStatus(world.service, ticketId)).toBe(from);
    }
    recordTicketUpdate('property_owner', 'deny', 'owner drives no edge');
  });
});

describe('a terminal ticket stays terminal', () => {
  it('nothing leaves completed or cancelled', async () => {
    const f = orgFixture(world, 'A');
    for (const terminal of ['completed', 'cancelled'] as TicketStatus[]) {
      const ticketId = await createScratchTicket(world.service, f, { status: terminal });
      for (const to of TICKET_STATUSES.filter((s) => s !== terminal)) {
        const { error } = await clientFor(world, 'A', 'organization_admin')
          .from('maintenance_tickets')
          .update({ status: to })
          .eq('id', ticketId)
          .select('id');
        expect(
          error,
          `${terminal} -> ${to} was accepted; terminal must mean terminal`,
        ).not.toBeNull();
      }
      expect(await readScratchStatus(world.service, ticketId)).toBe(terminal);
    }
    recordPass({ dimension: 'state_machine', label: 'terminal statuses have no exit' });
  });
});
