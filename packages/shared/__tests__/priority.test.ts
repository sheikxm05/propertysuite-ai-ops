import { describe, expect, it } from 'vitest';

import { MAINTENANCE_CATEGORIES, type MaintenanceCategory } from '../constants/categories';
import { PRIORITY_RANK, TICKET_PRIORITIES } from '../constants/ticket-status';
import {
  BASELINE_PRIORITY_BY_CATEGORY,
  MODEL_PRIORITY_CEILING,
  RECURRING_FAILURE_THRESHOLD,
  SAFETY_SENSITIVE_CATEGORIES,
  resolvePriority,
  type PriorityContext,
} from '../policy/priority';

/**
 * The deterministic priority policy.
 *
 * The property that matters most is negative and is asserted exhaustively: no
 * model suggestion, for any category, can on its own produce `urgent`. If that
 * ever breaks, a prompt-injected message becomes a queue-jumping primitive.
 */

const occupied = (category: MaintenanceCategory): PriorityContext => ({
  category,
  hasActiveTenancy: true,
});

const vacant = (category: MaintenanceCategory): PriorityContext => ({
  category,
  hasActiveTenancy: false,
});

describe('resolvePriority — baselines', () => {
  it('returns the category baseline when there is no suggestion and no signal', () => {
    for (const category of MAINTENANCE_CATEGORIES) {
      const decision = resolvePriority(null, occupied(category));
      expect(decision.priority).toBe(BASELINE_PRIORITY_BY_CATEGORY[category]);
      expect(decision.suggestedPriority).toBeNull();
      expect(decision.suggestionCapped).toBe(false);
      expect(decision.reasons).toContain('category_baseline');
    }
  });

  it('treats an unclassified ticket as normal, not trivial', () => {
    expect(resolvePriority(null, occupied('unknown')).priority).toBe('normal');
  });

  it('treats electrical and structural faults as high by default', () => {
    expect(resolvePriority(null, occupied('electrical')).priority).toBe('high');
    expect(resolvePriority(null, occupied('structural')).priority).toBe('high');
  });

  it('treats cleaning as low', () => {
    expect(resolvePriority(null, occupied('cleaning')).priority).toBe('low');
  });

  it('covers every category, so a new category cannot be silently unpriced', () => {
    expect(Object.keys(BASELINE_PRIORITY_BY_CATEGORY).sort()).toEqual(
      [...MAINTENANCE_CATEGORIES].sort(),
    );
  });
});

describe('resolvePriority — the model only suggests', () => {
  it('NEVER produces urgent from a model suggestion alone, for any category', () => {
    for (const category of MAINTENANCE_CATEGORIES) {
      for (const suggested of TICKET_PRIORITIES) {
        const decision = resolvePriority({ suggested_priority: suggested }, occupied(category));
        expect(decision.priority).not.toBe('urgent');
      }
    }
  });

  it('caps a suggestion at the model ceiling and records that it was capped', () => {
    const decision = resolvePriority({ suggested_priority: 'urgent' }, occupied('electrical'));
    expect(decision.priority).toBe(MODEL_PRIORITY_CEILING);
    expect(decision.suggestionCapped).toBe(true);
    expect(decision.reasons).toContain('model_suggestion_capped');
    expect(decision.suggestedPriority).toBe('urgent');
  });

  it('caps a suggestion at one step above the category baseline', () => {
    // cleaning baseline is `low`; one step is `normal`, so `high` is capped to `normal`.
    const decision = resolvePriority({ suggested_priority: 'high' }, occupied('cleaning'));
    expect(decision.priority).toBe('normal');
    expect(decision.suggestionCapped).toBe(true);
  });

  it('applies a suggestion that is within bounds', () => {
    const decision = resolvePriority({ suggested_priority: 'high' }, occupied('hvac'));
    expect(decision.priority).toBe('high');
    expect(decision.suggestionCapped).toBe(false);
    expect(decision.reasons).toContain('model_suggestion_applied');
  });

  it('ignores a suggestion below the baseline — the model may raise concern, never dismiss it', () => {
    const decision = resolvePriority({ suggested_priority: 'low' }, occupied('electrical'));
    expect(decision.priority).toBe('high');
    expect(decision.reasons).not.toContain('model_suggestion_applied');
    // The suggestion is still reported, so the divergence is visible to a human.
    expect(decision.suggestedPriority).toBe('low');
  });

  it('treats a null or absent suggestion as no suggestion', () => {
    expect(resolvePriority({ suggested_priority: null }, occupied('hvac')).priority).toBe('normal');
    expect(resolvePriority({}, occupied('hvac')).priority).toBe('normal');
    expect(resolvePriority(null, occupied('hvac')).priority).toBe('normal');
  });

  it('is unmoved by a suggestion on a non-safety category even at the ceiling', () => {
    const decision = resolvePriority({ suggested_priority: 'urgent' }, occupied('cleaning'));
    expect(decision.priority).toBe('normal');
  });
});

