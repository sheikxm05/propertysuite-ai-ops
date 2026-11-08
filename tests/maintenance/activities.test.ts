/**
 * "Exactly one activity row per transition" — the lane's exit gate, as unit tests.
 *
 * The invariant is expressed over `isTransitionActivity()`, which is also what the
 * planner and the timeline component use, so the test, the write path and the screen
 * share one definition of "a transition row": a row whose metadata carries both
 * `from_status` and `to_status`.
 *
 * Why that definition rather than counting rows: a single request can legitimately
 * append two rows — an assignment that also re-prioritizes writes one
 * `provider_assigned` row and, where the policy moved the priority, one
 * `priority_changed` row. Counting rows would make the invariant either wrong or a
 * prohibition on recording the priority decision. Counting *transition* rows is the
 * claim that actually matters: the timeline must contain one entry per edge, never zero
 * and never two.
 *
 * The second thing this file guards is what goes INTO `metadata`. The table is
 * append-only — `0003`'s trigger rejects UPDATE, DELETE and TRUNCATE for every caller
 * including the table owner — so a row is permanent, and it is readable by everyone who
 * can read the ticket, including a service provider. `MetadataSchema` in
 * `packages/shared` is explicit that metadata carries identifiers and decisions and
 * never personal data, so every value the planners emit is asserted to be an
 * identifier, a status, a priority or a policy reason code.
 */

import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_TYPES,
  ALLOWED_TRANSITIONS,
  MetadataSchema,
  TICKET_STATUSES,
} from '@shared/index';

import {
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  CLIENT_ACTIVITY_TYPES,
  SERVER_WRITTEN_ACTIVITY_TYPES,
  countTransitionActivities,
  isClientPostableActivityType,
  isTransitionActivity,
  planAssignmentActivity,
  planClientActivity,
  planCompletionActivity,
  planCreationActivity,
  planPriorityActivity,
  planTransitionActivity,
  transitionActivityType,
} from '@/features/maintenance/domain';

import { DOCUMENT_ID, PROVIDER_ID } from './_support/fixtures';

describe('one transition row per edge', () => {
  for (const from of TICKET_STATUSES) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      it(`${from} -> ${to} plans exactly one transition row`, () => {
        const plan = [planTransitionActivity(from, to)];
        expect(countTransitionActivities(plan)).toBe(1);
        expect(plan[0]?.metadata.from_status).toBe(from);
        expect(plan[0]?.metadata.to_status).toBe(to);
        expect(plan[0]?.activity_type).toBe(transitionActivityType(to));
      });
    }
  }

  it('an assignment is ONE row, not a provider row plus a status row', () => {
    const plan = [
      planAssignmentActivity({
        from: 'open',
        providerId: PROVIDER_ID,
        priority: 'high',
        priorityChanged: true,
        priorityReasons: ['category_baseline'],
      }),
    ];
    expect(plan).toHaveLength(1);
    expect(countTransitionActivities(plan)).toBe(1);
    expect(plan[0]?.activity_type).toBe('provider_assigned');
    expect(plan[0]?.metadata.to_status).toBe('assigned');
  });

  it('a completion is ONE row', () => {
    const plan = [
      planCompletionActivity({
        from: 'awaiting_approval',
        resolutionSummary: 'Replaced the compressor and recharged the system.',
        evidenceDocumentIds: [DOCUMENT_ID],
      }),
    ];
    expect(countTransitionActivities(plan)).toBe(1);
    expect(plan[0]?.activity_type).toBe('completion_confirmed');
  });

  it('creation is NOT a transition row — an insert is not an edge', () => {
    const plan = [
      planCreationActivity({
        category: 'hvac',
        priority: 'normal',
        priorityReasons: ['category_baseline'],
        source: 'web',
      }),
    ];
    expect(countTransitionActivities(plan)).toBe(0);
    expect(plan[0]?.activity_type).toBe('ticket_created');
  });

  it('a priority change is NOT a transition row', () => {
    const plan = [
      planPriorityActivity({
        from: 'normal',
        to: 'high',
        reasons: ['recurring_failure_escalation'],
        decidedBy: 'policy',
      }),
    ];
    expect(countTransitionActivities(plan)).toBe(0);
    expect(isTransitionActivity(plan[0]!)).toBe(false);
  });

  it('a transition plus a priority change is still ONE transition row', () => {
    const plan = [
      planTransitionActivity('in_progress', 'awaiting_approval'),
      planPriorityActivity({
        from: 'normal',
        to: 'high',
        reasons: ['out_of_hours_escalation'],
        decidedBy: 'policy',
      }),
    ];
    expect(plan).toHaveLength(2);
    expect(countTransitionActivities(plan)).toBe(1);
  });

  it('a human note is NOT a transition row', () => {
    const plan = [
      planClientActivity({ activityType: 'comment_added', description: 'Called the tenant.' }),
    ];
    expect(countTransitionActivities(plan)).toBe(0);
  });
});

