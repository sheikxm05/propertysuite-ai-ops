/**
 * The tenancy lifecycle, as pure functions.
 *
 * `draft → active → expired | terminated`, plus `draft → terminated` for a lease that
 * is cancelled before it ever starts. The edge table itself is
 * `ALLOWED_TENANCY_TRANSITIONS` in `packages/shared` and is **not** restated here —
 * CLAUDE.md rule 4. This module adds only the three things a route needs on top of it:
 * a thrown 409, a terminal-state predicate, and the "which statuses occupy a unit"
 * question that unit-occupancy consistency depends on.
 *
 * Unlike the maintenance ticket machine there is no database trigger behind this one
 * (see the `ALLOWED_TENANCY_TRANSITIONS` note in `constants/statuses.ts`: "Advisory
 * only ... enforced server-side in the tenancy service"). That makes this file the only
 * enforcement point for the edge set, so it is unit-tested directly rather than only
 * through a route.
 */

import {
  ALLOWED_TENANCY_TRANSITIONS,
  TENANCY_STATUSES,
  canTransitionTenancy,
  type TenancyStatus,
} from '@shared/index';

import { ApiRouteError } from '@/lib/api/errors';

/**
 * The statuses a tenancy may be created with.
 *
 * `draft` is the normal path and `active` covers importing a lease that is already
 * running. `expired` and `terminated` are absent deliberately: they are the *outcome*
 * of a transition, each of which writes an audit row, so creating a record already in
 * one would produce a tenancy whose ending was never recorded as having happened.
 */
export const CREATABLE_TENANCY_STATUSES: readonly TenancyStatus[] = ['draft', 'active'];

/** A tenancy in one of these statuses occupies its unit. Only `active` does. */
export const OCCUPYING_TENANCY_STATUSES: readonly TenancyStatus[] = ['active'];

/** Does this status mean the unit is currently let? */
export function occupiesUnit(status: TenancyStatus): boolean {
  return OCCUPYING_TENANCY_STATUSES.includes(status);
}

/** A status with no outgoing edges: `expired` and `terminated`. */
export function isTerminalTenancyStatus(status: TenancyStatus): boolean {
  return ALLOWED_TENANCY_TRANSITIONS[status].length === 0;
}

/** The statuses a caller may move to from `from`, for rendering the UI's options. */
export function nextTenancyStatuses(from: TenancyStatus): readonly TenancyStatus[] {
  return ALLOWED_TENANCY_TRANSITIONS[from];
}

/** Narrows a `tenancies.status` column (typed `string` by the generator) to the union. */
export function asTenancyStatus(value: string): TenancyStatus {
  const match = TENANCY_STATUSES.find((status) => status === value);
  if (!match) {
    // An unrecognised status is a schema drift, not a client error: the check
    // constraint in `0001` cannot produce one, so reaching here means the migration and
    // `TENANCY_STATUSES` disagree. Fail as a 500 rather than guessing a safe default.
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'tenancy_status_unrecognised', status: value },
    });
  }
  return match;
}

/**
 * Asserts a lifecycle edge, or throws the 409 that `docs/api-contracts.md` specifies
 * for a conflict.
 *
 * A no-op transition (`from === to`) is permitted and reported as `changed: false`, so
 * a PATCH that resends the current status alongside a rent correction is not rejected —
 * but it also does not emit a lifecycle audit entry, because nothing transitioned.
 */
export function assertTenancyTransition(
  from: TenancyStatus,
  to: TenancyStatus,
): { changed: boolean } {
  if (from === to) return { changed: false };

  if (!canTransitionTenancy(from, to)) {
    throw new ApiRouteError('CONFLICT', {
      message: isTerminalTenancyStatus(from)
        ? `A ${from} tenancy cannot change status.`
        : `A tenancy cannot move from ${from} to ${to}.`,
      logFields: {
        reason: 'tenancy_transition_invalid',
        from_status: from,
        to_status: to,
      },
    });
  }

  return { changed: true };
}
