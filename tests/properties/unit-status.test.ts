/**
 * The unit status machine.
 *
 * The graph itself is asserted edge by edge, including every edge that must NOT exist —
 * a state machine test that only checks the happy transitions proves nothing, because an
 * implementation that allows everything passes it.
 *
 * `occupied → inactive` and `inactive → occupied` are the two deliberate omissions, and
 * each has a reason recorded in `features/properties/unit-status.ts`. They are tested
 * explicitly so a later lane cannot "fix" them without a failing test to explain why.
 */

import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import {
  ALLOWED_UNIT_TRANSITIONS,
  DEFAULT_UNIT_STATUS,
  UNIT_ARCHIVED_STATUS,
  assertUnitTransition,
  canTransitionUnit,
  isUnitStatus,
  nextUnitStatuses,
} from '@/features/properties/unit-status';
import { UNIT_STATUSES, type UnitStatus } from '@shared/index';

describe('the status vocabulary comes from packages/shared', () => {
  it('covers every status the database permits and no others', () => {
    expect(Object.keys(ALLOWED_UNIT_TRANSITIONS).sort()).toEqual([...UNIT_STATUSES].sort());
  });

  it('matches the DDL default and names the archive state', () => {
    expect(DEFAULT_UNIT_STATUS).toBe('available');
    expect(UNIT_ARCHIVED_STATUS).toBe('inactive');
    expect(UNIT_STATUSES).toContain(UNIT_ARCHIVED_STATUS);
  });

  it('has no destructive value, because a unit has no delete path', () => {
    for (const status of UNIT_STATUSES) {
      expect(status).not.toMatch(/delete|removed|purge/i);
    }
  });
});

describe('canTransitionUnit', () => {
  const allowed: Array<[UnitStatus, UnitStatus]> = [
    ['available', 'occupied'],
    ['available', 'inactive'],
    ['occupied', 'available'],
    ['inactive', 'available'],
  ];

  const refused: Array<[UnitStatus, UnitStatus]> = [
    // An occupied unit cannot be taken out of service: the tenancy would point at an
    // archived unit. Release it first.
    ['occupied', 'inactive'],
    // A unit must be returned to service deliberately, not as a side effect of a tenancy.
    ['inactive', 'occupied'],
  ];

  it.each(allowed)('allows %s -> %s', (from, to) => {
    expect(canTransitionUnit(from, to)).toBe(true);
    expect(nextUnitStatuses(from)).toContain(to);
  });

  it.each(refused)('refuses %s -> %s', (from, to) => {
    expect(canTransitionUnit(from, to)).toBe(false);
    expect(nextUnitStatuses(from)).not.toContain(to);
  });

  it('allows a status that does not change, so an unrelated PATCH is not a conflict', () => {
    for (const status of UNIT_STATUSES) {
      expect(canTransitionUnit(status, status)).toBe(true);
    }
  });

  it('exhaustively matches the allowed/refused tables above', () => {
    // Every ordered pair is accounted for: four allowed edges, two refused, three
    // identities. Nothing is left untested by accident.
    const pairs = UNIT_STATUSES.flatMap((from) => UNIT_STATUSES.map((to) => [from, to] as const));
    expect(pairs).toHaveLength(9);

    for (const [from, to] of pairs) {
      const expected =
        from === to || allowed.some(([a, b]) => a === from && b === to) ? true : false;
      expect(canTransitionUnit(from, to)).toBe(expected);
    }
  });

  it('fails closed on a status the application does not recognise', () => {
    // `property_units.status` is a `text` column, so the generated row type is `string`.
    // A value written outside the application must grant no transitions at all.
    expect(isUnitStatus('decommissioned')).toBe(false);
    expect(canTransitionUnit('decommissioned', 'available')).toBe(false);
    expect(nextUnitStatuses('decommissioned')).toEqual([]);
  });
});

describe('assertUnitTransition', () => {
  it('is silent on a legal edge', () => {
    expect(() => assertUnitTransition('available', 'occupied')).not.toThrow();
  });

  it('raises CONFLICT 409 on an illegal edge, matching the ticket machine', () => {
    try {
      assertUnitTransition('occupied', 'inactive');
      throw new Error('expected assertUnitTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      const api = error as ApiRouteError;
      expect(api.code).toBe('CONFLICT');
      expect(api.status).toBe(409);
      // Both states are the client's own values, so naming them discloses nothing.
      expect(api.publicMessage).toContain('occupied');
      expect(api.publicMessage).toContain('inactive');
      expect(api.logFields.reason).toBe('unit_status_transition_invalid');
    }
  });

  it('puts no row identifier in the message or the log fields', () => {
    try {
      assertUnitTransition('inactive', 'occupied');
    } catch (error) {
      const api = error as ApiRouteError;
      expect(JSON.stringify(api.logFields)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });
});
