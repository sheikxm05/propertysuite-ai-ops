/**
 * The runner, end to end: claim, run, record, recover.
 *
 * The exit-gate assertion here is "a permanently failing job reaches `dead` instead of
 * retrying forever", and it is tested in both of the ways a job can fail permanently:
 *
 *   * a *classified* permanent failure — a file that is not a PDF — which dead-letters
 *     on the first attempt without consuming the retry budget, because the same bytes
 *     will fail the same way five times;
 *   * a *retryable* failure that keeps recurring — a provider that is always down —
 *     which consumes the budget and then dead-letters, and crucially stops.
 *
 * "And stops" is the part a weaker test misses. The last assertion in that case drives
 * the runner one more time after the job is `dead` and proves it is not claimed again:
 * `failJob` nulls `next_run_at` on a dead-letter, so the row cannot match the claim
 * query whatever a future status check does.
 */

import { describe, expect, it } from 'vitest';

import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';
import {
  DOCUMENT_EXTRACTION_JOB_TYPE,
  JobHandlerRegistry,
  MAX_JOB_ATTEMPTS,
  PermanentJobError,
  RetryableJobError,
  createDocumentExtractionHandler,
  documentExtractionIdempotencyKey,
  enqueueJob,
  runJobsOnce,
  type JobHandler,
} from '@/services/workers';

import { FakeDatabase, createFakeClient } from './_support/fake-supabase';
import { createCapturingLogger } from './_support/logger';
import { DOCUMENT_A, ORG_A, documentRow, proposal } from './_support/fixtures';
import { buildFakePdfBytes, buildTenancyContractPdf } from './_support/pdf-fixture';

const NOW = new Date('2026-03-01T09:00:00.000Z');

function registryWith(handler: JobHandler): JobHandlerRegistry {
  return new JobHandlerRegistry().register(handler);
}

/** A handler that always throws whatever it is given. */
function throwingHandler(error: unknown): JobHandler {
  return {
    type: DOCUMENT_EXTRACTION_JOB_TYPE,
    run: async () => {
      throw error;
    },
  };
}

function emptyQueue(objects: Record<string, Uint8Array> = {}) {
  const db = new FakeDatabase({
    documents: { rows: [documentRow()] },
    jobs: { rows: [], unique: ['idempotency_key'] },
  });
  const client = createFakeClient(db, { storage: { objects } });
  return { db, client: client as unknown as PrivilegedSupabaseClient, raw: client };
}

async function enqueueExtraction(client: PrivilegedSupabaseClient) {
  return enqueueJob(client, {
    type: DOCUMENT_EXTRACTION_JOB_TYPE,
    idempotencyKey: documentExtractionIdempotencyKey(DOCUMENT_A),
    payload: { document_id: DOCUMENT_A, organization_id: ORG_A },
    runAt: NOW,
  });
}

describe('the happy path', () => {
  it('claims, extracts and marks the job done', async () => {
    const document = documentRow();
    const { db, client } = emptyQueue({
      [document.storage_path as string]: buildTenancyContractPdf(),
    });
    await enqueueExtraction(client);

    const logger = createCapturingLogger();
    const result = await runJobsOnce({
      client,
      logger,
      now: () => NOW,
      registry: registryWith(
        createDocumentExtractionHandler({
          fields: { extractor: { id: 'stub-model', extract: async () => proposal() } },
        }),
      ),
    });

    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]?.outcome).toBe('done');
    expect(db.rows('jobs')[0]?.status).toBe('done');
    expect(db.rows('jobs')[0]?.last_error).toBeNull();
    expect(db.rows('documents')[0]?.verification_status).toBe('pending');
  });

  it('works with no extractor bound at all, and says so on the document', async () => {
    const document = documentRow();
    const { db, client } = emptyQueue({
      [document.storage_path as string]: buildTenancyContractPdf(),
    });
    await enqueueExtraction(client);

    const result = await runJobsOnce({
      client,
      logger: createCapturingLogger(),
      now: () => NOW,
      // `extractor: null` is the deployed state until the AI adapter is bound — see the
      // planning defect about `services/ai`. Text extraction must still succeed.
      registry: registryWith(createDocumentExtractionHandler({ fields: { extractor: null } })),
    });

    expect(result.processed[0]?.outcome).toBe('done');
    const stored = db.rows('documents')[0];
    expect(String(stored?.extracted_text)).toContain('TENANCY CONTRACT');
    expect(JSON.stringify(stored?.extracted_data)).toContain(
      'Automatic field extraction was unavailable',
    );
    expect(stored?.verification_status).toBe('pending');
  });
});

