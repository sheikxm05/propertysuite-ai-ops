/**
 * Malformed-output evals: the safe-reject path. Lane w1-l5. OFFLINE.
 *
 * "Retry once, then fail with a user-facing message. Never partially apply a malformed
 * response." Each clause is asserted, and the last one is asserted by observation rather
 * than by inspection: the promise rejects, so there is no value for a caller to hold.
 */

import { describe, expect, it } from 'vitest';

import { AiOutputInvalidError } from '@/services/ai/errors';

import { CONTRACT_FIELDS, adapterFor, runCase } from './harness';

describe('malformed JSON is rejected safely', () => {
  it('retries once and then fails, rather than looping or guessing', async () => {
    const { transport, classify } = adapterFor('malformed-json-twice');

    const thrown = await classify('The AC is not cooling.').catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AiOutputInvalidError);
    expect(transport.requests).toHaveLength(2);
    expect((thrown as AiOutputInvalidError).attempts).toBe(2);
    expect((thrown as AiOutputInvalidError).rejection).toBe('not_json');
  });

  it('fails with a user-facing message that does not mention creating anything', async () => {
    const { classify } = adapterFor('malformed-json-twice');
    const thrown = (await classify('The AC is not cooling.').catch(
      (error: unknown) => error,
    )) as AiOutputInvalidError;

    expect(thrown.userMessage).toContain('could not produce a usable draft');
    expect(thrown.userMessage.toLowerCase()).not.toContain('created');
    expect(thrown.errorCode).toBe('UNPROCESSABLE');
  });

  it('never resolves, so nothing can be partially applied', async () => {
    const { classify } = adapterFor('malformed-json-twice');

    let resolved: unknown = 'not-set';
    await classify('The AC is not cooling.').then(
      (value) => {
        resolved = value;
      },
      () => {
        /* expected */
      },
    );
    expect(resolved).toBe('not-set');
  });

  it('does not leak the rejected reply into the error', async () => {
    const { classify } = adapterFor('malformed-json-twice');
    const thrown = (await classify('The AC is not cooling.').catch(
      (error: unknown) => error,
    )) as AiOutputInvalidError;

    // The first recorded reply falsely claims a ticket was logged. That sentence must not
    // travel anywhere: not to the client, and not into a log field.
    expect(thrown.message).not.toContain("I've logged that for you");
    expect(JSON.stringify(thrown.logFields)).not.toContain('logged that for you');
  });
});

describe('a recoverable reply is recovered, not accepted as-is', () => {
  it('rejects a reply with an extra key, then takes the clean retry', async () => {
    const outcome = await runCase('malformed-then-valid');

    expect(outcome.attempts).toBe(2);
    expect(outcome.classification.category).toBe('electrical');
    expect(Object.keys(outcome.draft).sort()).toEqual([...CONTRACT_FIELDS]);
    // The first reply carried `notes`; the accepted one does not.
    expect(JSON.stringify(outcome.draft)).not.toContain('notes');
  });

  it('refuses a truncated reply even though it parses, then takes the retry', async () => {
    const outcome = await runCase('truncated-output');

    // The first recorded reply is valid JSON with stop_reason max_tokens.
    expect(outcome.attempts).toBe(2);
    expect(outcome.classification.category).toBe('pest_control');
  });

  it('keeps electrical at its own high baseline rather than the model’s opinion', async () => {
    const outcome = await runCase('malformed-then-valid');
    // `electrical` baselines at `high` because of shock and fire risk, independent of what
    // the model suggested.
    expect(outcome.priority.priority).toBe('high');
    expect(outcome.priority.reasons).toContain('category_baseline');
  });
});
