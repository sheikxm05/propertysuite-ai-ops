/**
 * The tenancy lifecycle edge set.
 *
 * Unlike the maintenance ticket machine, this one has **no database trigger behind it**
 * (`ALLOWED_TENANCY_TRANSITIONS`: "advisory only ... enforced server-side in the tenancy
 * service"). `features/tenancies/lifecycle.ts` is therefore the single enforcement point,
 * so the edge set is tested exhaustively here rather than only through a route: every
 * ordered pair of the four statuses is asserted, not just the happy path.
 *
 * The expectation table is written out longhand rather than derived from
 * `ALLOWED_TENANCY_TRANSITIONS` — a test that read the same table the code reads would
 * pass whatever that table said.
 */

import { describe, expect, it } from 'vitest';

import { isApiRouteError } from '@/lib/api/errors';
import { TENANCY_STATUSES, type TenancyStatus } from '@shared/index';

import {
  CREATABLE_TENANCY_STATUSES,
  OCCUPYING_TENANCY_STATUSES,
  asTenancyStatus,
  assertTenancyTransition,
  isTerminalTenancyStatus,
  nextTenancyStatuses,
  occupiesUnit,
} from '@/features/tenancies/lifecycle';

/** Transcribed from `docs/implementation-plan.md` §5 Sprint 5, not from the code. */
const PERMITTED: readonly [TenancyStatus, TenancyStatus][] = [
  ['draft', 'active'],
  ['draft', 'terminated'],
  ['active', 'expired'],
  ['active', 'terminated'],
];

function isPermitted(from: TenancyStatus, to: TenancyStatus): boolean {
  return PERMITTED.some(([f, t]) => f === from && t === to);
}

describe('the edge set', () => {
  it('covers four statuses and no removal state', () => {
    expect([...TENANCY_STATUSES]).toEqual(['draft', 'active', 'expired', 'terminated']);
    expect(TENANCY_STATUSES).not.toContain('deleted');
  });

  it('permits exactly the four documented edges and rejects all twelve others', () => {
    for (const from of TENANCY_STATUSES) {
      for (const to of TENANCY_STATUSES) {
        if (from === to) continue;

        if (isPermitted(from, to)) {
          expect(() => assertTenancyTransition(from, to), `${from} -> ${to}`).not.toThrow();
          expect(assertTenancyTransition(from, to).changed).toBe(true);
        } else {
          expect(() => assertTenancyTransition(from, to), `${from} -> ${to}`).toThrow();
        }
      }
    }
  });

  it('rejects an illegal edge with 409 CONFLICT, as the contract specifies', () => {
    try {
      assertTenancyTransition('expired', 'active');
      throw new Error('expected a rejection');
    } catch (thrown) {
      expect(isApiRouteError(thrown)).toBe(true);
      if (isApiRouteError(thrown)) {
        expect(thrown.code).toBe('CONFLICT');
        expect(thrown.status).toBe(409);
        expect(thrown.logFields).toMatchObject({
          reason: 'tenancy_transition_invalid',
          from_status: 'expired',
          to_status: 'active',
        });
      }
    }
  });

  it('refuses to resurrect a terminated tenancy', () => {
    for (const to of TENANCY_STATUSES) {
      if (to === 'terminated') continue;
      expect(() => assertTenancyTransition('terminated', to)).toThrow();
    }
  });

  it('treats a no-op as permitted but unchanged, so a rent edit need not omit status', () => {
    for (const status of TENANCY_STATUSES) {
      expect(assertTenancyTransition(status, status)).toEqual({ changed: false });
    }
  });

  it('says so when the source state is terminal', () => {
    try {
      assertTenancyTransition('expired', 'terminated');
      throw new Error('expected a rejection');
    } catch (thrown) {
      if (isApiRouteError(thrown)) {
        expect(thrown.publicMessage).toContain('cannot change status');
      }
    }
  });
});

describe('terminal states', () => {
  it('are expired and terminated, and only those', () => {
    expect(isTerminalTenancyStatus('expired')).toBe(true);
    expect(isTerminalTenancyStatus('terminated')).toBe(true);
    expect(isTerminalTenancyStatus('draft')).toBe(false);
    expect(isTerminalTenancyStatus('active')).toBe(false);
  });

  it('offer no next states to the UI', () => {
    expect(nextTenancyStatuses('expired')).toEqual([]);
    expect(nextTenancyStatuses('terminated')).toEqual([]);
    expect([...nextTenancyStatuses('draft')]).toEqual(['active', 'terminated']);
    expect([...nextTenancyStatuses('active')]).toEqual(['expired', 'terminated']);
  });
});

describe('creatable statuses', () => {
  it('are draft and active only', () => {
    expect([...CREATABLE_TENANCY_STATUSES]).toEqual(['draft', 'active']);
  });

  it('exclude the terminal states, so an ending is never created pre-recorded', () => {
    expect(CREATABLE_TENANCY_STATUSES).not.toContain('expired');
    expect(CREATABLE_TENANCY_STATUSES).not.toContain('terminated');
  });
});

describe('occupancy', () => {
  it('is implied by active and by nothing else', () => {
    expect([...OCCUPYING_TENANCY_STATUSES]).toEqual(['active']);
    expect(occupiesUnit('active')).toBe(true);
    expect(occupiesUnit('draft')).toBe(false);
    expect(occupiesUnit('expired')).toBe(false);
    expect(occupiesUnit('terminated')).toBe(false);
  });
});

describe('asTenancyStatus', () => {
  it('narrows every value the check constraint permits', () => {
    for (const status of TENANCY_STATUSES) {
      expect(asTenancyStatus(status)).toBe(status);
    }
  });

  it('fails loudly on a value the migration cannot produce', () => {
    // Schema drift, not client input: guessing a safe default here would mask a
    // migration that no longer matches `TENANCY_STATUSES`.
    try {
      asTenancyStatus('cancelled');
      throw new Error('expected a rejection');
    } catch (thrown) {
      expect(isApiRouteError(thrown)).toBe(true);
      if (isApiRouteError(thrown)) expect(thrown.code).toBe('INTERNAL_ERROR');
    }
  });
});
