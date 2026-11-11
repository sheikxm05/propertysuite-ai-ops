/**
 * Malformed document-extraction output: the safe-reject path. Lane w1-l5. OFFLINE.
 *
 * Same specification as maintenance classification — retry once, then fail, never
 * partially apply — asserted against the extraction contract, because the two share one
 * implementation (`runValidatedCall` in `services/ai/providers/provider.ts`) and a shared
 * implementation deserves evidence on both of its paths.
 */

import { describe, expect, it } from 'vitest';

import { AiOutputInvalidError, AiUnsupportedError } from '@/services/ai/errors';

import { DOCUMENT_CONTRACT_FIELDS, adapterFor, runCase } from './harness';

describe('malformed JSON is rejected safely', () => {
  it('retries once and then fails, rather than looping or guessing', async () => {
    const { transport, extract } = adapterFor('malformed-json-twice');

    const thrown = await extract('TENANCY CONTRACT\nTenant: Lina Haddad').catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(AiOutputInvalidError);
    expect(transport.requests).toHaveLength(2);
    expect((thrown as AiOutputInvalidError).attempts).toBe(2);
    expect((thrown as AiOutputInvalidError).rejection).toBe('not_json');
  });

  it('never resolves, so no field can be partially applied', async () => {
    const { extract } = adapterFor('malformed-json-twice');

    let resolved: unknown = 'not-set';
    await extract('TENANCY CONTRACT\nTenant: Lina Haddad').then(
      (value) => {
        resolved = value;
      },
      () => {
        /* expected */
      },
    );
    expect(resolved).toBe('not-set');
  });

  it('does not leak the document or the rejected reply into the error', async () => {
    const { extract } = adapterFor('malformed-json-twice');
    const thrown = (await extract('TENANCY CONTRACT\nTenant: Lina Haddad').catch(
      (error: unknown) => error,
    )) as AiOutputInvalidError;

    // The first recorded reply falsely claims the contract was verified and approved.
    expect(thrown.message).not.toContain('verified');
    expect(thrown.message).not.toContain('Lina Haddad');
    expect(JSON.stringify(thrown.logFields)).not.toContain('Lina Haddad');
  });

  it('refuses empty document text before calling the model at all', async () => {
    const { transport, extract } = adapterFor('clean-tenancy-contract');
    await expect(extract('   ')).rejects.toBeInstanceOf(AiUnsupportedError);
    expect(transport.requests).toHaveLength(0);
  });
});

describe('a recoverable reply is recovered, not accepted as-is', () => {
  it('rejects a reply with an extra key, then takes the clean retry', async () => {
    const outcome = await runCase('malformed-then-valid');

    expect(outcome.attempts).toBe(2);
    expect(Object.keys(outcome.extraction).sort()).toEqual([...DOCUMENT_CONTRACT_FIELDS]);
    // The first reply carried `document_type`; the accepted one does not. The document is
    // not allowed to tell the application what kind of document it is.
    expect(JSON.stringify(outcome.extraction)).not.toContain('document_type');
  });

  it('normalises the recovered money value rather than trusting its formatting', async () => {
    const outcome = await runCase('malformed-then-valid');
    expect(outcome.extraction.rent_amount).toBe('132500.50');
  });

  it('refuses a truncated reply even though it parses, then takes the retry', async () => {
    const outcome = await runCase('truncated-output');

    expect(outcome.attempts).toBe(2);
    expect(outcome.extraction.property_address).toBe('Plot 441, Al Quoz, Dubai');
    // The second reply explains what the first could not; the first was discarded whole.
    expect(outcome.extraction.confidence_notes.length).toBeGreaterThan(0);
  });

  it('keeps review required on every recovered reply', async () => {
    for (const id of ['malformed-then-valid', 'truncated-output']) {
      const outcome = await runCase(id);
      expect(outcome.extraction.requires_human_review, id).toBe(true);
    }
  });
});
