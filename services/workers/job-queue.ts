/**
 * The job queue: enqueue, claim, complete, fail, reap.
 *
 * `public.jobs` has RLS enabled with **zero policies**, and `0003` additionally revokes
 * every grant from `anon` and `authenticated`. There is therefore no client path to this
 * table at all: every function below requires a `PrivilegedSupabaseClient`, which only
 * `lib/api/server-only/privileged-handler.ts` and this worker can obtain. That is the
 * design, not an inconvenience — a queue a tenant can read is a queue a tenant can
 * learn about other tenants from.
 *
 * ---------------------------------------------------------------------------
 * ON `FOR UPDATE SKIP LOCKED` — see the planning defect in this lane's report.
 * ---------------------------------------------------------------------------
 * The briefing asks for the claim to use `for update skip locked`. That is a row-locking
 * clause on a `SELECT`, and it cannot be expressed through PostgREST: supabase-js has no
 * way to emit it, so reaching it requires a `security definer` SQL function. Migration
 * `0003` defines no such function, and `supabase/migrations/**` belongs to lanes w0-l2
 * and w0-l3 — this lane may not add one.
 *
 * `claimNextJob` therefore implements the same guarantee with a compare-and-swap, which
 * is expressible: read candidate rows, then `UPDATE … WHERE id = ? AND status = ? AND
 * attempts = ? RETURNING *`. Postgres takes a row lock for the duration of that UPDATE
 * and re-evaluates the `WHERE` clause against the committed row, so of N concurrent
 * workers aiming at one job exactly one gets a row back and the rest get zero. A worker
 * that gets zero moves to the next candidate — which is precisely what `skip locked`
 * does.
 *
 * What the CAS does *not* give us is the lock-ordering efficiency of `skip locked`:
 * under heavy contention it does a little more work, because losers discover the loss
 * after the attempt rather than skipping before it. At this queue's volume that is
 * irrelevant; the exactly-once property, which is the part that matters, is identical.
 * The exact SQL for the RPC is in the defect report so it can be dropped into `0004`.
 * ---------------------------------------------------------------------------
 *
 * Exactly-once enqueue is separate and is the database's own doing:
 * `jobs.idempotency_key` is `unique`, so a duplicate enqueue is a `23505` unique
 * violation and `enqueueJob` returns the existing row with `created: false`. Two
 * concurrent `POST /process` calls therefore produce one job, and the second caller
 * gets the first caller's job id rather than an error.
 */

import type { Json, JobRow, JobStatus, JobType } from '@shared/index';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

import { isAttemptsExhausted, nextRunAt, visibilityDeadline, MAX_JOB_ATTEMPTS } from './backoff';
import type { JobFailureReason } from './job-errors';

/** Postgres `unique_violation`. Mapped to `CONFLICT` by the §5.2 A2 table. */
const UNIQUE_VIOLATION = '23505';

/** Rows read per claim attempt before giving up on this poll. */
const CLAIM_CANDIDATE_LIMIT = 10;

/** Columns selected everywhere. `payload` is included; it is never logged. */
const JOB_COLUMNS =
  'id, type, payload, idempotency_key, attempts, next_run_at, status, last_error, created_at';

/** Statuses eligible for a claim. `done` and `dead` are terminal. */
const CLAIMABLE: readonly JobStatus[] = ['queued', 'failed'];

/* ------------------------------------------------------------------ types -- */

export interface EnqueueJobInput {
  readonly type: JobType;
  readonly payload: Record<string, Json>;
  /**
   * The exactly-once key. Required rather than optional: a job enqueued without one is
   * a job that can be enqueued twice, and every job this lane creates has a natural key.
   */
  readonly idempotencyKey: string;
  /** Earliest execution time. Defaults to now. */
  readonly runAt?: Date;
}

export interface EnqueueResult {
  readonly job: JobRow;
  /** False when an identical key already existed — the duplicate-enqueue case. */
  readonly created: boolean;
}

export class JobQueueError extends Error {
  readonly reason: string;
  readonly pgCode: string;

