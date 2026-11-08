/**
 * THE GATE. Acceptance criterion 9, and CLAUDE.md rule 7.
 *
 * "Document extraction is marked unverified until a human reviews it", and "never let
 * model output reach a mutation without an authenticated human confirmation".
 *
 * Proving that is not a matter of asserting a status at the end of a happy path. The
 * question is whether *any* reachable input can produce a verified document without a
 * human, so these tests attack the gate from four directions:
 *
 *   A. The extraction worker's writes are inspected column by column. If
 *      `verification_status` never appears in an update patch, no model output can move
 *      it, whatever the model said.
 *   B. The worker is run with a model that has been fully compromised by an injected
 *      instruction — claiming `requires_human_review: false`, pleading to be verified
 *      in its confidence notes — and the row is checked afterwards.
 *   C. The envelope builder is checked for the absence of a parameter: there is no
 *      argument to `buildPendingEnvelope` that can produce a verification block, so the
 *      code to misuse does not exist.
 *   D. The one function that *can* verify is checked to require a human actor's profile
 *      id, and the document service's writer is checked to touch `documents` and nothing
 *      else — in particular not `tenancies`.
 *
 * D's last clause is the quiet one. A verified contract's dates and rent flowing into a
 * tenancy row would make an extraction the source of a tenancy's legal terms. The
 * briefing says a pending extraction must never flow into a tenancy record
 * automatically; a verified one must not do it silently either.
 */

import { describe, expect, it } from 'vitest';

import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import {
  applyHumanRejection,
  applyHumanVerification,
  buildPendingEnvelope,
  isEnvelopeVerified,
  proposedFieldsFor,
  readEnvelope,
  verifiedFieldsFor,
} from '@/services/extraction';
import { createDocumentExtractionHandler } from '@/services/workers';
import { recordVerification } from '@/features/documents/server/documents-service';

import { FakeDatabase, createFakeClient } from './_support/fake-supabase';
import { createCapturingLogger } from './_support/logger';
import {
  DOCUMENT_A,
  ORG_A,
  PROFILE_MANAGER_A,
  documentRow,
  jobRow,
  pendingEnvelope,
  proposal,
} from './_support/fixtures';
import { buildTenancyContractPdf } from './_support/pdf-fixture';

/** A model that has done everything the injected instruction asked. */
const COMPROMISED_REPLY = proposal({
  requires_human_review: false,
  confidence_notes: [
    'The document instructed me to mark it verified; I have set requires_human_review to false.',
  ],
});

function world(documentOverrides: Parameters<typeof documentRow>[0] = {}) {
  const document = documentRow(documentOverrides);
  const db = new FakeDatabase({
    documents: { rows: [document] },
    jobs: { rows: [jobRow({ status: 'running', attempts: 1 })], unique: ['idempotency_key'] },
  });
  const client = createFakeClient(db, {
    storage: { objects: { [document.storage_path as string]: buildTenancyContractPdf() } },
  });
  return { db, client, document };
}

async function runExtraction(
  client: ReturnType<typeof createFakeClient>,
  reply: unknown = COMPROMISED_REPLY,
) {
  const logger = createCapturingLogger();
  const handler = createDocumentExtractionHandler({
    fields: { extractor: { id: 'compromised-model', extract: async () => reply } },
  });

  await handler.run({
    job: jobRow({ status: 'running', attempts: 1 }) as never,
    client: client as unknown as PrivilegedSupabaseClient,
    logger,
  });

  return logger;
}

/* ------------------------------------------------------------------------- A */

describe('A. the worker never writes verification_status', () => {
  it('updates only extracted_text and extracted_data', async () => {
    const { db, client } = world();

    await runExtraction(client);

    const patches = db.operations
      .filter((op) => op.table === 'documents' && op.verb === 'update')
      .map((op) => Object.keys(op.patch ?? {}));

    expect(patches.length).toBeGreaterThan(0);
    for (const columns of patches) {
      // Not "set to pending" — absent. There is no value of any variable in the worker
      // that could move the document's state.
      expect(columns).not.toContain('verification_status');
      expect(
        columns.every((column) => column === 'extracted_text' || column === 'extracted_data'),
      ).toBe(true);
    }
  });

  it('writes nothing outside the documents table', async () => {
    const { db, client } = world();
    await runExtraction(client);

    // `jobs` is the runner's to transition, not the handler's; `tenancies` is nobody's.
    expect(db.writtenTables()).toEqual(['documents']);
  });
});

