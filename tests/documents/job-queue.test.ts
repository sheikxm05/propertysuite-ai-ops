/**
 * The job queue: exactly-once enqueue, exclusive claim, bounded retries, dead-letter.
 *
 * Three of the lane's exit-gate assertions live here:
 *
 *   * a duplicate enqueue processes once
 *   * a permanently failing job reaches `dead` instead of retrying forever
 *   * a claim is exclusive, so two workers cannot run the same extraction
 *
 * The fake client in `_support/fake-supabase.ts` models Postgres row semantics —
 * `unique` violations as `23505`, and `UPDATE … WHERE … RETURNING *` returning zero rows
 * when the predicate no longer matches. It does **not** model RLS, and nothing here
 * claims it does: `public.jobs` has RLS enabled with zero policies and no grants to
 * `anon` or `authenticated`, which is proven against the live database by `tests/rls`,
 * not by a fake.
 */

import { describe, expect, it } from 'vitest';

import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';
import {
  BASE_BACKOFF_MS,
  JOB_VISIBILITY_TIMEOUT_MS,
  MAX_BACKOFF_MS,
  MAX_JOB_ATTEMPTS,
  backoffDelayMs,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  findJobByIdempotencyKey,
  isAttemptsExhausted,
  reapAbandonedJobs,
  retryScheduleMs,
} from '@/services/workers';

import { FakeDatabase, createFakeClient } from './_support/fake-supabase';
import { DOCUMENT_A, ORG_A, jobRow } from './_support/fixtures';

const KEY = `document_extraction:${DOCUMENT_A}`;
const NOW = new Date('2026-03-01T09:00:00.000Z');

function queue(rows: Record<string, unknown>[] = []) {
  const db = new FakeDatabase({ jobs: { rows, unique: ['idempotency_key'] } });
  const client = createFakeClient(db) as unknown as PrivilegedSupabaseClient;
  return { db, client };
}

describe('enqueue is exactly once', () => {
  it('creates a queued job on the first call', async () => {
    const { db, client } = queue();

    const result = await enqueueJob(client, {
      type: 'document_extraction',
      idempotencyKey: KEY,
      payload: { document_id: DOCUMENT_A, organization_id: ORG_A },
      runAt: NOW,
    });

    expect(result.created).toBe(true);
    expect(result.job.status).toBe('queued');
    expect(result.job.attempts).toBe(0);
    expect(result.job.idempotency_key).toBe(KEY);
    expect(db.rows('jobs')).toHaveLength(1);
  });

  it('A DUPLICATE ENQUEUE RETURNS THE EXISTING JOB AND CREATES NOTHING', async () => {
    const { db, client } = queue();

    const first = await enqueueJob(client, {
      type: 'document_extraction',
      idempotencyKey: KEY,
      payload: { document_id: DOCUMENT_A, organization_id: ORG_A },
      runAt: NOW,
    });

    const second = await enqueueJob(client, {
      type: 'document_extraction',
      idempotencyKey: KEY,
      payload: { document_id: DOCUMENT_A, organization_id: ORG_A },
      runAt: NOW,
    });

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    // One row. The second caller receives the first caller's job id, which is why the
    // route can return 202 rather than a conflict.
    expect(db.rows('jobs')).toHaveLength(1);
  });

  it('survives ten concurrent enqueues with the same key', async () => {
    const { db, client } = queue();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        enqueueJob(client, {
          type: 'document_extraction',
          idempotencyKey: KEY,
          payload: { document_id: DOCUMENT_A, organization_id: ORG_A },
          runAt: NOW,
        }),
      ),
    );

    expect(db.rows('jobs')).toHaveLength(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.job.id));
    expect(ids.size).toBe(1);
  });

  it('allows a deliberate re-extraction under a distinct key', async () => {
    const { db, client } = queue();

    await enqueueJob(client, {
      type: 'document_extraction',
      idempotencyKey: KEY,
      payload: {},
      runAt: NOW,
    });
    const second = await enqueueJob(client, {
      type: 'document_extraction',
      idempotencyKey: `${KEY}:rerun-after-rescan`,
      payload: {},
      runAt: NOW,
    });

    expect(second.created).toBe(true);
    expect(db.rows('jobs')).toHaveLength(2);
  });

  it('finds a job by its key', async () => {
    const { client } = queue([jobRow({ idempotencyKey: KEY })]);
    const found = await findJobByIdempotencyKey(client, KEY);
    expect(found?.idempotency_key).toBe(KEY);
    expect(await findJobByIdempotencyKey(client, 'no-such-key')).toBeNull();
  });
});

