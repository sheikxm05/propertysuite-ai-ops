import type { MaintenanceCategory } from '../constants/categories';
import { PRIORITY_RANK, type TicketPriority } from '../constants/ticket-status';

/**
 * The deterministic maintenance priority policy.
 *
 * `docs/ai-prompts/maintenance-classification.md` is explicit: "The model may
 * suggest priority; deterministic application policy decides final priority."
 * This function is that policy. The model's `suggested_priority` is one bounded
 * input among several; everything else comes from trusted server-side facts.
 *
 * The guarantee worth stating plainly, because it is the reason this file
 * exists rather than `ticket.priority = classification.suggested_priority`:
 *
 *   A MODEL SUGGESTION ALONE CAN NEVER PRODUCE `urgent`.
 *
 * `urgent` requires a trusted escalation signal — an uninhabitable occupied
 * unit, a repeat failure, or an out-of-hours safety callout. A prompt-injected
 * message that screams EMERGENCY, URGENT, CRITICAL therefore raises the
 * priority by at most one step above the category's baseline and no higher than
 * `high`. That bounds the blast radius of untrusted text to a nuisance instead
 * of a way to jump the queue, and it is asserted by unit test.
 *
 * The function is pure: no clock, no I/O, no ambient state. `outsideBusinessHours`
 * is passed in rather than computed from `Date.now()` precisely so that the
 * policy stays deterministic and testable — the caller reads the clock.
 */

/** Priority floor by category, before any escalation. */
export const BASELINE_PRIORITY_BY_CATEGORY: Readonly<
  Record<MaintenanceCategory, TicketPriority>
> = Object.freeze({
  /**
   * Dubai: an air-conditioning failure in summer is a habitability problem, not
   * a comfort complaint. It is the single most common ticket in this domain and
   * the reason `hvac` is safety-sensitive below.
   */
  hvac: 'normal',
  plumbing: 'normal',
  /** Shock and fire risk. */
  electrical: 'high',
  appliance: 'normal',
  /** Collapse, water ingress, structural cracking. */
  structural: 'high',
  pest_control: 'normal',
  cleaning: 'low',
  other: 'normal',
  /**
   * `unknown` means not yet classified, not "trivial". A middling baseline
   * keeps an unclassified ticket visible until a human categorises it.
   */
  unknown: 'normal',
});

/**
 * Categories where a trusted signal may escalate as far as `urgent`.
 *
 * Membership is about risk to person or property, not about inconvenience.
 * `cleaning`, `appliance`, `pest_control`, `other` and `unknown` are excluded,
 * so no amount of out-of-hours reporting makes a cleaning request urgent.
 */
export const SAFETY_SENSITIVE_CATEGORIES = [
  'hvac',
  'plumbing',
  'electrical',
  'structural',
] as const satisfies readonly MaintenanceCategory[];

/** The highest priority a model suggestion may reach on its own. */
export const MODEL_PRIORITY_CEILING: TicketPriority = 'high';

/** How far above the category baseline a model suggestion may raise priority. */
export const MODEL_MAX_ESCALATION_STEPS = 1;

/** Open tickets on the same unit and category, at or above which a repeat failure escalates. */
export const RECURRING_FAILURE_THRESHOLD = 2;

/** Stable reason codes. Safe to persist in an audit row or an activity timeline. */
export const PRIORITY_REASONS = [
  'category_baseline',
  'model_suggestion_applied',
  'model_suggestion_capped',
  'uninhabitable_escalation',
  'recurring_failure_escalation',
  'out_of_hours_escalation',
  'vacant_unit_cap',
  'no_downgrade_floor',
] as const;

export type PriorityReason = (typeof PRIORITY_REASONS)[number];

/**
 * The model's contribution. Accepts the full `Classification` object or `null`
 * for a manually created ticket with no AI involvement.
 */
export type PriorityClassificationInput = {
  suggested_priority?: TicketPriority | null;
} | null;

/**
 * Trusted facts. Every field here must be derived server-side from database
 * rows or the server clock — never from the request body and never from model
 * output. Passing a client-supplied value into this object would hand the
 * caller the escalation controls the model is deliberately denied.
 */
export type PriorityContext = {
  /** The ticket's controlled category, after enum validation. */
  category: MaintenanceCategory;
  /** Is anyone actually living in the unit? From `tenancies`, not from the request. */
  hasActiveTenancy: boolean;
  /** Unit is unsafe or uninhabitable — a staff determination, not a tenant claim. */
  unitUninhabitable?: boolean;
  /** Count of other open tickets on the same unit in the same category. */
  recurringOpenTickets?: number;
  /** Did the request arrive outside business hours? Read from the server clock by the caller. */
  outsideBusinessHours?: boolean;
  /** The priority already stored on the ticket. Policy never lowers it. */
  currentPriority?: TicketPriority | null;
};

