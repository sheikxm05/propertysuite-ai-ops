/**
 * The `property_units.status` lifecycle: `available` → `occupied` → `inactive`.
 *
 * `UNIT_STATUSES` is frozen in `packages/shared` (`['available','occupied','inactive']`,
 * transcribed from the `check` constraint in `0001_initial_schema.sql`), but the *graph*
 * between those three values is not: `packages/shared` carries
 * `ALLOWED_TRANSITIONS` for tickets and `ALLOWED_TENANCY_TRANSITIONS` for tenancies and
 * has no equivalent for units. `packages/shared` is frozen and owned by w0-l4, so the
 * rule is defined here, in the lane that owns units. See the planning defect reported
 * with this lane: lane w1-l3 keeps unit occupancy consistent with the active tenancy and
 * cannot legally import this module, so the rule has one home today and needs a shared
 * one before Wave 2.
 *
 * ---------------------------------------------------------------------------
 * THE GRAPH, AND WHY EACH MISSING EDGE IS MISSING
 * ---------------------------------------------------------------------------
 *   available → occupied   a tenancy begins
 *   available → inactive   the unit is taken out of service (the archive edge)
 *   occupied  → available  the tenancy ends and the unit is released
 *   inactive  → available  the unit is returned to service
 *
 * `occupied → inactive` is **absent**. Archiving a unit that someone is living in would
 * leave an active tenancy pointing at an out-of-service unit, and `property_units` has no
 * DELETE path, so `inactive` is this table's archive state — the one state from which a
 * row is not expected to come back into use. Releasing first is one extra call and keeps
 * occupancy and tenancy from disagreeing.
 *
 * `inactive → occupied` is **absent** for the mirror reason: a unit must be returned to
 * service deliberately before it can be let, rather than as a side effect of signing a
 * tenancy.
 *
 * Staying in the same status is always permitted, so a `PATCH` that resends the current
 * status while changing a bedroom count is not a conflict.
 *
 * This is domain policy, not authorization. *Who* may change a unit's status is
 * `authorize()` in `lib/auth/authorize.ts` (staff write, everyone else read-only) plus
 * `property_units_update_staff` in `0002`. Both run regardless of what this file says.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { UNIT_STATUSES, type UnitStatus } from '@shared/index';

/** The status a newly created unit gets when the client does not say. Matches the DDL default. */
export const DEFAULT_UNIT_STATUS = 'available' as const satisfies UnitStatus;

/** The status that takes a unit out of service. There is no DELETE path for a unit. */
export const UNIT_ARCHIVED_STATUS = 'inactive' as const satisfies UnitStatus;

/**
 * Outbound edges per status. Typed `Record<UnitStatus, …>`, so adding a fourth status to
 * `UNIT_STATUSES` in `packages/shared` fails `tsc` here rather than silently leaving the
 * new status with no rules.
 */
export const ALLOWED_UNIT_TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> =
  Object.freeze({
    available: Object.freeze(['occupied', UNIT_ARCHIVED_STATUS] as const),
    occupied: Object.freeze(['available'] as const),
    inactive: Object.freeze(['available'] as const),
  });

/** Is `value` one of the three statuses the database permits? */
export function isUnitStatus(value: string): value is UnitStatus {
  return (UNIT_STATUSES as readonly string[]).includes(value);
}

/**
 * May a unit move from `from` to `to`?
 *
 * `from` is typed as `string` because it arrives from a `text` column: the generated row
 * type is `string`, and `0001`'s `check` constraint is the only thing narrowing it. An
 * unrecognised current status returns `false` for every target — fail closed. A value
 * that never changes is always allowed.
 */
export function canTransitionUnit(from: string, to: UnitStatus): boolean {
  if (!isUnitStatus(from)) return false;
  if (from === to) return true;
  return ALLOWED_UNIT_TRANSITIONS[from].includes(to);
}

/** The statuses a unit may legally move to right now, for rendering the UI controls. */
export function nextUnitStatuses(from: string): readonly UnitStatus[] {
  return isUnitStatus(from) ? ALLOWED_UNIT_TRANSITIONS[from] : [];
}

/**
 * `canTransitionUnit`, as an assertion.
 *
 * An illegal edge is `CONFLICT` (409), matching `docs/implementation-plan.md` §4's rule
 * for the ticket machine — "an illegal edge returns 409; a legal edge attempted by the
 * wrong role returns 403" — so the two state machines in this application answer a
 * client the same way. The message names the two states because they are the client's
 * own values and disclose nothing; the row id is not in it.
 */
export function assertUnitTransition(from: string, to: UnitStatus): void {
  if (canTransitionUnit(from, to)) return;

  throw new ApiRouteError('CONFLICT', {
    message: `A unit cannot move from ${from} to ${to}.`,
    logFields: { reason: 'unit_status_transition_invalid', from, to },
  });
}
