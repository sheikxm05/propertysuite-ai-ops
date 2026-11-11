/**
 * Strict output validation and the safe-reject path. Lane w1-l5.
 *
 * The specification is "validate against `ClassificationSchema`; retry once; then fail
 * with a user-facing message; never partially apply a malformed response." Each clause
 * gets its own assertions below, and the last one is the important one: when the adapter
 * rejects, it throws, so there is no object for a caller to half-believe.
 */

import { describe, expect, it } from 'vitest';

import { AiOutputInvalidError, AiUnsupportedError } from '@/services/ai/errors';
import { createClassificationProvider, evaluateReply } from '@/services/ai/providers/provider';

import { scriptedTransport, validClassificationJson } from './_support/scripted-transport';

const MODEL = 'model-under-test';
const TRUSTED = {
  unitResolution: 'resolved' as const,
  candidateUnitCount: 1,
  hasActiveTenancy: true,
};

function adapterFor(replies: readonly { text: string; stopReason?: string | null }[]) {
  const transport = scriptedTransport(replies);
  return {
    transport,
    adapter: createClassificationProvider({ transport, model: MODEL }),
  };
}

const classify = (
  replies: readonly { text: string; stopReason?: string | null }[],
  message = 'The AC is running but not cooling.',
) => {
  const { transport, adapter } = adapterFor(replies);
  return {
    transport,
    promise: adapter.classify({ untrusted: { tenantMessage: message }, trusted: TRUSTED }),
  };
};

describe('evaluateReply', () => {
  it('accepts a schema-valid object', () => {
    const verdict = evaluateReply(validClassificationJson(), 'end_turn');
    expect(verdict.ok).toBe(true);
  });

  it('rejects an empty reply', () => {
    expect(evaluateReply('   ', 'end_turn')).toMatchObject({ ok: false, rejection: 'empty' });
  });

  it('rejects a truncated reply before parsing it', () => {
    // Deliberately valid JSON: a `max_tokens` stop means the content was cut, so even a
    // parseable reply is not trustworthy.
    expect(evaluateReply(validClassificationJson(), 'max_tokens')).toMatchObject({
      ok: false,
      rejection: 'stopped_early',
    });
  });

  it('rejects malformed JSON', () => {
    expect(evaluateReply('{ "category": "hvac", ', 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'not_json',
    });
    expect(evaluateReply('I think the AC is broken.', 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'not_json',
    });
  });

  it('rejects a JSON array or scalar', () => {
    expect(evaluateReply('[1,2,3]', 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'not_object',
    });
    expect(evaluateReply('"hvac"', 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'not_object',
    });
  });

  it('rejects an oversized reply without parsing it', () => {
    expect(evaluateReply('x'.repeat(20_001), 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'too_large',
    });
  });

  it('rejects an unknown field, because an extra key means the contract was not followed', () => {
    const withExtra = validClassificationJson({ assigned_provider_id: 'abc' });
    expect(evaluateReply(withExtra, 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'schema_rejected',
    });
  });

  it('rejects an out-of-vocabulary category', () => {
    expect(
      evaluateReply(validClassificationJson({ category: 'emergency' }), 'end_turn'),
    ).toMatchObject({ ok: false, rejection: 'schema_rejected' });
  });

  it('rejects the clarification contradiction the schema refines against', () => {
    const contradictory = validClassificationJson({
      requires_clarification: true,
      clarification_question: null,
    });
    expect(evaluateReply(contradictory, 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'schema_rejected',
    });
  });

  it('tolerates a markdown fence, which is presentation rather than content', () => {
    const fenced = ['```json', validClassificationJson(), '```'].join('\n');
    expect(evaluateReply(fenced, 'end_turn').ok).toBe(true);
  });

  it('tolerates leading prose but not altered content', () => {
    const withProse = `Here is the classification:\n${validClassificationJson()}\nHope that helps.`;
    expect(evaluateReply(withProse, 'end_turn').ok).toBe(true);

    const withProseAndBadCategory = `Sure:\n${validClassificationJson({ category: 'nope' })}`;
    expect(evaluateReply(withProseAndBadCategory, 'end_turn')).toMatchObject({
      ok: false,
      rejection: 'schema_rejected',
    });
  });

  it('does not swallow a brace that lives inside a string value', () => {
    const tricky = validClassificationJson({ summary: 'The panel reads "ERR {3}" on the wall.' });
    const verdict = evaluateReply(tricky, 'end_turn');
    expect(verdict.ok).toBe(true);
  });
});

