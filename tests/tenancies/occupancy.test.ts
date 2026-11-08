/**
 * The overlap rule and the unit-occupancy rule, exhaustively.
 *
 * No migration in this build declares an exclusion constraint on
 * `(property_unit_id, daterange)`, so `findOverlappingTenancy` is the only thing standing
 * between one unit and two concurrent tenants. The boundary cases are where such a rule
 * actually fails — a lease ending on the 31st and the next starting on the 31st is the
 * one a `<` instead of a `<=` lets through — so every adjacency is covered here rather
 * than a representative sample.
 */

import { describe, expect, it } from 'vitest';
import type { UnitStatus } from '@shared/index';

import {
  addDays,
  asUnitStatus,
  findOverlappingTenancy,
  isExpiringWithin,
  rangesOverlap,
  reconciledUnitStatus,
  todayIsoDate,
  type TenancyInterval,
} from '@/features/tenancies/occupancy';

const UNIT = '66666666-0000-4000-8000-000000000001';
const OTHER_UNIT = '66666666-0000-4000-8000-000000000002';

const existing: TenancyInterval = {
  id: '77777777-0000-4000-8000-000000000001',
  propertyUnitId: UNIT,
  start: '2026-01-01',
  end: '2026-12-31',
};

describe('rangesOverlap', () => {
  it('is true for identical ranges', () => {
    expect(
      rangesOverlap(
        { start: '2026-01-01', end: '2026-12-31' },
        { start: '2026-01-01', end: '2026-12-31' },
      ),
    ).toBe(true);
  });

  it('is true when one range contains the other', () => {
    expect(
      rangesOverlap(
        { start: '2026-03-01', end: '2026-04-01' },
        { start: '2026-01-01', end: '2026-12-31' },
      ),
    ).toBe(true);
  });

  it('is true when they share exactly one day at the end', () => {
    // The case a strict inequality would let through: two tenants holding one unit on
    // 31 December.
    expect(
      rangesOverlap(
        { start: '2026-12-31', end: '2027-06-30' },
        { start: '2026-01-01', end: '2026-12-31' },
      ),
    ).toBe(true);
  });

  it('is true when they share exactly one day at the start', () => {
    expect(
      rangesOverlap(
        { start: '2025-06-01', end: '2026-01-01' },
        { start: '2026-01-01', end: '2026-12-31' },
      ),
    ).toBe(true);
  });

  it('is false when the new range starts the day after the old one ends', () => {
    expect(
      rangesOverlap(
        { start: '2027-01-01', end: '2027-12-31' },
        { start: '2026-01-01', end: '2026-12-31' },
      ),
    ).toBe(false);
  });

  it('is false when the new range ends the day before the old one starts', () => {
    expect(
      rangesOverlap(
        { start: '2025-01-01', end: '2025-12-31' },
        { start: '2026-01-01', end: '2026-12-31' },
      ),
    ).toBe(false);
  });

  it('is symmetric', () => {
    const a = { start: '2026-06-01', end: '2026-07-01' };
    const b = { start: '2026-06-15', end: '2026-08-01' };

    expect(rangesOverlap(a, b)).toBe(rangesOverlap(b, a));
  });

  it('handles a single-day tenancy', () => {
    expect(
      rangesOverlap(
        { start: '2026-06-01', end: '2026-06-01' },
        { start: '2026-06-01', end: '2026-06-01' },
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        { start: '2026-06-01', end: '2026-06-01' },
        { start: '2026-06-02', end: '2026-06-02' },
      ),
    ).toBe(false);
  });

  it('is correct across a year boundary, which lexicographic comparison must not break', () => {
    expect(
      rangesOverlap(
        { start: '2026-12-25', end: '2027-01-05' },
        { start: '2027-01-01', end: '2027-02-01' },
      ),
    ).toBe(true);
  });
});

describe('findOverlappingTenancy', () => {
  it('finds the colliding lease on the same unit', () => {
    const clash = findOverlappingTenancy(
      { propertyUnitId: UNIT, start: '2026-06-01', end: '2026-07-01' },
      [existing],
    );

    expect(clash?.id).toBe(existing.id);
  });

  it('ignores a lease on a different unit', () => {
    const clash = findOverlappingTenancy(
      { propertyUnitId: OTHER_UNIT, start: '2026-06-01', end: '2026-07-01' },
      [existing],
    );

    expect(clash).toBeNull();
  });

  it('excludes the row being updated, so a rent change does not collide with itself', () => {
    const clash = findOverlappingTenancy(
      { propertyUnitId: UNIT, start: '2026-01-01', end: '2026-12-31' },
      [existing],
      existing.id,
    );

    expect(clash).toBeNull();
  });

  it('still finds a different lease while excluding one', () => {
    const second: TenancyInterval = {
      id: '77777777-0000-4000-8000-000000000009',
      propertyUnitId: UNIT,
      start: '2027-01-01',
      end: '2027-12-31',
    };

    const clash = findOverlappingTenancy(
      { propertyUnitId: UNIT, start: '2027-06-01', end: '2027-07-01' },
      [existing, second],
      existing.id,
    );

    expect(clash?.id).toBe(second.id);
  });

  it('returns null against an empty set', () => {
    expect(
      findOverlappingTenancy({ propertyUnitId: UNIT, start: '2026-01-01', end: '2026-02-01' }, []),
    ).toBeNull();
  });
});

describe('reconciledUnitStatus', () => {
  const cases: [UnitStatus, boolean, UnitStatus | null][] = [
    ['available', true, 'occupied'],
    ['occupied', true, null],
    ['occupied', false, 'available'],
    ['available', false, null],
    // `inactive` is a manager's deliberate archive decision and is never overwritten by
    // a derived field.
    ['inactive', true, null],
    ['inactive', false, null],
  ];

  for (const [current, hasActive, expected] of cases) {
    it(`${current} + ${hasActive ? 'an active tenancy' : 'no active tenancy'} → ${expected ?? 'no change'}`, () => {
      expect(reconciledUnitStatus(current, hasActive)).toBe(expected);
    });
  }
});

describe('asUnitStatus', () => {
  it('narrows the three known values', () => {
    expect(asUnitStatus('available')).toBe('available');
    expect(asUnitStatus('occupied')).toBe('occupied');
    expect(asUnitStatus('inactive')).toBe('inactive');
  });

  it('returns null for a value this build does not know, meaning "leave it alone"', () => {
    expect(asUnitStatus('under_renovation')).toBeNull();
  });
});

describe('expiry window', () => {
  it('includes a tenancy ending today and one ending on the last day of the window', () => {
    expect(isExpiringWithin('2026-11-09', '2026-11-09', 60)).toBe(true);
    expect(isExpiringWithin('2027-01-08', '2026-11-09', 60)).toBe(true);
  });

  it('excludes one ending the day after the window closes', () => {
    expect(isExpiringWithin('2027-01-09', '2026-11-09', 60)).toBe(false);
  });

  it('excludes one that has already ended — that is a data problem, not a renewal', () => {
    expect(isExpiringWithin('2026-11-08', '2026-11-09', 60)).toBe(false);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('formats today as a bare calendar date', () => {
    expect(todayIsoDate(new Date('2026-11-09T22:30:00Z'))).toBe('2026-11-09');
    expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
