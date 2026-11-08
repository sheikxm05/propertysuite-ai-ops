import { describe, expect, it } from 'vitest';

import { MEMBER_ROLES, type MemberRole } from '../constants/roles';
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_TICKET_STATUSES,
  TICKET_STATUSES,
  allowedTransitionsFor,
  canTransition,
  comparePriority,
  isAllowedTransition,
  isTerminalTicketStatus,
  maxPriority,
  type TicketStatus,
} from '../constants/ticket-status';

/**
 * The ticket state machine, across the full matrix.
 *
 * The expected set below is transcribed INDEPENDENTLY from the specification
 * prose — `docs/implementation-plan.md` §4 "Ticket state machine" and the
 * amendment A9 ruling — rather than derived from `TRANSITION_ROLES`. Comparing
 * the implementation against itself would pass no matter what it said. Every
 * one of the 6 x 6 x 5 = 180 triples is then checked against this list, so a
 * single misplaced role in the data fails a test by name.
 *
 * The same table is enforced by `public.enforce_ticket_transition()` in
 * `supabase/migrations/0003_domain_integrity.sql`. If the two ever diverge, the
 * database rejects a transition the UI offered. That is why this file
 * enumerates exhaustively instead of spot-checking the happy path.
 */

/** Every (from, to, role) triple the specification permits. Nothing else may be true. */
const EXPECTED_ALLOWED: ReadonlyArray<readonly [TicketStatus, TicketStatus, MemberRole]> = [
  // open -> assigned: staff only. Assignment is a management act.
  ['open', 'assigned', 'organization_admin'],
  ['open', 'assigned', 'property_manager'],
  // open -> cancelled: staff, plus the reporting tenant while nothing has started.
  ['open', 'cancelled', 'organization_admin'],
  ['open', 'cancelled', 'property_manager'],
  ['open', 'cancelled', 'tenant'],
  // assigned -> in_progress: staff, plus the assigned provider.
  ['assigned', 'in_progress', 'organization_admin'],
  ['assigned', 'in_progress', 'property_manager'],
  ['assigned', 'in_progress', 'service_provider'],
  // assigned -> cancelled: staff only. Work may already be scheduled.
  ['assigned', 'cancelled', 'organization_admin'],
  ['assigned', 'cancelled', 'property_manager'],
  // in_progress -> awaiting_approval: staff, plus the assigned provider.
  ['in_progress', 'awaiting_approval', 'organization_admin'],
  ['in_progress', 'awaiting_approval', 'property_manager'],
  ['in_progress', 'awaiting_approval', 'service_provider'],
  // in_progress -> cancelled: staff only.
  ['in_progress', 'cancelled', 'organization_admin'],
  ['in_progress', 'cancelled', 'property_manager'],
  // awaiting_approval -> completed: staff, plus the reporting tenant. Never the provider.
  ['awaiting_approval', 'completed', 'organization_admin'],
  ['awaiting_approval', 'completed', 'property_manager'],
  ['awaiting_approval', 'completed', 'tenant'],
  // awaiting_approval -> in_progress: rework, staff only (amendment A9).
  ['awaiting_approval', 'in_progress', 'organization_admin'],
  ['awaiting_approval', 'in_progress', 'property_manager'],
  // awaiting_approval -> cancelled: staff only.
  ['awaiting_approval', 'cancelled', 'organization_admin'],
  ['awaiting_approval', 'cancelled', 'property_manager'],
];

const expectedKeys = new Set(EXPECTED_ALLOWED.map(([from, to, role]) => `${from}|${to}|${role}`));

describe('ALLOWED_TRANSITIONS', () => {
  it('has an entry for every status, so no status is unreachable from the data', () => {
    for (const status of TICKET_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).toBeDefined();
    }
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...TICKET_STATUSES].sort());
  });

  it('encodes the linear chain, the rework edge and cancellation', () => {
    expect(ALLOWED_TRANSITIONS.open).toEqual(['assigned', 'cancelled']);
    expect(ALLOWED_TRANSITIONS.assigned).toEqual(['in_progress', 'cancelled']);
    expect(ALLOWED_TRANSITIONS.in_progress).toEqual(['awaiting_approval', 'cancelled']);
    expect(ALLOWED_TRANSITIONS.awaiting_approval).toEqual([
      'completed',
      'in_progress',
      'cancelled',
    ]);
  });

  it('leaves terminal states with no outbound edge', () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    for (const status of TERMINAL_TICKET_STATUSES) {
      expect(isTerminalTicketStatus(status)).toBe(true);
      expect(ALLOWED_TRANSITIONS[status]).toHaveLength(0);
    }
  });

  it('allows cancellation from every non-terminal state and from no terminal state', () => {
    for (const status of TICKET_STATUSES) {
      const cancellable = ALLOWED_TRANSITIONS[status].includes('cancelled');
      expect(cancellable).toBe(!isTerminalTicketStatus(status));
    }
  });

  it('never allows a self-transition', () => {
    for (const status of TICKET_STATUSES) {
      expect(ALLOWED_TRANSITIONS[status]).not.toContain(status);
    }
  });

  it('is frozen, so no caller can mutate the shared rule set at runtime', () => {
    expect(Object.isFrozen(ALLOWED_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(ALLOWED_TRANSITIONS.open)).toBe(true);
  });
});