describe('the claim is exclusive', () => {
  it('claims a due job, increments attempts and sets a visibility deadline', async () => {
    const { client } = queue([jobRow({ status: 'queued', attempts: 0 })]);

    const claimed = await claimNextJob(client, { types: ['document_extraction'], now: NOW });

    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.next_run_at).toBe(
      new Date(NOW.getTime() + JOB_VISIBILITY_TIMEOUT_MS).toISOString(),
    );
  });

  it('gives the job to exactly one of two concurrent workers', async () => {
    const { client } = queue([jobRow({ status: 'queued', attempts: 0 })]);

    // Sequential here because the fake is synchronous, which is the harder case: the
    // second call sees the row already `running` and must not claim it.
    const first = await claimNextJob(client, { types: ['document_extraction'], now: NOW });
    const second = await claimNextJob(client, { types: ['document_extraction'], now: NOW });

    expect(first).not.toBeNull();
    // Zero rows from the compare-and-swap is the equivalent of `skip locked` passing
    // over a locked row.
    expect(second).toBeNull();
  });

  it('skips a job whose next_run_at is in the future', async () => {
    const { client } = queue([
      jobRow({ status: 'failed', attempts: 1, nextRunAt: '2026-03-01T09:30:00.000Z' }),
    ]);

    expect(await claimNextJob(client, { types: ['document_extraction'], now: NOW })).toBeNull();
  });

  it('claims a failed job once its backoff has elapsed', async () => {
    const { client } = queue([
      jobRow({ status: 'failed', attempts: 2, nextRunAt: '2026-03-01T08:59:00.000Z' }),
    ]);

    const claimed = await claimNextJob(client, { types: ['document_extraction'], now: NOW });
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(3);
  });

  it('never claims a terminal job', async () => {
    for (const status of ['done', 'dead'] as const) {
      const { client } = queue([
        jobRow({ status, attempts: 5, nextRunAt: '2026-03-01T08:00:00.000Z' }),
      ]);
      expect(await claimNextJob(client, { types: ['document_extraction'], now: NOW })).toBeNull();
    }
  });

  it('ignores job types it has no handler for', async () => {
    const { client } = queue([jobRow({ type: 'some_other_job' })]);
    expect(await claimNextJob(client, { types: ['document_extraction'], now: NOW })).toBeNull();
  });

  it('prefers the oldest due job', async () => {
    const { client } = queue([
      jobRow({
        id: '55555555-1111-4111-8111-555555555552',
        idempotencyKey: 'b',
        nextRunAt: '2026-03-01T08:30:00.000Z',
      }),
      jobRow({
        id: '55555555-1111-4111-8111-555555555551',
        idempotencyKey: 'a',
        nextRunAt: '2026-03-01T08:00:00.000Z',
      }),
    ]);

    const claimed = await claimNextJob(client, { types: ['document_extraction'], now: NOW });
    expect(claimed?.id).toBe('55555555-1111-4111-8111-555555555551');
  });
});

describe('outcomes', () => {
  it('completes a running job and clears its error and schedule', async () => {
    const { client } = queue([
      jobRow({ status: 'running', attempts: 1, lastError: 'extractor_threw' }),
    ]);

    const done = await completeJob(client, jobRow().id as string);

    expect(done?.status).toBe('done');
    expect(done?.last_error).toBeNull();
    expect(done?.next_run_at).toBeNull();
  });

  it('refuses to complete a job this worker no longer holds', async () => {
    // The claim expired and a reaper requeued it. A stale result must not overwrite
    // whoever owns the row now.
    const { client } = queue([jobRow({ status: 'failed', attempts: 2 })]);
    expect(await completeJob(client, jobRow().id as string)).toBeNull();
  });

  it('schedules a retry with backoff for a transient failure', async () => {
    const { client } = queue([jobRow({ status: 'running', attempts: 1 })]);

    const result = await failJob(client, jobRow().id as string, {
      reason: 'extractor_threw',
      attempts: 1,
      now: NOW,
      random: () => 0,
    });

    expect(result.status).toBe('failed');
    expect(result.job?.last_error).toBe('extractor_threw');
    expect(result.retryAt?.toISOString()).toBe(
      new Date(NOW.getTime() + BASE_BACKOFF_MS).toISOString(),
    );
  });

  it('DEAD-LETTERS A PERMANENT FAILURE IMMEDIATELY, WITHOUT BURNING RETRIES', async () => {
    const { client } = queue([jobRow({ status: 'running', attempts: 1 })]);

    const result = await failJob(client, jobRow().id as string, {
      reason: 'magic_bytes_not_pdf',
      permanent: true,
      attempts: 1,
      now: NOW,
    });

    expect(result.status).toBe('dead');
    expect(result.retryAt).toBeNull();
    expect(result.job?.last_error).toBe('magic_bytes_not_pdf');
    // Nulling `next_run_at` makes `dead` terminal structurally: the row can never match
    // the claim query again, whatever a future status check does.
    expect(result.job?.next_run_at).toBeNull();
  });

  it('DEAD-LETTERS A RETRYABLE FAILURE ONCE THE BUDGET IS SPENT', async () => {
    const { client } = queue([jobRow({ status: 'running', attempts: MAX_JOB_ATTEMPTS })]);

    const result = await failJob(client, jobRow().id as string, {
      reason: 'extractor_threw',
      attempts: MAX_JOB_ATTEMPTS,
      now: NOW,
    });

    expect(result.status).toBe('dead');
    expect(result.job?.next_run_at).toBeNull();
  });

  it('writes only a token to last_error, never an exception message', async () => {
    const { db, client } = queue([jobRow({ status: 'running', attempts: 1 })]);

    await failJob(client, jobRow().id as string, {
      reason: 'pdf_parse_threw',
      permanent: true,
      attempts: 1,
      now: NOW,
    });

    const stored = db.rows('jobs')[0]?.last_error;
    expect(stored).toBe('pdf_parse_threw');
    // The column is a token from a closed list. Nothing from a document can reach it.
    expect(String(stored)).not.toMatch(/\s/);
  });
});