export type PriorityDecision = {
  /** The decision. This is what gets written to `maintenance_tickets.priority`. */
  priority: TicketPriority;
  /** What the model proposed, for display beside the decision. `null` if it did not. */
  suggestedPriority: TicketPriority | null;
  /** True when the model proposed something higher than policy allowed it to reach. */
  suggestionCapped: boolean;
  /** Ordered reason codes. Suitable for an audit row; contains no free text. */
  reasons: readonly PriorityReason[];
};

const PRIORITY_BY_RANK: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

const MIN_RANK = 0;
const MAX_RANK = PRIORITY_BY_RANK.length - 1;

function priorityFromRank(rank: number): TicketPriority {
  const clamped = Math.min(Math.max(rank, MIN_RANK), MAX_RANK);
  // Safe: `clamped` is within bounds, so the lookup is defined.
  return PRIORITY_BY_RANK[clamped] as TicketPriority;
}

function isSafetySensitive(category: MaintenanceCategory): boolean {
  return (SAFETY_SENSITIVE_CATEGORIES as readonly MaintenanceCategory[]).includes(category);
}

/**
 * Decide a ticket's priority.
 *
 * Evaluation order, which is the policy:
 *
 *  1. Start at the category baseline.
 *  2. Apply the model's suggestion, capped at one step above baseline and never
 *     above `high`. A suggestion below the baseline is ignored — the model may
 *     raise concern, never dismiss it.
 *  3. Apply trusted escalations, safety-sensitive categories only:
 *     an uninhabitable occupied unit goes straight to `urgent`; a repeat
 *     failure and an out-of-hours report each add one step.
 *  4. Cap at `normal` if nobody lives there. A vacant unit is a scheduling
 *     problem, not an emergency.
 *  5. Never fall below the priority already on the ticket, so re-running the
 *     policy after an edit cannot silently de-escalate a manager's decision.
 *
 * @param classification The model's draft, or `null` for a manual ticket.
 * @param context Trusted, server-derived facts.
 */
export function resolvePriority(
  classification: PriorityClassificationInput,
  context: PriorityContext,
): PriorityDecision {
  const reasons: PriorityReason[] = ['category_baseline'];

  const baselineRank = PRIORITY_RANK[BASELINE_PRIORITY_BY_CATEGORY[context.category]];
  let rank = baselineRank;

  // 2. The model's suggestion — advisory, and bounded.
  const suggested = classification?.suggested_priority ?? null;
  let suggestionCapped = false;

  if (suggested !== null) {
    const ceiling = Math.min(
      baselineRank + MODEL_MAX_ESCALATION_STEPS,
      PRIORITY_RANK[MODEL_PRIORITY_CEILING],
    );
    const suggestedRank = PRIORITY_RANK[suggested];
    const effectiveRank = Math.min(suggestedRank, ceiling);

    if (suggestedRank > ceiling) {
      suggestionCapped = true;
      reasons.push('model_suggestion_capped');
    }

    if (effectiveRank > rank) {
      rank = effectiveRank;
      if (!suggestionCapped) reasons.push('model_suggestion_applied');
    }
  }

  // 3. Trusted escalations. Risk to a person, so these may reach `urgent`.
  if (isSafetySensitive(context.category)) {
    if (context.hasActiveTenancy && context.unitUninhabitable === true) {
      rank = PRIORITY_RANK.urgent;
      reasons.push('uninhabitable_escalation');
    }

    if ((context.recurringOpenTickets ?? 0) >= RECURRING_FAILURE_THRESHOLD) {
      rank = Math.min(rank + 1, MAX_RANK);
      reasons.push('recurring_failure_escalation');
    }

    if (context.outsideBusinessHours === true && context.hasActiveTenancy) {
      rank = Math.min(rank + 1, MAX_RANK);
      reasons.push('out_of_hours_escalation');
    }
  }

  // 4. Nobody is living there.
  if (!context.hasActiveTenancy && rank > PRIORITY_RANK.normal) {
    rank = PRIORITY_RANK.normal;
    reasons.push('vacant_unit_cap');
  }

  // 5. Never downgrade a priority a human already set.
  const current = context.currentPriority ?? null;
  if (current !== null && PRIORITY_RANK[current] > rank) {
    rank = PRIORITY_RANK[current];
    reasons.push('no_downgrade_floor');
  }

  return {
    priority: priorityFromRank(rank),
    suggestedPriority: suggested,
    suggestionCapped,
    reasons: Object.freeze(reasons),
  };
}