describe('resolvePriority — trusted escalations', () => {
  it('escalates an uninhabitable occupied unit to urgent', () => {
    const decision = resolvePriority(null, {
      category: 'plumbing',
      hasActiveTenancy: true,
      unitUninhabitable: true,
    });
    expect(decision.priority).toBe('urgent');
    expect(decision.reasons).toContain('uninhabitable_escalation');
  });

  it('does not escalate an uninhabitable claim on a non-safety category', () => {
    const decision = resolvePriority(null, {
      category: 'cleaning',
      hasActiveTenancy: true,
      unitUninhabitable: true,
    });
    expect(decision.priority).toBe('low');
    expect(decision.reasons).not.toContain('uninhabitable_escalation');
  });

  it('escalates one step on a repeat failure at the threshold', () => {
    const below = resolvePriority(null, {
      category: 'hvac',
      hasActiveTenancy: true,
      recurringOpenTickets: RECURRING_FAILURE_THRESHOLD - 1,
    });
    expect(below.priority).toBe('normal');
    expect(below.reasons).not.toContain('recurring_failure_escalation');

    const at = resolvePriority(null, {
      category: 'hvac',
      hasActiveTenancy: true,
      recurringOpenTickets: RECURRING_FAILURE_THRESHOLD,
    });
    expect(at.priority).toBe('high');
    expect(at.reasons).toContain('recurring_failure_escalation');
  });

  it('escalates one step for an out-of-hours safety callout', () => {
    const decision = resolvePriority(null, {
      category: 'hvac',
      hasActiveTenancy: true,
      outsideBusinessHours: true,
    });
    expect(decision.priority).toBe('high');
    expect(decision.reasons).toContain('out_of_hours_escalation');
  });

  it('does not escalate out of hours for a non-safety category', () => {
    const decision = resolvePriority(null, {
      category: 'cleaning',
      hasActiveTenancy: true,
      outsideBusinessHours: true,
    });
    expect(decision.priority).toBe('low');
  });

  it('reaches urgent when trusted signals stack', () => {
    const decision = resolvePriority(null, {
      category: 'electrical',
      hasActiveTenancy: true,
      recurringOpenTickets: RECURRING_FAILURE_THRESHOLD,
      outsideBusinessHours: true,
    });
    expect(decision.priority).toBe('urgent');
  });

  it('never exceeds urgent however many signals stack', () => {
    const decision = resolvePriority(
      { suggested_priority: 'urgent' },
      {
        category: 'structural',
        hasActiveTenancy: true,
        unitUninhabitable: true,
        recurringOpenTickets: 99,
        outsideBusinessHours: true,
        currentPriority: 'urgent',
      },
    );
    expect(decision.priority).toBe('urgent');
  });

  it('only escalates on safety-sensitive categories', () => {
    for (const category of MAINTENANCE_CATEGORIES) {
      const isSafety = (SAFETY_SENSITIVE_CATEGORIES as readonly string[]).includes(category);
      const decision = resolvePriority(null, {
        category,
        hasActiveTenancy: true,
        unitUninhabitable: true,
        recurringOpenTickets: 5,
        outsideBusinessHours: true,
      });
      if (isSafety) {
        expect(decision.priority).toBe('urgent');
      } else {
        expect(decision.priority).toBe(BASELINE_PRIORITY_BY_CATEGORY[category]);
      }
    }
  });
});