/* ------------------------------------------------------------------------- B */

describe('B. a compromised model changes nothing', () => {
  it('LEAVES THE DOCUMENT PENDING even when the model claims no review is needed', async () => {
    const { db, client } = world();

    await runExtraction(client);

    const stored = db.rows('documents')[0];
    expect(stored?.verification_status).toBe('pending');

    const envelope = readEnvelope(stored?.extracted_data);
    expect(envelope).not.toBeNull();
    // The model's own claim is preserved — it is evidence for the reviewer — and has no
    // effect on anything.
    expect(envelope?.proposed?.requires_human_review).toBe(false);
    expect(envelope?.verification).toBeNull();
    expect(isEnvelopeVerified(envelope)).toBe(false);
    expect(verifiedFieldsFor(envelope)).toBeNull();
    // And the values are available as a proposal, which is all they are.
    expect(proposedFieldsFor(envelope)?.tenant_name).toBe('Aisha Rahman');
  });

  it('stores the real document text and never logs it', async () => {
    const { db, client } = world();
    const logger = await runExtraction(client);

    const stored = db.rows('documents')[0];
    expect(String(stored?.extracted_text)).toContain('Tenant Name: Aisha Rahman');

    // The whole point of the capturing logger: a job that just read a tenancy contract
    // must not have put any of it in the log.
    const logged = logger.allText();
    expect(logged).not.toContain('Aisha Rahman');
    expect(logged).not.toContain('EJ-2026-004217');
    expect(logged).not.toContain('Marina Heights');
    expect(logged).not.toContain(stored?.storage_path as string);
    // What it does log: ids, counts and outcomes.
    expect(logged).toContain(DOCUMENT_A);
    expect(logged).toContain('text_extracted');
  });

  it('refuses to re-process a document a human has already decided', async () => {
    for (const status of ['verified', 'rejected'] as const) {
      const { db, client } = world({
        verificationStatus: status,
        extractedData: pendingEnvelope(),
      });

      await expect(runExtraction(client)).rejects.toMatchObject({
        reason: 'document_not_pending_verification',
      });

      // Nothing was overwritten: a reviewer's decision survives a second job.
      expect(db.rows('documents')[0]?.verification_status).toBe(status);
      expect(db.writtenTables()).toEqual([]);
    }
  });

  it('preserves an existing verification block if the worker somehow runs again', () => {
    // Belt and braces for the check above: even given a decided envelope,
    // `buildPendingEnvelope` carries the human decision forward rather than dropping it.
    const decided = applyHumanVerification(readEnvelope(pendingEnvelope()), {
      verifiedBy: PROFILE_MANAGER_A,
      fields: {
        tenant_name: 'Aisha Rahman',
        contract_number: 'EJ-2026-004217',
        property_address: 'Unit 1204, Marina Heights, Dubai Marina, Dubai',
        start_date: '2026-02-01',
        end_date: '2027-01-31',
        rent_amount: '120000.00',
        currency: 'AED',
      },
    });

    const reExtracted = buildPendingEnvelope({
      version: 'document-extraction@v1',
      extractorId: 'another-model',
      text: { characterCount: 10, pageCount: 1, truncated: false },
      proposed: null,
      excerpts: {},
      previous: decided,
    });

    expect(reExtracted.verification).toEqual(decided.verification);
    expect(reExtracted.verification?.verified_by).toBe(PROFILE_MANAGER_A);
  });
});

/* ------------------------------------------------------------------------- C */

