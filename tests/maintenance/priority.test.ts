/**
 * Business hours and the priority policy as this lane uses it.
 *
 * `resolvePriority()` itself is lane w0-l4's and has its own suite in
 * `packages/shared/__tests__/priority.test.ts`. What is tested here is the lane's
 * contribution: the clock reader it feeds the policy, and the three places this lane
 * calls the policy — creation, a category change, and triage at assignment.
 *
 * The property worth restating, because the whole point of using `resolvePriority()`
 * rather than `ticket.priority = body.priority` rests on it: a REQUEST alone can never
 * produce `urgent`. A tenant marking everything urgent raises the priority by at most
 * one step above the category baseline and no higher than `high`.
 */

import { describe, expect, it } from 'vitest';
import {
  BASELINE_PRIORITY_BY_CATEGORY,
  MAINTENANCE_CATEGORIES,
  TICKET_PRIORITIES,
  resolvePriority,
} from '@shared/index';

import {
  BUSINESS_DAYS,
  BUSINESS_HOUR_CLOSE,
  BUSINESS_HOUR_OPEN,
  GULF_STANDARD_TIME_OFFSET_HOURS,
  isOutsideBusinessHours,
  isWithinBusinessHours,
  toGulfStandardTime,
} from '@/features/maintenance/domain';

import { INSIDE_BUSINESS_HOURS, OUTSIDE_BUSINESS_HOURS } from './_support/fixtures';

describe('business hours are a fixed UTC+4 offset', () => {
  it('reads the wall clock without consulting the host time zone', () => {
    // 06:00Z is 10:00 in Dubai. If this ever depended on the host zone it would differ
    // between a developer laptop and a UTC CI runner, and the out-of-hours escalation
    // would be environment-dependent.
    expect(toGulfStandardTime(new Date('2026-11-02T06:00:00Z'))).toEqual({
      weekday: 1,
      hour: 10,
    });
    expect(GULF_STANDARD_TIME_OFFSET_HOURS).toBe(4);
  });

  it('is Monday to Friday', () => {
    expect([...BUSINESS_DAYS]).toEqual([1, 2, 3, 4, 5]);
    // Saturday and Sunday, 10:00 Dubai.
    expect(isWithinBusinessHours(new Date('2026-11-07T06:00:00Z'))).toBe(false);
    expect(isWithinBusinessHours(new Date('2026-11-08T06:00:00Z'))).toBe(false);
  });

  it('opens at 08:00 and closes at 18:00 Dubai time', () => {
    expect(BUSINESS_HOUR_OPEN).toBe(8);
    expect(BUSINESS_HOUR_CLOSE).toBe(18);
    // Monday: 07:59, 08:00, 17:59, 18:00 Dubai.
    expect(isWithinBusinessHours(new Date('2026-11-02T03:59:00Z'))).toBe(false);
    expect(isWithinBusinessHours(new Date('2026-11-02T04:00:00Z'))).toBe(true);
    expect(isWithinBusinessHours(new Date('2026-11-02T13:59:00Z'))).toBe(true);
    expect(isWithinBusinessHours(new Date('2026-11-02T14:00:00Z'))).toBe(false);
  });

  it('crosses midnight correctly — 21:00Z Sunday is 01:00 Monday in Dubai', () => {
    const local = toGulfStandardTime(new Date('2026-11-01T21:00:00Z'));
    expect(local).toEqual({ weekday: 1, hour: 1 });
    expect(isWithinBusinessHours(new Date('2026-11-01T21:00:00Z'))).toBe(false);
  });

  it('is the exact complement of isOutsideBusinessHours', () => {
    for (const instant of [INSIDE_BUSINESS_HOURS, OUTSIDE_BUSINESS_HOURS]) {
      expect(isOutsideBusinessHours(instant)).toBe(!isWithinBusinessHours(instant));
    }
  });
});