describe('bounded backoff', () => {
  it('grows exponentially from the base delay', () => {
    expect(backoffDelayMs(1, () => 0)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(2, () => 0)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffDelayMs(3, () => 0)).toBe(BASE_BACKOFF_MS * 4);
  });

  it('is capped, so a long-lived queue cannot schedule a retry a year out', () => {
    expect(backoffDelayMs(50, () => 0)).toBe(MAX_BACKOFF_MS);
  });

  it('only ever reduces a delay with jitter, so the cap stays a real cap', () => {
    const full = backoffDelayMs(3, () => 0);
    const jittered = backoffDelayMs(3, () => 1);
    expect(jittered).toBeLessThan(full);
    expect(jittered).toBeGreaterThan(full * 0.75);
  });

  it('has a finite schedule with a known total', () => {
    const schedule = retryScheduleMs();
    expect(schedule).toHaveLength(MAX_JOB_ATTEMPTS - 1);
    // Four waits between five attempts: 15s, 30s, 60s, 120s — about four minutes of
    // retrying, short enough that a broken job is visible quickly.
    expect(schedule).toEqual([15_000, 30_000, 60_000, 120_000]);
  });

  it('declares the budget spent at the attempt cap', () => {
    expect(isAttemptsExhausted(MAX_JOB_ATTEMPTS - 1)).toBe(false);
    expect(isAttemptsExhausted(MAX_JOB_ATTEMPTS)).toBe(true);
  });
});

describe('abandoned jobs cannot stay running forever', () => {
  it('requeues a running job past its visibility deadline', async () => {
    const { db, client } = queue([
      jobRow({ status: 'running', attempts: 1, nextRunAt: '2026-03-01T08:50:00.000Z' }),
    ]);

    const result = await reapAbandonedJobs(client, { types: ['document_extraction'], now: NOW });

    expect(result).toEqual({ requeued: 1, deadLettered: 0 });
    expect(db.rows('jobs')[0]?.status).toBe('failed');
  });

  it('dead-letters an abandoned job whose budget is already spent', async () => {
    // This is the path that stops "bounded retries" from being unbounded in the other
    // direction: a worker that dies on every attempt still terminates at `dead`.
    const { db, client } = queue([
      jobRow({
        status: 'running',
        attempts: MAX_JOB_ATTEMPTS,
        nextRunAt: '2026-03-01T08:50:00.000Z',
      }),
    ]);

    const result = await reapAbandonedJobs(client, { types: ['document_extraction'], now: NOW });

    expect(result).toEqual({ requeued: 0, deadLettered: 1 });
    expect(db.rows('jobs')[0]?.status).toBe('dead');
    expect(db.rows('jobs')[0]?.next_run_at).toBeNull();
  });

  it('leaves a running job inside its deadline alone', async () => {
    const { db, client } = queue([
      jobRow({ status: 'running', attempts: 1, nextRunAt: '2026-03-01T09:04:00.000Z' }),
    ]);

    expect(await reapAbandonedJobs(client, { types: ['document_extraction'], now: NOW })).toEqual({
      requeued: 0,
      deadLettered: 0,
    });
    expect(db.rows('jobs')[0]?.status).toBe('running');
  });
});
