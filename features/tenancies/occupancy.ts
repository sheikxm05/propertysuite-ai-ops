/**
 * Two rules the database does not hold, expressed as pure functions.
 *
 * 1. **No two ACTIVE tenancies may overlap on one unit.** There is no constraint for
 *    this in `0001`, `0002` or `0003` — a `tsrange` exclusion constraint would be the
 *    database-level answer and no migration in this build declares one. So it is
 *    enforced server-side in `tenancy-service.ts`, over the rows the caller can
 *    legitimately see, and the predicate lives here so it can be tested exhaustively
 *    without a database.
 *
 * 2. **`property_units.status` follows the unit's active tenancy.** The column is
 *    denormalized state derived from `tenancies`, so the rule for reconciling it has to
 *    be stated exactly once.
 *
 * Both work on `YYYY-MM-DD` strings. Lexicographic comparison is total and correct for
 * that format, which is why callers must pass values that have already been through
 * `IsoDateSchema` — see the same reasoning behind `isOnOrAfter` in
 * `packages/shared/schemas/primitives.ts`.
 */

import { UNIT_STATUSES, type UnitStatus } from '@shared/index';

/**
 * Narrows a `property_units.status` column to the union, or `null` if the stored value
 * is not one this build knows about.
 *
 * `null` is handled by every caller as "leave the column alone". The generator types the
 * column `string` because it is `text` with a `check (... in (...))` constraint rather
 * than a Postgres enum (see §5.9's carried-forward gap), so an unrecognised value means
 * the migration and `UNIT_STATUSES` have drifted — and overwriting a status this code
 * does not understand is the one response guaranteed to make that worse.
 */
export function asUnitStatus(value: string): UnitStatus | null {
  return UNIT_STATUSES.find((status) => status === value) ?? null;
}

/** A closed date interval, inclusive at both ends, as `tenancies.start_date/end_date` is. */
export interface DateRange {
  start: string;
  end: string;
}

/**
 * Do two inclusive date intervals share at least one day?
 *
 * Inclusive at both ends because `tenancies` stores `date` columns with
 * `check (end_date >= start_date)` and a lease that ends on the 31st is let on the 31st.
 * So a new lease starting that same day overlaps and must be rejected: two tenants
 * holding one unit on one day is the condition this prevents.
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** A row from `tenancies` reduced to what the overlap rule needs. */
export interface TenancyInterval extends DateRange {
  id: string;
  propertyUnitId: string;
}

/**
 * The first existing active tenancy that collides with `candidate`, or `null`.
 *
 * `excludeTenancyId` is how an update excludes the row being updated — without it,
 * changing the rent on an active tenancy would collide with itself.
 */
export function findOverlappingTenancy(
  candidate: DateRange & { propertyUnitId: string },
  existingActive: readonly TenancyInterval[],
  excludeTenancyId?: string | null,
): TenancyInterval | null {
  for (const existing of existingActive) {
    if (existing.id === excludeTenancyId) continue;
    if (existing.propertyUnitId !== candidate.propertyUnitId) continue;
    if (rangesOverlap(candidate, existing)) return existing;
  }
  return null;
}

/**
 * The unit status implied by whether the unit has an active tenancy, or `null` when the
 * stored value already says the right thing and no write is needed.
 *
 * `inactive` is never overwritten by this function. It is the archive state a manager
 * sets deliberately (`property_units_update_staff`, "archive (status -> 'inactive')"),
 * and a derived field must not undo an explicit human decision — the reconciliation is
 * between `available` and `occupied` only. A unit explicitly marked `inactive` that
 * gains an active tenancy *is* an inconsistency, but the right correction is for a
 * manager to reopen the unit, not for this code to silently re-list it.
 */
export function reconciledUnitStatus(
  current: UnitStatus,
  hasActiveTenancy: boolean,
): UnitStatus | null {
  if (current === 'inactive') return null;
  if (hasActiveTenancy) return current === 'occupied' ? null : 'occupied';
  return current === 'occupied' ? 'available' : null;
}

/**
 * Is a tenancy expiring within `days` of `today`?
 *
 * Used by the dashboard widget. Already-ended tenancies are excluded: an expiry that
 * has passed is not a renewal prompt, it is a data-quality problem for a different
 * screen.
 */
export function isExpiringWithin(endDate: string, today: string, days: number): boolean {
  if (endDate < today) return false;
  return endDate <= addDays(today, days);
}

/** `YYYY-MM-DD` plus a whole number of days, in UTC. */
export function addDays(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Today in UTC as `YYYY-MM-DD`. Injected into the pure helpers above, never read by them. */
export function todayIsoDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