describe('canTransition — full matrix', () => {
  it('agrees with the specification on all 180 (from, to, role) triples', () => {
    const disagreements: string[] = [];

    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        for (const role of MEMBER_ROLES) {
          const key = `${from}|${to}|${role}`;
          const expected = expectedKeys.has(key);
          const actual = canTransition(from, to, role);
          if (actual !== expected) {
            disagreements.push(`${key}: expected ${expected}, got ${actual}`);
          }
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('covers exactly 180 triples, so the matrix really is exhaustive', () => {
    expect(TICKET_STATUSES.length * TICKET_STATUSES.length * MEMBER_ROLES.length).toBe(180);
  });

  it('permits exactly 22 of them', () => {
    const permitted = TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.flatMap((to) =>
        MEMBER_ROLES.filter((role) => canTransition(from, to, role)),
      ),
    );
    expect(permitted).toHaveLength(EXPECTED_ALLOWED.length);
    expect(permitted).toHaveLength(22);
  });
});

describe('canTransition — the security-relevant denials', () => {
  it('never lets a service provider approve its own work', () => {
    expect(canTransition('awaiting_approval', 'completed', 'service_provider')).toBe(false);
  });

  it('never lets a service provider assign, rework or cancel', () => {
    expect(canTransition('open', 'assigned', 'service_provider')).toBe(false);
    expect(canTransition('awaiting_approval', 'in_progress', 'service_provider')).toBe(false);
    for (const from of ['open', 'assigned', 'in_progress', 'awaiting_approval'] as const) {
      expect(canTransition(from, 'cancelled', 'service_provider')).toBe(false);
    }
  });

  it('restricts a service provider to exactly the two edges §4 grants it', () => {
    const providerEdges = TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.filter((to) => canTransition(from, to, 'service_provider')).map(
        (to) => `${from}->${to}`,
      ),
    );
    expect(providerEdges).toEqual(['assigned->in_progress', 'in_progress->awaiting_approval']);
  });

  it('gives a property owner no transition at all — it is read-only on tickets', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        expect(canTransition(from, to, 'property_owner')).toBe(false);
      }
    }
  });

  it('lets a tenant cancel only while the ticket is still open (amendment A9)', () => {
    expect(canTransition('open', 'cancelled', 'tenant')).toBe(true);
    expect(canTransition('assigned', 'cancelled', 'tenant')).toBe(false);
    expect(canTransition('in_progress', 'cancelled', 'tenant')).toBe(false);
    expect(canTransition('awaiting_approval', 'cancelled', 'tenant')).toBe(false);
  });

  it('restricts a tenant to cancelling an open ticket and confirming completion', () => {
    const tenantEdges = TICKET_STATUSES.flatMap((from) =>
      TICKET_STATUSES.filter((to) => canTransition(from, to, 'tenant')).map(
        (to) => `${from}->${to}`,
      ),
    );
    expect(tenantEdges).toEqual(['open->cancelled', 'awaiting_approval->completed']);
  });

  it('restricts rework to staff (amendment A9)', () => {
    expect(canTransition('awaiting_approval', 'in_progress', 'organization_admin')).toBe(true);
    expect(canTransition('awaiting_approval', 'in_progress', 'property_manager')).toBe(true);
    expect(canTransition('awaiting_approval', 'in_progress', 'tenant')).toBe(false);
    expect(canTransition('awaiting_approval', 'in_progress', 'service_provider')).toBe(false);
    expect(canTransition('awaiting_approval', 'in_progress', 'property_owner')).toBe(false);
  });

  it('lets nobody move a ticket out of a terminal state', () => {
    for (const from of TERMINAL_TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        for (const role of MEMBER_ROLES) {
          expect(canTransition(from, to, role)).toBe(false);
        }
      }
    }
  });

  it('lets nobody skip a step in the chain', () => {
    const skips: ReadonlyArray<readonly [TicketStatus, TicketStatus]> = [
      ['open', 'in_progress'],
      ['open', 'awaiting_approval'],
      ['open', 'completed'],
      ['assigned', 'awaiting_approval'],
      ['assigned', 'completed'],
      ['in_progress', 'completed'],
    ];
    for (const [from, to] of skips) {
      expect(isAllowedTransition(from, to)).toBe(false);
      for (const role of MEMBER_ROLES) {
        expect(canTransition(from, to, role)).toBe(false);
      }
    }
  });

  it('lets nobody walk the chain backwards, apart from the rework edge', () => {
    expect(isAllowedTransition('assigned', 'open')).toBe(false);
    expect(isAllowedTransition('in_progress', 'assigned')).toBe(false);
    expect(isAllowedTransition('awaiting_approval', 'in_progress')).toBe(true);
  });
});

