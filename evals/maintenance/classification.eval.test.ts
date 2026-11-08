/**
 * Classification quality evals. Lane w1-l5.
 *
 * OFFLINE. Runs with no credential, against synthesised fixtures — see
 * `fixtures/recordings.json` and `recorded-transport.ts` for exactly what that does and
 * does not prove. `live.eval.test.ts` is the only file here that touches a real model.
 *
 * Run with `npx vitest run evals` or `PS_EVALS=1 npx vitest run`. The suite is excluded
 * from the default `vitest run` by `vitest.config.ts` (lane w0-l6), so a plain unit run
 * stays fast and this set is asked for deliberately.
 */

import { describe, expect, it } from 'vitest';

import { ClassificationSchema } from '@shared/index';
import {
  ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT,
  promptFingerprint,
} from '@/services/ai/prompts/registry';

import { AMBIGUOUS_CONTEXT, CONTRACT_FIELDS, runCase } from './harness';
import { recordings } from './recorded-transport';

describe('recording integrity', () => {
  it('states its provenance honestly', () => {
    // If this ever reads `recorded`, a real transcript exists and the claims these evals
    // support become claims about the model, not only about the application.
    expect(['recorded', 'synthesised']).toContain(recordings().provenance);
  });

  it('was written against the prompt version that is active', () => {
    const active = ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT;
    expect(recordings().prompt_version).toBe(active.version);
    // A single, explicit staleness gate. When the prompt changes, exactly this test
    // fails, which is the signal to re-record rather than to adjust assertions.
    expect(recordings().prompt_fingerprint).toBe(promptFingerprint(active));
  });
});

describe('HVAC is classified correctly', () => {
  it('lands in the hvac category with no clarification needed', async () => {
    const outcome = await runCase('hvac-not-cooling');

    expect(outcome.classification.category).toBe('hvac');
    expect(outcome.draft.requires_clarification).toBe(false);
    expect(outcome.draft.clarification_question).toBeNull();
    expect(outcome.attempts).toBe(1);
  });

  it('captures the symptoms without inventing a unit or a tenant', async () => {
    const outcome = await runCase('hvac-not-cooling');

    expect(outcome.draft.reported_symptoms.join(' ')).toContain('not cooling');
    expect(Object.keys(outcome.draft).sort()).toEqual([...CONTRACT_FIELDS]);
  });

  it('gets a deterministic priority, not the model’s', async () => {
    const outcome = await runCase('hvac-not-cooling');

    // The fixture suggests `high`; the hvac baseline is `normal`, one step below, so the
    // suggestion is applied rather than capped — and the reason code says which happened.
    expect(outcome.priority.suggestedPriority).toBe('high');
    expect(outcome.priority.priority).toBe('high');
    expect(outcome.priority.reasons).toContain('model_suggestion_applied');
    expect(outcome.priority.priority).not.toBe('urgent');
  });
});

describe('plumbing is classified correctly', () => {
  it('lands in the plumbing category', async () => {
    const outcome = await runCase('plumbing-leak');

    expect(outcome.classification.category).toBe('plumbing');
    expect(outcome.draft.requires_clarification).toBe(false);
    expect(outcome.draft.missing_information.length).toBeGreaterThan(0);
  });

  it('is not escalated to urgent by the model alone', async () => {
    const outcome = await runCase('plumbing-leak');
    expect(outcome.priority.priority).not.toBe('urgent');
  });

  it('is capped at normal when nobody lives in the unit', async () => {
    const outcome = await runCase('plumbing-leak', {
      trusted: { unitResolution: 'resolved', candidateUnitCount: 1, hasActiveTenancy: false },
    });
    expect(outcome.priority.priority).toBe('normal');
    expect(outcome.priority.reasons).toContain('vacant_unit_cap');
  });
});

describe('missing context yields requires_clarification', () => {
  it('asks a question when the message says almost nothing', async () => {
    const outcome = await runCase('missing-context');

    expect(outcome.draft.requires_clarification).toBe(true);
    expect(outcome.draft.clarification_question).toBeTruthy();
    expect(outcome.draft.missing_information.length).toBeGreaterThan(0);
    expect(outcome.classification.category).toBe('unknown');
  });

  it('asks which unit when the server cannot resolve one, overriding the model’s question', async () => {
    const outcome = await runCase('hvac-not-cooling', { trusted: AMBIGUOUS_CONTEXT });

    expect(outcome.classification.requires_clarification).toBe(false);
    expect(outcome.draft.requires_clarification).toBe(true);
    expect(outcome.draft.clarification_question).toContain('Which of your units');
  });

  it('tells the model the unit is ambiguous without naming any unit', async () => {
    const outcome = await runCase('hvac-not-cooling', { trusted: AMBIGUOUS_CONTEXT });
    const turn = outcome.transport.requests[0]?.userTurns[0] ?? '';

    expect(turn).toContain('unit_resolution: ambiguous');
    expect(turn).toContain('candidate_unit_count: 3');
    expect(turn).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  });

  it('produces a draft that the confirm endpoint will refuse', async () => {
    const outcome = await runCase('missing-context');
    // The confirm route rejects `requires_clarification: true` with 422 — asserted in
    // `tests/ai/routes.test.ts`. This is the eval-side half of the same guarantee.
    expect(outcome.draft.requires_clarification).toBe(true);
  });
});

describe('every offline case stays inside the output contract', () => {
  const successful = [
    'hvac-not-cooling',
    'plumbing-leak',
    'missing-context',
    'prompt-injection-obeyed-contract',
    'malformed-then-valid',
    'truncated-output',
  ] as const;

  for (const id of successful) {
    it(`${id} produces a schema-valid draft with exactly the contract fields`, async () => {
      const outcome = await runCase(id);
      expect(ClassificationSchema.safeParse(outcome.draft).success).toBe(true);
      expect(Object.keys(outcome.draft).sort()).toEqual([...CONTRACT_FIELDS]);
      expect(outcome.promptVersion).toBe(ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT.version);
    });
  }
});