describe('a request can never reach urgent on its own', () => {
  for (const category of MAINTENANCE_CATEGORIES) {
    it(`category ${category}, request urgent, occupied, in hours`, () => {
      const decision = resolvePriority(
        { suggested_priority: 'urgent' },
        {
          category,
          hasActiveTenancy: true,
          outsideBusinessHours: isOutsideBusinessHours(INSIDE_BUSINESS_HOURS),
          currentPriority: null,
        },
      );
      expect(decision.priority).not.toBe('urgent');
      expect(TICKET_PRIORITIES.indexOf(decision.priority)).toBeLessThanOrEqual(
        TICKET_PRIORITIES.indexOf('high'),
      );
    });
  }

  it('caps a suggestion at one step above the category baseline', () => {
    const decision = resolvePriority(
      { suggested_priority: 'urgent' },
      {
        category: 'cleaning',
        hasActiveTenancy: true,
        outsideBusinessHours: false,
        currentPriority: null,
      },
    );
    // `cleaning` baselines at `low`, so one step is `normal` — not `high` and not
    // `urgent`, however loudly the request asks.
    expect(BASELINE_PRIORITY_BY_CATEGORY.cleaning).toBe('low');
    expect(decision.priority).toBe('normal');
    expect(decision.suggestionCapped).toBe(true);
  });

  it('records the capping so the timeline can show request versus decision', () => {
    const decision = resolvePriority(
      { suggested_priority: 'urgent' },
      {
        category: 'hvac',
        hasActiveTenancy: true,
        outsideBusinessHours: false,
        currentPriority: null,
      },
    );
    expect(decision.suggestedPriority).toBe('urgent');
    expect(decision.reasons).toContain('model_suggestion_capped');
  });
});

describe('the escalations this lane supplies from trusted facts', () => {
  it('escalates an out-of-hours report on an occupied, safety-sensitive unit', () => {
    const inHours = resolvePriority(null, {
      category: 'plumbing',
      hasActiveTenancy: true,
      outsideBusinessHours: isOutsideBusinessHours(INSIDE_BUSINESS_HOURS),
      currentPriority: null,
    });
    const outOfHours = resolvePriority(null, {
      category: 'plumbing',
      hasActiveTenancy: true,
      outsideBusinessHours: isOutsideBusinessHours(OUTSIDE_BUSINESS_HOURS),
      currentPriority: null,
    });
    expect(inHours.priority).toBe('normal');
    expect(outOfHours.priority).toBe('high');
    expect(outOfHours.reasons).toContain('out_of_hours_escalation');
  });

  it('does not escalate out of hours on a non-safety-sensitive category', () => {
    const decision = resolvePriority(null, {
      category: 'cleaning',
      hasActiveTenancy: true,
      outsideBusinessHours: true,
      currentPriority: null,
    });
    expect(decision.priority).toBe('low');
  });

  it('escalates a repeat failure, which this lane counts from rows', () => {
    const decision = resolvePriority(null, {
      category: 'hvac',
      hasActiveTenancy: true,
      recurringOpenTickets: 2,
      outsideBusinessHours: false,
      currentPriority: null,
    });
    expect(decision.reasons).toContain('recurring_failure_escalation');
    expect(decision.priority).toBe('high');
  });

  it('caps a vacant unit at normal, however the category baselines', () => {
    const decision = resolvePriority(null, {
      category: 'electrical',
      hasActiveTenancy: false,
      outsideBusinessHours: true,
      currentPriority: null,
    });
    expect(decision.priority).toBe('normal');
    expect(decision.reasons).toContain('vacant_unit_cap');
  });
});

describe('re-running the policy never de-escalates a human decision', () => {
  it('keeps a staff-set urgent through a category change', () => {
    // This is what makes it safe for `patchTicket` to re-run the policy when the
    // category changes: `currentPriority` is a floor, so the worst case is no change.
    const decision = resolvePriority(null, {
      category: 'cleaning',
      hasActiveTenancy: true,
      outsideBusinessHours: false,
      currentPriority: 'urgent',
    });
    expect(decision.priority).toBe('urgent');
    expect(decision.reasons).toContain('no_downgrade_floor');
  });

  it('keeps a priority through triage at assignment', () => {
    const decision = resolvePriority(null, {
      category: 'hvac',
      hasActiveTenancy: true,
      outsideBusinessHours: false,
      currentPriority: 'high',
    });
    expect(decision.priority).toBe('high');
  });
});