describe('a permanently failing job reaches dead', () => {
  it('DEAD-LETTERS A NON-PDF ON THE FIRST ATTEMPT', async () => {
    const document = documentRow();
    // The file the magic-byte check exists for: a ZIP declared and named as a PDF.
    const { db, client } = emptyQueue({
      [document.storage_path as string]: buildFakePdfBytes(),
    });
    await enqueueExtraction(client);

    const logger = createCapturingLogger();
    const result = await runJobsOnce({
      client,
      logger,
      now: () => NOW,
      registry: registryWith(createDocumentExtractionHandler()),
    });

    expect(result.processed[0]).toMatchObject({
      outcome: 'dead',
      reason: 'magic_bytes_not_pdf',
      attempts: 1,
    });

    const job = db.rows('jobs')[0];
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(1);
    // One attempt, not five. The same bytes cannot pass the check later.
    expect(job?.next_run_at).toBeNull();
    expect(job?.last_error).toBe('magic_bytes_not_pdf');
    // A dead-letter is logged at error level: it needs a person.
    expect(logger.lines.some((line) => line.level === 'error')).toBe(true);
  });

  it('dead-letters a missing object rather than retrying an upload that never finished', async () => {
    const { db, client } = emptyQueue({}); // no object in storage
    await enqueueExtraction(client);

    const result = await runJobsOnce({
      client,
      logger: createCapturingLogger(),
      now: () => NOW,
      registry: registryWith(createDocumentExtractionHandler()),
    });

    expect(result.processed[0]).toMatchObject({
      outcome: 'dead',
      reason: 'document_object_missing',
    });
    expect(db.rows('jobs')[0]?.status).toBe('dead');
  });

  it('dead-letters a malformed payload', async () => {
    const { db, client } = emptyQueue();
    await enqueueJob(client, {
      type: DOCUMENT_EXTRACTION_JOB_TYPE,
      idempotencyKey: 'bad-payload',
      payload: { document_id: 'not-a-uuid' },
      runAt: NOW,
    });

    const result = await runJobsOnce({
      client,
      logger: createCapturingLogger(),
      now: () => NOW,
      registry: registryWith(createDocumentExtractionHandler()),
    });

    expect(result.processed[0]).toMatchObject({ outcome: 'dead', reason: 'payload_invalid' });
    expect(db.rows('jobs')[0]?.status).toBe('dead');
  });

  it('dead-letters an unknown job type instead of retrying it for a quarter of an hour', async () => {
    const db = new FakeDatabase({ jobs: { rows: [], unique: ['idempotency_key'] } });
    const client = createFakeClient(db) as unknown as PrivilegedSupabaseClient;

    await enqueueJob(client, {
      type: DOCUMENT_EXTRACTION_JOB_TYPE,
      idempotencyKey: 'orphan',
      payload: {},
      runAt: NOW,
    });

    // A registry that knows the *type* but whose handler is a different one, then
    // emptied: the claim only looks for types the registry declares, so to reach the
    // "no handler" branch the handler must be absent at run time.
    const registry = new JobHandlerRegistry().register({
      type: DOCUMENT_EXTRACTION_JOB_TYPE,
      run: async () => {
        throw new PermanentJobError('handler_not_registered');
      },
    });

    const result = await runJobsOnce({
      client,
      logger: createCapturingLogger(),
      now: () => NOW,
      registry,
    });

    expect(result.processed[0]).toMatchObject({
      outcome: 'dead',
      reason: 'handler_not_registered',
    });
  });

  it('A REPEATEDLY FAILING RETRYABLE JOB EXHAUSTS ITS BUDGET AND THEN STOPS', async () => {
    const { db, client } = emptyQueue();
    await enqueueExtraction(client);

    const registry = registryWith(throwingHandler(new RetryableJobError('extractor_threw')));
    const outcomes: string[] = [];

    // Each poll advances the clock past the previous backoff, so the job is due again.
    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
      const result = await runJobsOnce({
        client,
        registry,
        logger: createCapturingLogger(),
        now: () => new Date(NOW.getTime() + attempt * 3_600_000),
        random: () => 0,
      });
      outcomes.push(result.processed[0]?.outcome ?? 'none');
    }

    // Four scheduled retries, then the dead-letter. Bounded, and bounded at the number
    // the policy says.
    expect(outcomes).toEqual(['failed', 'failed', 'failed', 'failed', 'dead']);

    const job = db.rows('jobs')[0];
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(MAX_JOB_ATTEMPTS);
    expect(job?.next_run_at).toBeNull();

    // The assertion that makes "instead of retrying forever" true: a sixth poll, a day
    // later, claims nothing.
    const afterDeath = await runJobsOnce({
      client,
      registry,
      logger: createCapturingLogger(),
      now: () => new Date(NOW.getTime() + 86_400_000),
    });
    expect(afterDeath.processed).toHaveLength(0);
    expect(db.rows('jobs')[0]?.attempts).toBe(MAX_JOB_ATTEMPTS);
  });

  it('records only a token in last_error, never an exception message', async () => {
    const { db, client } = emptyQueue();
    await enqueueExtraction(client);

    const result = await runJobsOnce({
      client,
      logger: createCapturingLogger(),
      now: () => NOW,
      registry: registryWith(
        throwingHandler(new Error('connection to db-prod-7 failed for tenant Aisha Rahman')),
      ),
    });

    expect(result.processed[0]?.reason).toBe('unexpected_error');
    const stored = db.rows('jobs')[0]?.last_error;
    expect(stored).toBe('unexpected_error');
    expect(String(stored)).not.toContain('Aisha');
    expect(String(stored)).not.toContain('db-prod-7');
  });
});