describe('resolvePriority — vacancy cap', () => {
  it('caps a vacant unit at normal', () => {
    const decision = resolvePriority(null, vacant('electrical'));
    expect(decision.priority).toBe('normal');
    expect(decision.reasons).toContain('vacant_unit_cap');
  });

  it('does not raise a low-baseline category to normal just because it is vacant', () => {
    const decision = resolvePriority(null, vacant('cleaning'));
    expect(decision.priority).toBe('low');
    expect(decision.reasons).not.toContain('vacant_unit_cap');
  });

  it('ignores an uninhabitable flag on a vacant unit — nobody is at risk', () => {
    const decision = resolvePriority(null, {
      category: 'structural',
      hasActiveTenancy: false,
      unitUninhabitable: true,
    });
    expect(decision.priority).toBe('normal');
    expect(decision.reasons).not.toContain('uninhabitable_escalation');
  });

  it('ignores an out-of-hours report on a vacant unit', () => {
    const decision = resolvePriority(null, {
      category: 'hvac',
      hasActiveTenancy: false,
      outsideBusinessHours: true,
    });
    expect(decision.priority).toBe('normal');
    expect(decision.reasons).not.toContain('out_of_hours_escalation');
  });

  it('never caps below a priority a human already set', () => {
    const decision = resolvePriority(null, {
      category: 'electrical',
      hasActiveTenancy: false,
      currentPriority: 'urgent',
    });
    expect(decision.priority).toBe('urgent');
    expect(decision.reasons).toContain('no_downgrade_floor');
  });
});

describe('resolvePriority — no silent downgrade', () => {
  it('holds the existing priority as a floor', () => {
    for (const current of TICKET_PRIORITIES) {
      const decision = resolvePriority(null, {
        category: 'cleaning',
        hasActiveTenancy: true,
        currentPriority: current,
      });
      expect(PRIORITY_RANK[decision.priority]).toBeGreaterThanOrEqual(PRIORITY_RANK[current]);
    }
  });

  it('still escalates above the floor when a trusted signal says so', () => {
    const decision = resolvePriority(null, {
      category: 'plumbing',
      hasActiveTenancy: true,
      unitUninhabitable: true,
      currentPriority: 'low',
    });
    expect(decision.priority).toBe('urgent');
  });

  it('treats a null current priority as no floor', () => {
    const decision = resolvePriority(null, {
      category: 'cleaning',
      hasActiveTenancy: true,
      currentPriority: null,
    });
    expect(decision.priority).toBe('low');
    expect(decision.reasons).not.toContain('no_downgrade_floor');
  });
});

describe('resolvePriority — purity and output shape', () => {
  it('is deterministic across repeated calls', () => {
    const context: PriorityContext = {
      category: 'hvac',
      hasActiveTenancy: true,
      recurringOpenTickets: 3,
      outsideBusinessHours: true,
    };
    const first = resolvePriority({ suggested_priority: 'high' }, context);
    const second = resolvePriority({ suggested_priority: 'high' }, context);
    expect(first).toEqual(second);
  });

  it('does not mutate its inputs', () => {
    const context: PriorityContext = { category: 'hvac', hasActiveTenancy: true };
    const classification = { suggested_priority: 'high' as const };
    const snapshotContext = JSON.stringify(context);
    const snapshotClassification = JSON.stringify(classification);

    resolvePriority(classification, context);

    expect(JSON.stringify(context)).toBe(snapshotContext);
    expect(JSON.stringify(classification)).toBe(snapshotClassification);
  });

  it('returns a frozen reason list suitable for an audit row', () => {
    const decision = resolvePriority(null, occupied('hvac'));
    expect(Object.isFrozen(decision.reasons)).toBe(true);
    for (const reason of decision.reasons) {
      expect(typeof reason).toBe('string');
    }
  });

  it('always returns a valid ticket priority', () => {
    for (const category of MAINTENANCE_CATEGORIES) {
      for (const suggested of [...TICKET_PRIORITIES, null]) {
        for (const hasActiveTenancy of [true, false]) {
          const decision = resolvePriority(
            { suggested_priority: suggested },
            {
              category,
              hasActiveTenancy,
              unitUninhabitable: true,
              recurringOpenTickets: 4,
              outsideBusinessHours: true,
            },
          );
          expect(TICKET_PRIORITIES).toContain(decision.priority);
        }
      }
    }
  });
});
