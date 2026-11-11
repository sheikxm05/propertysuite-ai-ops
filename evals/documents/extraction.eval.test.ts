/**
 * Document field extraction evals. Lane w1-l5. OFFLINE.
 *
 * Runs with no credential, against synthesised fixtures — see `fixtures/recordings.json`
 * and `evals/_support/recordings.ts` for exactly what that does and does not prove.
 * `live.eval.test.ts` is the only file here that touches a real model.
 *
 * Run with `npx vitest run evals` or `PS_EVALS=1 npx vitest run`.
 */

import { describe, expect, it } from 'vitest';

import { DocumentExtractionSchema } from '@shared/index';
import {
  ACTIVE_DOCUMENT_EXTRACTION_PROMPT,
  promptFingerprint,
} from '@/services/ai/prompts/registry';

import {
  DOCUMENT_CONTRACT_FIELDS,
  UNKNOWN_TYPE_CONTEXT,
  recordings,
  runCase,
  runnableIds,
} from './harness';

describe('recording integrity', () => {
  it('states its provenance honestly', () => {
    expect(['recorded', 'synthesised']).toContain(recordings().provenance);
  });

  it('was written against the prompt version that is active', () => {
    const active = ACTIVE_DOCUMENT_EXTRACTION_PROMPT;
    expect(recordings().prompt_version).toBe(active.version);
    // The single, explicit staleness gate. When the prompt changes, exactly this test
    // fails, which is the signal to re-record rather than to adjust assertions.
    expect(recordings().prompt_fingerprint).toBe(promptFingerprint(active));
  });
});

describe('a clean tenancy contract is extracted correctly', () => {
  it('returns every field the document states', async () => {
    const outcome = await runCase('clean-tenancy-contract');

    expect(outcome.extraction.tenant_name).toBe('Aisha Rahman');
    expect(outcome.extraction.contract_number).toBe('EJ-2026-114857');
    expect(outcome.extraction.property_address).toContain('Marina Heights');
    expect(outcome.attempts).toBe(1);
  });

  it('uses ISO 8601 dates and keeps amount separate from currency', async () => {
    const outcome = await runCase('clean-tenancy-contract');

    expect(outcome.extraction.start_date).toBe('2026-03-15');
    expect(outcome.extraction.end_date).toBe('2027-03-14');
    // `MoneyAmountSchema` normalises to a fixed-scale decimal string: never a float.
    expect(outcome.extraction.rent_amount).toBe('145000.00');
    expect(outcome.extraction.currency).toBe('AED');
    expect(String(outcome.extraction.rent_amount)).not.toMatch(/AED|,/);
  });

  it('is schema-valid with exactly the nine contract fields', async () => {
    const outcome = await runCase('clean-tenancy-contract');
    expect(DocumentExtractionSchema.safeParse(outcome.extraction).success).toBe(true);
    expect(Object.keys(outcome.extraction).sort()).toEqual([...DOCUMENT_CONTRACT_FIELDS]);
  });

  it('reports the prompt version that produced it', async () => {
    const outcome = await runCase('clean-tenancy-contract');
    expect(outcome.promptVersion).toBe(ACTIVE_DOCUMENT_EXTRACTION_PROMPT.version);
  });
});

describe('ambiguity becomes null plus a note, per the contract', () => {
  it('returns null for a field with two candidate values', async () => {
    const outcome = await runCase('ambiguous-rent');
    expect(outcome.extraction.rent_amount).toBeNull();
  });

  it('explains the ambiguity in confidence_notes', async () => {
    const outcome = await runCase('ambiguous-rent');
    expect(outcome.extraction.confidence_notes.length).toBeGreaterThan(0);
    expect(outcome.extraction.confidence_notes.join(' ')).toMatch(/210,000|195,000/);
  });

  it('still extracts the fields that are unambiguous', async () => {
    const outcome = await runCase('ambiguous-rent');
    expect(outcome.extraction.start_date).toBe('2026-06-01');
    expect(outcome.extraction.tenant_name).toBe('Omar Haddad');
  });
});

describe('a sparse document produces nulls, not invented values', () => {
  it('returns null for every field the document does not state', async () => {
    const outcome = await runCase('sparse-document', { trusted: UNKNOWN_TYPE_CONTEXT });

    expect(outcome.extraction.tenant_name).toBeNull();
    expect(outcome.extraction.contract_number).toBeNull();
    expect(outcome.extraction.property_address).toBeNull();
    expect(outcome.extraction.start_date).toBeNull();
    expect(outcome.extraction.end_date).toBeNull();
    expect(outcome.extraction.rent_amount).toBeNull();
    expect(outcome.extraction.currency).toBeNull();
  });

  it('says why, so the human reviewer is not left guessing', async () => {
    const outcome = await runCase('sparse-document', { trusted: UNKNOWN_TYPE_CONTEXT });
    expect(outcome.extraction.confidence_notes.length).toBeGreaterThan(0);
  });

  it('does not assume a currency the document never names', async () => {
    const outcome = await runCase('sparse-document', { trusted: UNKNOWN_TYPE_CONTEXT });
    expect(outcome.extraction.currency).toBeNull();
  });
});

describe('every runnable case stays inside the output contract', () => {
  const ids = runnableIds().filter((id) => id !== 'malformed-json-twice');

  it('has cases to run', () => {
    expect(ids.length).toBeGreaterThanOrEqual(6);
  });

  for (const id of ids) {
    it(`${id} is schema-valid, nine fields, review required`, async () => {
      const outcome = await runCase(id, { trusted: UNKNOWN_TYPE_CONTEXT });
      expect(DocumentExtractionSchema.safeParse(outcome.extraction).success).toBe(true);
      expect(Object.keys(outcome.extraction).sort()).toEqual([...DOCUMENT_CONTRACT_FIELDS]);
      // The invariant, on every single case.
      expect(outcome.extraction.requires_human_review).toBe(true);
    });
  }
});