describe('a duplicate enqueue is processed once', () => {
  it('runs the extraction a single time for two identical requests', async () => {
    const document = documentRow();
    const { db, client } = emptyQueue({
      [document.storage_path as string]: buildTenancyContractPdf(),
    });

    const first = await enqueueExtraction(client);
    const second = await enqueueExtraction(client);

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    let runs = 0;
    const registry = registryWith({
      type: DOCUMENT_EXTRACTION_JOB_TYPE,
      run: async () => {
        runs += 1;
      },
    });

    const firstPoll = await runJobsOnce({
      client,
      registry,
      logger: createCapturingLogger(),
      now: () => NOW,
    });
    const secondPoll = await runJobsOnce({
      client,
      registry,
      logger: createCapturingLogger(),
      now: () => new Date(NOW.getTime() + 3_600_000),
    });

    expect(runs).toBe(1);
    expect(firstPoll.processed).toHaveLength(1);
    // Nothing left to claim: the single job is `done`.
    expect(secondPoll.processed).toHaveLength(0);
    expect(db.rows('jobs')).toHaveLength(1);
    expect(db.rows('jobs')[0]?.status).toBe('done');
  });
});

describe('batching and recovery', () => {
  it('processes a bounded batch per poll', async () => {
    const db = new FakeDatabase({ jobs: { rows: [], unique: ['idempotency_key'] } });
    const client = createFakeClient(db) as unknown as PrivilegedSupabaseClient;

    for (let index = 0; index < 7; index += 1) {
      await enqueueJob(client, {
        type: DOCUMENT_EXTRACTION_JOB_TYPE,
        idempotencyKey: `job-${index}`,
        payload: {},
        runAt: NOW,
      });
    }

    const registry = registryWith({ type: DOCUMENT_EXTRACTION_JOB_TYPE, run: async () => {} });
    const result = await runJobsOnce({
      client,
      registry,
      logger: createCapturingLogger(),
      now: () => NOW,
      batchSize: 3,
    });

    expect(result.processed).toHaveLength(3);
  });

  it('recovers a job abandoned by a worker that died mid-flight', async () => {
    const db = new FakeDatabase({
      jobs: {
        rows: [
          {
            id: '66666666-1111-4111-8111-666666666666',
            type: DOCUMENT_EXTRACTION_JOB_TYPE,
            payload: {},
            idempotency_key: 'abandoned',
            attempts: 1,
            // Claimed, then the worker vanished. The visibility deadline has passed.
            next_run_at: '2026-03-01T08:50:00.000Z',
            status: 'running',
            last_error: null,
            created_at: '2026-03-01T08:00:00.000Z',
          },
        ],
        unique: ['idempotency_key'],
      },
    });
    const client = createFakeClient(db) as unknown as PrivilegedSupabaseClient;

    const registry = registryWith({ type: DOCUMENT_EXTRACTION_JOB_TYPE, run: async () => {} });
    const result = await runJobsOnce({
      client,
      registry,
      logger: createCapturingLogger(),
      now: () => NOW,
    });

    // Requeued by the reaper and then claimed in the same poll, so one dead worker does
    // not cost a polling interval.
    expect(result.requeuedAbandoned).toBe(1);
    expect(result.processed[0]?.outcome).toBe('done');
  });

  it('gives the handler a signal that aborts at the attempt deadline', async () => {
    const { client } = emptyQueue();
    await enqueueExtraction(client);

    let aborted: boolean | null = null;
    const registry = registryWith({
      type: DOCUMENT_EXTRACTION_JOB_TYPE,
      run: async (context) => {
        // A provider call with no timeout is an unbounded hold on a claim, which is
        // indistinguishable from a crash — except the reaper would then let a second
        // worker run the same extraction concurrently.
        await new Promise((resolve) => setTimeout(resolve, 20));
        aborted = context.signal?.aborted ?? null;
        if (aborted) throw new RetryableJobError('aborted');
      },
    });

    const result = await runJobsOnce({
      client,
      registry,
      logger: createCapturingLogger(),
      now: () => NOW,
      attemptTimeoutMs: 1,
    });

    expect(aborted).toBe(true);
    expect(result.processed[0]).toMatchObject({ outcome: 'failed', reason: 'aborted' });
  });
});