  constructor(reason: string, pgCode: string, options?: { cause?: unknown }) {
    super(
      `job queue operation failed: ${reason}`,
      options?.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'JobQueueError';
    this.reason = reason;
    this.pgCode = pgCode;
  }
}

/** The subset of a Supabase error this module reads. Never its `message`. */
interface PgErrorLike {
  code?: string | null;
}

function pgCode(error: unknown): string {
  const code = (error as PgErrorLike | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/* ---------------------------------------------------------------- enqueue -- */

/**
 * Enqueues a job, or returns the one already holding this idempotency key.
 *
 * Insert-then-handle-conflict rather than check-then-insert. A pre-flight `select` would
 * leave a window in which two requests both see nothing and both insert; the unique
 * index closes that window, and the only correct way to use a unique index is to let it
 * fire.
 */
export async function enqueueJob(
  client: PrivilegedSupabaseClient,
  input: EnqueueJobInput,
): Promise<EnqueueResult> {
  const runAt = (input.runAt ?? new Date()).toISOString();

  const { data, error } = await client
    .from('jobs')
    .insert({
      type: input.type,
      payload: input.payload as Json,
      idempotency_key: input.idempotencyKey,
      status: 'queued',
      attempts: 0,
      next_run_at: runAt,
    })
    .select(JOB_COLUMNS)
    .single();

  if (!error && data) return { job: data as JobRow, created: true };

  if (pgCode(error) === UNIQUE_VIOLATION) {
    const existing = await findJobByIdempotencyKey(client, input.idempotencyKey);
    if (existing) return { job: existing, created: false };
    // The conflicting row vanished between the insert and the read, which needs a
    // DELETE that no role holds. Surfacing it as a conflict is the honest answer.
    throw new JobQueueError('idempotency_conflict_row_absent', UNIQUE_VIOLATION);
  }

  throw new JobQueueError('enqueue_failed', pgCode(error), { cause: error });
}

export async function findJobByIdempotencyKey(
  client: PrivilegedSupabaseClient,
  idempotencyKey: string,
): Promise<JobRow | null> {
  const { data, error } = await client
    .from('jobs')
    .select(JOB_COLUMNS)
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (error) throw new JobQueueError('lookup_failed', pgCode(error), { cause: error });
  return (data as JobRow | null) ?? null;
}

export async function findJobById(
  client: PrivilegedSupabaseClient,
  jobId: string,
): Promise<JobRow | null> {
  const { data, error } = await client
    .from('jobs')
    .select(JOB_COLUMNS)
    .eq('id', jobId)
    .maybeSingle();

  if (error) throw new JobQueueError('lookup_failed', pgCode(error), { cause: error });
  return (data as JobRow | null) ?? null;
}

/* ------------------------------------------------------------------ claim -- */

export interface ClaimOptions {
  readonly types: readonly JobType[];
  readonly now?: Date;
  readonly candidateLimit?: number;
}

/**
 * Claims one due job, or returns `null`.
 *
 * The CAS predicate pins `status` **and** `attempts`. Pinning only `status` would admit
 * a lost update: a job could go `queued → running → failed` between the read and the
 * write and still match `status = 'queued'` on a later cycle with a stale attempt count.
 * Pinning both makes the claim a true compare-and-swap on the row's whole retry state.
 *
 * `next_run_at` is pushed forward to the visibility deadline, so the claim is self
 * -expiring — see `JOB_VISIBILITY_TIMEOUT_MS` and `reapAbandonedJobs`.
 */
export async function claimNextJob(
  client: PrivilegedSupabaseClient,
  options: ClaimOptions,
): Promise<JobRow | null> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  const { data, error } = await client
    .from('jobs')
    .select('id, status, attempts')
    .in('type', options.types as string[])
    .in('status', CLAIMABLE as string[])
    .or(`next_run_at.is.null,next_run_at.lte.${nowIso}`)
    .order('next_run_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: true })
    .limit(options.candidateLimit ?? CLAIM_CANDIDATE_LIMIT);

  if (error) throw new JobQueueError('claim_scan_failed', pgCode(error), { cause: error });

  for (const candidate of (data ?? []) as { id: string; status: string; attempts: number }[]) {
    const { data: claimed, error: claimError } = await client
      .from('jobs')
      .update({
        status: 'running',
        attempts: candidate.attempts + 1,
        next_run_at: visibilityDeadline(now).toISOString(),
      })
      .eq('id', candidate.id)
      .eq('status', candidate.status)
      .eq('attempts', candidate.attempts)
      .select(JOB_COLUMNS)
      .maybeSingle();

    if (claimError) {
      throw new JobQueueError('claim_update_failed', pgCode(claimError), { cause: claimError });
    }
    // `null` means another worker won this row. Try the next candidate — the
    // CAS equivalent of `skip locked`.
    if (claimed) return claimed as JobRow;
  }

  return null;
}

/* --------------------------------------------------------------- outcomes -- */

/** Marks a claimed job finished. Terminal; `last_error` is cleared. */
export async function completeJob(
  client: PrivilegedSupabaseClient,
  jobId: string,
): Promise<JobRow | null> {
  return transition(client, jobId, {
    status: 'done',
    last_error: null,
    next_run_at: null,
  });
}

export interface FailJobOptions {
  readonly reason: JobFailureReason;
  /** True to dead-letter immediately, whatever the attempt count. */
  readonly permanent?: boolean;
  readonly attempts: number;
  readonly now?: Date;
  readonly random?: () => number;
}

export interface FailJobResult {
  readonly job: JobRow | null;
  readonly status: Extract<JobStatus, 'failed' | 'dead'>;
  readonly retryAt: Date | null;
}

/**
 * Records a failure, and decides between retry and dead-letter.
 *
 * Dead-letter when the failure is permanent — the same bytes will fail the same way —
 * or when `attempts` has reached `MAX_JOB_ATTEMPTS`. `next_run_at` is nulled on a
 * dead-letter so the row can never match the claim query again, which makes `dead`
 * terminal structurally rather than only by the status check.
 *
 * `last_error` is a token from the closed list in `job-errors.ts`. No part of any
 * exception message reaches this column.
 */
export async function failJob(
  client: PrivilegedSupabaseClient,
  jobId: string,
  options: FailJobOptions,
): Promise<FailJobResult> {
  const dead = options.permanent === true || isAttemptsExhausted(options.attempts);

  if (dead) {
    const job = await transition(client, jobId, {
      status: 'dead',
      last_error: options.reason,
      next_run_at: null,
    });
    return { job, status: 'dead', retryAt: null };
  }

  const retryAt = nextRunAt(options.attempts, options.now ?? new Date(), options.random);
  const job = await transition(client, jobId, {
    status: 'failed',
    last_error: options.reason,
    next_run_at: retryAt.toISOString(),
  });
  return { job, status: 'failed', retryAt };
}

/**
 * Applies a terminal or retry transition to a job this worker holds.
 *
 * The `status = 'running'` predicate is the other half of the claim: a worker whose
 * claim already expired and was reaped by another worker must not be able to overwrite
 * the reaper's decision with a stale result. It gets `null` back and logs that it lost
 * the row.
 */
async function transition(
  client: PrivilegedSupabaseClient,
  jobId: string,
  patch: { status: JobStatus; last_error: string | null; next_run_at: string | null },
): Promise<JobRow | null> {
  const { data, error } = await client
    .from('jobs')
    .update(patch)
    .eq('id', jobId)
    .eq('status', 'running')
    .select(JOB_COLUMNS)
    .maybeSingle();

  if (error) throw new JobQueueError('transition_failed', pgCode(error), { cause: error });
  return (data as JobRow | null) ?? null;
}

/* ------------------------------------------------------------------- reap -- */

export interface ReapResult {
  readonly requeued: number;
  readonly deadLettered: number;
}

/**
 * Recovers jobs whose worker died mid-flight.
 *
 * A `running` row whose `next_run_at` has passed is abandoned: the worker that claimed
 * it promised to report back before the visibility deadline and did not. Such a job is
 * either requeued for another attempt or, if it has already used its budget,
 * dead-lettered — so a process that dies on every attempt still terminates at `dead`
 * instead of leaving a permanently `running` row.
 *
 * Each recovery is its own CAS, so two reapers racing cannot double-count an attempt.
 */
export async function reapAbandonedJobs(
  client: PrivilegedSupabaseClient,
  options: { types: readonly JobType[]; now?: Date; limit?: number } = { types: [] },
): Promise<ReapResult> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  let query = client
    .from('jobs')
    .select('id, attempts')
    .eq('status', 'running')
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(options.limit ?? CLAIM_CANDIDATE_LIMIT);

  if (options.types.length > 0) query = query.in('type', options.types as string[]);

  const { data, error } = await query;
  if (error) throw new JobQueueError('reap_scan_failed', pgCode(error), { cause: error });

  let requeued = 0;
  let deadLettered = 0;

  for (const stale of (data ?? []) as { id: string; attempts: number }[]) {
    const exhausted = isAttemptsExhausted(stale.attempts);
    const patch = exhausted
      ? { status: 'dead' as JobStatus, last_error: 'unexpected_error', next_run_at: null }
      : {
          status: 'failed' as JobStatus,
          last_error: 'unexpected_error',
          next_run_at: nowIso,
        };

    const { data: updated, error: updateError } = await client
      .from('jobs')
      .update(patch)
      .eq('id', stale.id)
      .eq('status', 'running')
      .eq('attempts', stale.attempts)
      .select('id')
      .maybeSingle();

    if (updateError) {
      throw new JobQueueError('reap_update_failed', pgCode(updateError), { cause: updateError });
    }
    if (!updated) continue;
    if (exhausted) deadLettered += 1;
    else requeued += 1;
  }

  return { requeued, deadLettered };
}

export { MAX_JOB_ATTEMPTS };
