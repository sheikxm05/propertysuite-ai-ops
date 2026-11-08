/**
 * Activity row planning — "exactly one row per transition", as a pure function.
 *
 * `maintenance_activities` is append-only in the strongest sense available: `0002`
 * revokes UPDATE and DELETE from client roles and `0003`'s `block_activity_mutation`
 * trigger rejects UPDATE, DELETE and TRUNCATE for every caller including the table
 * owner. A row written here is permanent. Two consequences shape this module:
 *
 *  1. **Nothing is written speculatively.** A planner returns the rows a mutation
 *     *would* write; the service writes them only after the ticket update has
 *     succeeded. An activity row describing a transition the database refused is a
 *     false record, and it cannot be deleted afterwards.
 *  2. **No free text and no personal data in `metadata`.** `MetadataSchema` in
 *     `packages/shared` is explicit that metadata "must carry identifiers and decisions
 *     — never document text, message bodies, tokens or personal data", and an activity
 *     row is readable by everyone who can read the ticket, including a service provider.
 *     Every metadata value below is an identifier, a status, a priority or a policy
 *     reason code.
 *
 * `description` is the timeline's human-readable line. For a server-written transition
 * row it is a fixed sentence assembled from status names, so it can never echo request
 * input. The one exception is the completion summary, which is the staff- or
 * tenant-authored resolution note and is the whole point of the row — see
 * `planCompletionActivity`.
 *
 * The invariant the exit gate tests: for any single mutation, AT MOST ONE planned row
 * carries `from_status`/`to_status` in its metadata, and exactly one does when the
 * status changed. `isTransitionActivity` is the predicate the tests assert with, so the
 * test and the implementation share one definition of "a transition row".
 */

import type { ActivityType, JsonValue, TicketPriority, TicketStatus } from '@shared/index';

import { transitionActivityType } from './transitions';

/** A row to be inserted into `maintenance_activities`, minus the server-filled columns. */
export interface PlannedActivity {
  readonly activity_type: ActivityType;
  readonly description: string;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

/**
 * Is this the row that records a state machine edge?
 *
 * Defined by the metadata keys rather than by `activity_type`, because the type varies
 * (`provider_assigned`, `completion_confirmed`, `ticket_cancelled`, `status_changed`)
 * while the meaning does not. A `priority_changed` row is not a transition and must not
 * count towards the one-row-per-transition invariant.
 */
export function isTransitionActivity(activity: PlannedActivity): boolean {
  return 'from_status' in activity.metadata && 'to_status' in activity.metadata;
}

/** The creation row. An INSERT is not an edge, so it carries no `from_status`. */
export function planCreationActivity(input: {
  category: string;
  priority: TicketPriority;
  priorityReasons: readonly string[];
  source: string;
}): PlannedActivity {
  return {
    activity_type: 'ticket_created',
    description: 'Ticket created.',
    metadata: Object.freeze({
      status: 'open',
      category: input.category,
      priority: input.priority,
      priority_reasons: [...input.priorityReasons],
      source: input.source,
    }),
  };
}

/** The single row for a plain status change, including a cancellation. */
export function planTransitionActivity(
  from: TicketStatus,
  to: TicketStatus,
  extra: Readonly<Record<string, JsonValue>> = {},
): PlannedActivity {
  return {
    activity_type: transitionActivityType(to),
    description: `Status changed from ${from} to ${to}.`,
    metadata: Object.freeze({ from_status: from, to_status: to, ...extra }),
  };
}

/**
 * The single row for an assignment.
 *
 * One row, not two: the assignment and the `open -> assigned` edge are the same event,
 * and `transitionActivityType('assigned')` returns `provider_assigned` precisely so that
 * a separate `status_changed` row is never needed.
 */
export function planAssignmentActivity(input: {
  from: TicketStatus;
  providerId: string;
  priority: TicketPriority;
  priorityChanged: boolean;
  priorityReasons: readonly string[];
}): PlannedActivity {
  return {
    activity_type: 'provider_assigned',
    description: 'Provider assigned.',
    metadata: Object.freeze({
      from_status: input.from,
      to_status: 'assigned' as TicketStatus,
      provider_id: input.providerId,
      priority: input.priority,
      priority_changed: input.priorityChanged,
      priority_reasons: [...input.priorityReasons],
    }),
  };
}

/**
 * The single row for a completion.
 *
 * `description` carries the caller's `resolution_summary`. This is the one place a
 * mutation route writes human-authored text into the timeline, and it is intentional:
 * `maintenance_tickets` has no `resolution_summary` column, so the append-only timeline
 * is the only durable home for it, and a completion with no record of what was done is
 * not evidence of anything.
 *
 * The caller must have already bounded the summary to the activity `description` limit —
 * `assertRecordableSummary` below — because truncating it here would silently discard
 * part of a permanent record.
 */
export function planCompletionActivity(input: {
  from: TicketStatus;
  resolutionSummary: string;
  evidenceDocumentIds: readonly string[];
}): PlannedActivity {
  return {
    activity_type: 'completion_confirmed',
    description: input.resolutionSummary,
    metadata: Object.freeze({
      from_status: input.from,
      to_status: 'completed' as TicketStatus,
      evidence_document_ids: [...input.evidenceDocumentIds],
      evidence_count: input.evidenceDocumentIds.length,
    }),
  };
}

/**
 * The row for a priority change. NOT a transition row — no `from_status`.
 *
 * Written alongside a transition row when a single request both moves the ticket and
 * re-prioritizes it (assignment does exactly that), which is why the invariant is
 * expressed over `isTransitionActivity` rather than over the row count.
 */
export function planPriorityActivity(input: {
  from: TicketPriority;
  to: TicketPriority;
  reasons: readonly string[];
  decidedBy: 'policy' | 'staff_override';
}): PlannedActivity {
  return {
    activity_type: 'priority_changed',
    description: `Priority changed from ${input.from} to ${input.to}.`,
    metadata: Object.freeze({
      previous_priority: input.from,
      priority: input.to,
      priority_reasons: [...input.reasons],
      decided_by: input.decidedBy,
    }),
  };
}

/** A note or an evidence pointer added by a human through the activities route. */
export function planClientActivity(input: {
  activityType: ActivityType;
  description: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}): PlannedActivity {
  return {
    activity_type: input.activityType,
    description: input.description,
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  };
}

/**
 * How many of a plan's rows record a state machine edge.
 *
 * The exit-gate assertion for this lane runs through this function rather than counting
 * rows by hand, so the test and the service agree on what is being counted.
 */
export function countTransitionActivities(plan: readonly PlannedActivity[]): number {
  return plan.filter(isTransitionActivity).length;
}

/**
 * Upper bound on `maintenance_activities.description`, from `CreateActivitySchema`
 * (`boundedText(1, 1000)`) in `packages/shared`.
 *
 * Restated as a number, not as a second schema: `CompleteTicketSchema` permits a
 * `resolution_summary` of up to 2000 characters while the activity row that must hold it
 * permits 1000, and the service needs the bound as a value in order to reject the
 * overlap rather than truncate a permanent record. See the planning defect in this
 * lane's report.
 */
export const ACTIVITY_DESCRIPTION_MAX_LENGTH = 1000;