describe('isAllowedTransition vs canTransition — the 409/403 split', () => {
  /**
   * The two functions answer different questions and map to different status
   * codes. A legal edge driven by the wrong role must be a 403, not a 409:
   * conflating them would tell a caller that the resource is in the wrong state
   * when in fact they simply lack permission.
   */
  it('separates "illegal edge" from "wrong role"', () => {
    // Legal edge, wrong role -> isAllowedTransition true, canTransition false -> 403.
    expect(isAllowedTransition('awaiting_approval', 'completed')).toBe(true);
    expect(canTransition('awaiting_approval', 'completed', 'service_provider')).toBe(false);

    // Illegal edge for everyone -> isAllowedTransition false -> 409.
    expect(isAllowedTransition('completed', 'open')).toBe(false);
    expect(canTransition('completed', 'open', 'organization_admin')).toBe(false);
  });

  it('never permits a role on an edge that does not exist', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        if (isAllowedTransition(from, to)) continue;
        for (const role of MEMBER_ROLES) {
          expect(canTransition(from, to, role)).toBe(false);
        }
      }
    }
  });

  it('gives every legal edge at least one role that can drive it', () => {
    for (const from of TICKET_STATUSES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        const drivers = MEMBER_ROLES.filter((role) => canTransition(from, to, role));
        expect(drivers.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('allowedTransitionsFor', () => {
  it('returns what the UI should offer a manager on a fresh ticket', () => {
    expect(allowedTransitionsFor('open', 'property_manager')).toEqual(['assigned', 'cancelled']);
  });

  it('returns a single next step for the assigned provider', () => {
    expect(allowedTransitionsFor('assigned', 'service_provider')).toEqual(['in_progress']);
    expect(allowedTransitionsFor('in_progress', 'service_provider')).toEqual([
      'awaiting_approval',
    ]);
    expect(allowedTransitionsFor('awaiting_approval', 'service_provider')).toEqual([]);
  });

  it('offers a manager rework alongside completion', () => {
    expect(allowedTransitionsFor('awaiting_approval', 'property_manager')).toEqual([
      'completed',
      'in_progress',
      'cancelled',
    ]);
  });

  it('offers a tenant only completion at the approval step', () => {
    expect(allowedTransitionsFor('awaiting_approval', 'tenant')).toEqual(['completed']);
  });

  it('offers nothing on a terminal ticket, to any role', () => {
    for (const status of TERMINAL_TICKET_STATUSES) {
      for (const role of MEMBER_ROLES) {
        expect(allowedTransitionsFor(status, role)).toEqual([]);
      }
    }
  });

  it('agrees with canTransition for every status and role', () => {
    for (const from of TICKET_STATUSES) {
      for (const role of MEMBER_ROLES) {
        const offered = allowedTransitionsFor(from, role);
        for (const to of TICKET_STATUSES) {
          expect(offered.includes(to)).toBe(canTransition(from, to, role));
        }
      }
    }
  });
});

describe('priority ordering helpers', () => {
  it('orders priorities low < normal < high < urgent', () => {
    expect(comparePriority('low', 'normal')).toBe(-1);
    expect(comparePriority('normal', 'normal')).toBe(0);
    expect(comparePriority('urgent', 'high')).toBe(1);
    expect(comparePriority('low', 'urgent')).toBe(-1);
  });

  it('returns the higher of two priorities', () => {
    expect(maxPriority('low', 'urgent')).toBe('urgent');
    expect(maxPriority('high', 'normal')).toBe('high');
    expect(maxPriority('normal', 'normal')).toBe('normal');
  });
});