describe('the retry', () => {
  it('retries exactly once and succeeds on the second reply', async () => {
    const { transport, promise } = classify([
      { text: 'sorry, I cannot do that' },
      { text: validClassificationJson() },
    ]);
    const result = await promise;
    expect(result.attempts).toBe(2);
    expect(transport.requests).toHaveLength(2);
    expect(result.classification.category).toBe('hvac');
  });

  it('fails after the second rejection, with a user-facing message', async () => {
    const { transport, promise } = classify([{ text: 'nope' }, { text: 'still nope' }]);

    await expect(promise).rejects.toBeInstanceOf(AiOutputInvalidError);
    expect(transport.requests).toHaveLength(2);

    const error = await promise.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AiOutputInvalidError);
    const typed = error as AiOutputInvalidError;
    expect(typed.attempts).toBe(2);
    expect(typed.rejection).toBe('not_json');
    expect(typed.errorCode).toBe('UNPROCESSABLE');
    expect(typed.userMessage).toContain('could not produce a usable draft');
  });

  it('never makes a third attempt', async () => {
    // The scripted transport throws when asked for a reply it has no script for, so a
    // third call would surface as that error rather than as AiOutputInvalidError.
    const { promise } = classify([{ text: 'a' }, { text: 'b' }]);
    await expect(promise).rejects.toBeInstanceOf(AiOutputInvalidError);
  });
});

describe('nothing is partially applied', () => {
  it('returns no object at all when the reply is rejected', async () => {
    const { promise } = classify([
      { text: validClassificationJson({ category: 'nope' }) },
      { text: validClassificationJson({ summary: 'ab' }) },
    ]);

    let resolved: unknown = 'not-set';
    await promise.then(
      (value) => {
        resolved = value;
      },
      () => {
        /* expected */
      },
    );
    expect(resolved).toBe('not-set');
  });

  it('carries no model text on the error, so a rejection cannot leak the reply', async () => {
    const secret = 'tenant phone 0501234567';
    const { promise } = classify([{ text: secret }, { text: secret }]);
    const error = (await promise.catch((thrown: unknown) => thrown)) as AiOutputInvalidError;

    expect(error.message).not.toContain(secret);
    expect(error.userMessage).not.toContain(secret);
    expect(JSON.stringify(error.logFields)).not.toContain(secret);
  });

  it('refuses an empty message before calling the model at all', async () => {
    const { transport, adapter } = adapterFor([{ text: validClassificationJson() }]);
    await expect(
      adapter.classify({ untrusted: { tenantMessage: '   ' }, trusted: TRUSTED }),
    ).rejects.toBeInstanceOf(AiUnsupportedError);
    expect(transport.requests).toHaveLength(0);
  });
});

describe('the result metadata', () => {
  it('reports the prompt version, model, attempts and token counts', async () => {
    const { promise } = classify([{ text: validClassificationJson() }]);
    const result = await promise;

    expect(result.promptVersion).toBe('maintenance-classification/v1');
    expect(result.model).toBe(MODEL);
    expect(result.attempts).toBe(1);
    expect(result.tokensIn).toBe(100);
    expect(result.tokensOut).toBe(50);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.fenced.map((section) => section.label)).toEqual(['tenant_message']);
  });

  it('exposes only the seven contract fields on the classification', async () => {
    const { promise } = classify([{ text: validClassificationJson() }]);
    const result = await promise;

    expect(Object.keys(result.classification).sort()).toEqual([
      'category',
      'clarification_question',
      'missing_information',
      'reported_symptoms',
      'requires_clarification',
      'suggested_priority',
      'summary',
    ]);
  });
});
