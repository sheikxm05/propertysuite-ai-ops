/**
 * Draft assembly and the clarification overlay. Lane w1-l5.
 *
 * The behaviour under test is the one that keeps the confirm button honest: when the
 * server cannot say which unit a message is about, the draft must ask — no matter how
 * confident the model was — and the confirm route refuses a draft that is still asking.
 */

import { describe, expect, it } from 'vitest';

import { ClassificationSchema, type Classification } from '@shared/index';
import {
  MISSING_UNIT_MARKER,
  UNIT_CLARIFICATION_QUESTIONS,
  applyUnitClarification,
  suggestDescription,
  suggestTitle,
} from '@/services/ai/maintenance/draft';

function classification(overrides: Partial<Classification> = {}): Classification {
  return ClassificationSchema.parse({
    category: 'hvac',
    summary: 'Air conditioning is running but not cooling. It started last night.',
    reported_symptoms: ['AC running', 'room not cooling'],
    suggested_priority: 'normal',
    missing_information: [],
    requires_clarification: false,
    clarification_question: null,
    ...overrides,
  });
}

describe('applyUnitClarification', () => {
  it('leaves a confident draft alone when the unit is resolved', () => {
    const draft = classification();
    expect(applyUnitClarification(draft, { resolution: 'resolved' })).toEqual(draft);
  });

  it('keeps the model’s own question when the unit is resolved', () => {
    const draft = classification({
      requires_clarification: true,
      clarification_question: 'Is the water hot or cold?',
    });
    const result = applyUnitClarification(draft, { resolution: 'resolved' });
    expect(result.clarification_question).toBe('Is the water hot or cold?');
  });

  it('forces clarification when more than one unit is possible', () => {
    const result = applyUnitClarification(classification(), { resolution: 'ambiguous' });
    expect(result.requires_clarification).toBe(true);
    expect(result.clarification_question).toBe(UNIT_CLARIFICATION_QUESTIONS.ambiguous);
    expect(result.missing_information).toContain(MISSING_UNIT_MARKER);
  });

  it('overrides the model’s question with the server’s, which is the actionable one', () => {
    const result = applyUnitClarification(
      classification({
        requires_clarification: true,
        clarification_question: 'Which room is affected?',
      }),
      { resolution: 'ambiguous' },
    );
    expect(result.clarification_question).toBe(UNIT_CLARIFICATION_QUESTIONS.ambiguous);
  });

  it('points at a human when there is no active tenancy at all', () => {
    const result = applyUnitClarification(classification(), { resolution: 'none' });
    expect(result.clarification_question).toBe(UNIT_CLARIFICATION_QUESTIONS.none);
  });

  it('still produces a schema-valid draft when missing_information is already full', () => {
    const full = Array.from({ length: 20 }, (_, index) => `fact ${index}`);
    const result = applyUnitClarification(classification({ missing_information: full }), {
      resolution: 'ambiguous',
    });
    expect(ClassificationSchema.safeParse(result).success).toBe(true);
    expect(result.missing_information.length).toBeLessThanOrEqual(20);
  });

  it('does not change the category or the suggested priority', () => {
    const draft = classification({ category: 'plumbing', suggested_priority: 'high' });
    const result = applyUnitClarification(draft, { resolution: 'ambiguous' });
    expect(result.category).toBe('plumbing');
    expect(result.suggested_priority).toBe('high');
  });
});

describe('suggestTitle', () => {
  it('cuts the first sentence of the summary', () => {
    expect(suggestTitle(classification())).toBe('Air conditioning is running but not cooling');
  });

  it('bounds a long summary to the TitleSchema maximum', () => {
    const title = suggestTitle(classification({ summary: 'a'.repeat(400) }));
    expect(title).not.toBeNull();
    expect((title ?? '').length).toBeLessThanOrEqual(200);
  });

  it('returns null rather than a fragment that fails validation', () => {
    expect(suggestTitle(classification({ summary: 'ab.' }))).toBeNull();
  });
});

describe('suggestDescription', () => {
  it('appends the reported symptoms so the description clears its minimum', () => {
    const description = suggestDescription(classification());
    expect(description).toContain('Reported: AC running; room not cooling.');
  });

  it('returns null when nothing long enough can be assembled', () => {
    expect(
      suggestDescription(classification({ summary: 'Hot.', reported_symptoms: [] })),
    ).toBeNull();
  });
});