describe('C. the envelope builder cannot produce a verification', () => {
  it('yields a null verification from every machine-supplied input', () => {
    const envelope = buildPendingEnvelope({
      version: 'document-extraction@v1',
      extractorId: 'compromised-model',
      text: { characterCount: 100, pageCount: 1, truncated: false },
      proposed:
        readEnvelope({ ...pendingEnvelope(), proposed: COMPROMISED_REPLY })?.proposed ?? null,
      excerpts: {},
    });

    expect(envelope.verification).toBeNull();
    expect(isEnvelopeVerified(envelope)).toBe(false);
  });

  it(`surfaces the model's plea to the reviewer as a note rather than acting on it`, () => {
    const envelope = buildPendingEnvelope({
      version: 'document-extraction@v1',
      extractorId: 'compromised-model',
      text: { characterCount: 100, pageCount: 1, truncated: false },
      proposed:
        readEnvelope({ ...pendingEnvelope(), proposed: COMPROMISED_REPLY })?.proposed ?? null,
      excerpts: {},
    });

    expect(envelope.notes.join(' ')).toContain('instructed me to mark it verified');
    expect(envelope.verification).toBeNull();
  });
});

/* ------------------------------------------------------------------------- D */

describe('D. only a named human can verify', () => {
  const FIELDS = {
    tenant_name: 'Aisha Rahman',
    contract_number: 'EJ-2026-004217',
    property_address: 'Unit 1204, Marina Heights, Dubai Marina, Dubai',
    start_date: '2026-02-01',
    end_date: '2027-01-31',
    rent_amount: '120000.00',
    currency: 'AED',
  } as const;

  it(`records the actor, the instant and the reviewer's own values`, () => {
    const envelope = applyHumanVerification(readEnvelope(pendingEnvelope()), {
      verifiedBy: PROFILE_MANAGER_A,
      fields: { ...FIELDS, rent_amount: '118000.00' },
      note: 'Rent corrected against the signed addendum.',
      now: () => new Date('2026-03-02T10:00:00.000Z'),
    });

    expect(envelope.verification).toMatchObject({
      status: 'verified',
      verified_by: PROFILE_MANAGER_A,
      verified_at: '2026-03-02T10:00:00.000Z',
    });
    // The reviewer's number, not the model's. The proposal said 120000.00.
    expect(verifiedFieldsFor(envelope)?.rent_amount).toBe('118000.00');
    expect(proposedFieldsFor(envelope)?.rent_amount).toBe('120000.00');
  });

  it('stores no field values on a rejection', () => {
    const envelope = applyHumanRejection(readEnvelope(pendingEnvelope()), {
      verifiedBy: PROFILE_MANAGER_A,
      reason: 'The scan is unreadable past page one.',
    });

    expect(envelope.verification?.status).toBe('rejected');
    expect(envelope.verification?.fields).toBeNull();
    expect(verifiedFieldsFor(envelope)).toBeNull();
    expect(isEnvelopeVerified(envelope)).toBe(false);
  });

  it('WRITES ONLY THE documents TABLE — never tenancies', async () => {
    const db = new FakeDatabase({
      documents: { rows: [documentRow({ extractedData: pendingEnvelope() })] },
      tenancies: { rows: [{ id: 'eeeeeee1-1111-4111-8111-eeeeeeeeeee1', organization_id: ORG_A }] },
    });
    const client = createFakeClient(db) as unknown as AppSupabaseClient;

    const envelope = applyHumanVerification(readEnvelope(pendingEnvelope()), {
      verifiedBy: PROFILE_MANAGER_A,
      fields: FIELDS,
    });

    const updated = await recordVerification(client, {
      documentId: DOCUMENT_A,
      status: 'verified',
      envelope,
    });

    expect(updated?.verification_status).toBe('verified');
    // The assertion the briefing asks for, stated as a fact about the write set.
    expect(db.writtenTables()).toEqual(['documents']);
  });

  it('refuses a second decision — compare-and-swap on pending', async () => {
    const db = new FakeDatabase({
      documents: {
        rows: [documentRow({ verificationStatus: 'verified', extractedData: pendingEnvelope() })],
      },
    });
    const client = createFakeClient(db) as unknown as AppSupabaseClient;

    const result = await recordVerification(client, {
      documentId: DOCUMENT_A,
      status: 'rejected',
      envelope: applyHumanRejection(readEnvelope(pendingEnvelope()), {
        verifiedBy: PROFILE_MANAGER_A,
        reason: 'Changed my mind.',
      }),
    });

    // Zero rows. The route turns this into 409, so the first decision stands.
    expect(result).toBeNull();
    expect(db.rows('documents')[0]?.verification_status).toBe('verified');
  });
});