describe('metadata is identifiers and decisions only', () => {
  const plans = [
    planCreationActivity({
      category: 'plumbing',
      priority: 'normal',
      priorityReasons: ['category_baseline'],
      source: 'whatsapp',
    }),
    planTransitionActivity('assigned', 'in_progress'),
    planAssignmentActivity({
      from: 'open',
      providerId: PROVIDER_ID,
      priority: 'high',
      priorityChanged: true,
      priorityReasons: ['model_suggestion_capped'],
    }),
    planCompletionActivity({
      from: 'awaiting_approval',
      resolutionSummary: 'Done.',
      evidenceDocumentIds: [DOCUMENT_ID],
    }),
    planPriorityActivity({
      from: 'low',
      to: 'normal',
      reasons: ['no_downgrade_floor'],
      decidedBy: 'staff_override',
    }),
  ];

  it('every planned metadata object satisfies the shared MetadataSchema', () => {
    for (const plan of plans) {
      expect(MetadataSchema.safeParse({ ...plan.metadata }).success).toBe(true);
    }
  });

  it('carries no free text under any key', () => {
    // Every string value must be a controlled token: snake_case or a UUID. A sentence
    // would fail this, which is how "no personal data in an append-only column" is
    // kept honest as the planners grow.
    const token = /^[a-z0-9_]+$|^[0-9a-f-]{36}$/;
    for (const plan of plans) {
      for (const [key, value] of Object.entries(plan.metadata)) {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) {
          if (typeof item !== 'string') continue;
          expect(token.test(item), `${key} = ${item}`).toBe(true);
        }
      }
    }
  });

  it('puts the human resolution summary in `description`, never in metadata', () => {
    const summary = 'Replaced the compressor; tenant confirmed the room is cooling.';
    const plan = planCompletionActivity({
      from: 'awaiting_approval',
      resolutionSummary: summary,
      evidenceDocumentIds: [],
    });
    expect(plan.description).toBe(summary);
    expect(JSON.stringify(plan.metadata)).not.toContain('compressor');
  });

  it('builds server-written descriptions from status names, never from request input', () => {
    expect(planTransitionActivity('open', 'cancelled').description).toBe(
      'Status changed from open to cancelled.',
    );
  });
});

describe('the client/server split of activity types', () => {
  it('covers every shared activity type exactly once', () => {
    const union = [...SERVER_WRITTEN_ACTIVITY_TYPES, ...CLIENT_ACTIVITY_TYPES].sort();
    expect(union).toEqual([...ACTIVITY_TYPES].sort());
    expect(new Set(union).size).toBe(ACTIVITY_TYPES.length);
  });

  it('lets a human post only a comment or an evidence pointer', () => {
    expect([...CLIENT_ACTIVITY_TYPES].sort()).toEqual(['comment_added', 'evidence_attached']);
  });

  it('refuses every transition type from a client', () => {
    for (const type of SERVER_WRITTEN_ACTIVITY_TYPES) {
      expect(isClientPostableActivityType(type)).toBe(false);
    }
  });

  it('refuses the types the mutation routes write, so a timeline cannot be forged', () => {
    // The specific worry: `status_changed`. A client able to post it could add a second
    // transition row for an edge that never happened, in a table that can never be
    // corrected.
    expect(isClientPostableActivityType('status_changed')).toBe(false);
    expect(isClientPostableActivityType('provider_assigned')).toBe(false);
    expect(isClientPostableActivityType('completion_confirmed')).toBe(false);
    expect(isClientPostableActivityType('ticket_created')).toBe(false);
  });
});

describe('the description bound', () => {
  it('matches CreateActivitySchema’s limit', () => {
    expect(ACTIVITY_DESCRIPTION_MAX_LENGTH).toBe(1000);
  });
});
