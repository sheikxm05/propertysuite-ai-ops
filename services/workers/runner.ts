/**
 * The job runner.
 *
 * Claim one job, run it, record the outcome, repeat. The runner — not the handler —
 * owns every status transition, so a handler that throws halfway through a multi
 * -statement write cannot leave the job marked `done`.
 *
 * The loop's contract with the queue:
 *
 *   claim      CAS `queued|failed → running`, `attempts + 1`, `next_run_at` pushed to
 *              the visibility deadline (`job-queue.ts`)
 *   success    `running → done`
 *   failure    `running → failed` with a backoff `next_run_at`, or `running → dead`
 *              when the failure is permanent or the attempt budget is spent
 *   abandoned  a `running` row past its deadline is reaped by the next poll — requeued,
 *              or dead-lettered if its budget is already spent
 *
 * That last line is why a worker that is killed mid-job does not produce a job stuck in
 * `running` forever, which is the usual way a "bounded retries" design turns out to be
 * unbounded in one direction.
 *
 * Every attempt gets a deadline. A model call with no timeout is an unbounded hold on a
 * claim, and an unbounded hold is indistinguishable from a crash — except that the
 * reaper will eventually treat it as one and let a second worker run the same job
 * concurrently. The `AbortSignal` makes the handler give up first.
 */

import { systemLogger, type Logger } from '@/lib/observability/logger';
import type { JobRow, JobType } from '@shared/index';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

import { JOB_VISIBILITY_TIMEOUT_MS } from './backoff';
import {
  claimNextJob,
  completeJob,
  failJob,
  reapAbandonedJobs,
  type FailJobResult,
} from './job-queue';
import { PermanentJobError, sanitiseJobError } from './job-errors';
import type { JobHandler, JobHandlerContext } from './runner-types';

/** Jobs processed per `runJobsOnce` call, unless the queue empties first. */
export const DEFAULT_BATCH_SIZE = 5;

/** Pause between polls when the queue is empty. */
export const DEFAULT_IDLE_DELAY_MS = 2_000;

/**
 * Attempt deadline. A little under the visibility timeout so the handler aborts
 * *before* another worker becomes entitled to reclaim the job — the opposite order
 * would allow two workers to run the same extraction at once.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = Math.max(5_000, JOB_VISIBILITY_TIMEOUT_MS - 30_000);

/* -------------------------------------------------------------- registry -- */

/**
 * A handler registry, created per runner rather than held in module state.
 *
 * Module-level registries make tests order-dependent: one file registers a stub, the
 * next file inherits it. An explicit registry means a test constructs exactly the
 * runner it intends to exercise.
 */
export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(handler: JobHandler): this {
    this.handlers.set(handler.type, handler);
    return this;
  }

  get(type: string): JobHandler | null {
    return this.handlers.get(type) ?? null;
  }

  types(): JobType[] {
    return [...this.handlers.keys()] as JobType[];
  }
}

/* ---------------------------------------------------------------- results -- */

export type JobOutcome = 'done' | 'failed' | 'dead' | 'lost';

export interface ProcessedJob {
  readonly jobId: string;
  readonly type: string;
  readonly attempts: number;
  readonly outcome: JobOutcome;
  /** Failure token from the closed list in `job-errors.ts`. `null` on success. */
  readonly reason: string | null;
}

export interface RunOnceResult {
  readonly processed: readonly ProcessedJob[];
  readonly requeuedAbandoned: number;
  readonly deadLetteredAbandoned: number;
}

export interface RunnerOptions {
  readonly client: PrivilegedSupabaseClient;
  readonly registry: JobHandlerRegistry;
  readonly logger?: Logger;
  readonly batchSize?: number;
  readonly attemptTimeoutMs?: number;
  readonly now?: () => Date;
  /** Jitter source. Pinned in tests so a backoff assertion is deterministic. */
  readonly random?: () => number;
  /** Skip the reaper. Only used by tests that assert on the claim path alone. */
  readonly skipReap?: boolean;
}

/* ------------------------------------------------------------------- loop -- */

/**
 * Processes up to `batchSize` due jobs and returns what happened to each.
 *
 * The reaper runs first. Recovering an abandoned job before claiming a new one means a
 * queue whose only due work is a job left `running` by a dead worker makes progress on
 * this poll rather than the next.
 */
export async function runJobsOnce(options: RunnerOptions): Promise<RunOnceResult> {
  const logger = options.logger ?? systemLogger({ operation: 'job_runner' });
  const types = options.registry.types();
  const now = options.now ?? (() => new Date());
  const processed: ProcessedJob[] = [];

  let requeuedAbandoned = 0;
  let deadLetteredAbandoned = 0;

  if (options.skipReap !== true && types.length > 0) {
    const reaped = await reapAbandonedJobs(options.client, { types, now: now() });
    requeuedAbandoned = reaped.requeued;
    deadLetteredAbandoned = reaped.deadLettered;
    if (reaped.requeued + reaped.deadLettered > 0) {
      logger.warn('abandoned jobs recovered', {
        count: reaped.requeued + reaped.deadLettered,
        reason: 'visibility_timeout_expired',
      });
    }
  }

  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  for (let index = 0; index < batchSize; index += 1) {
    if (types.length === 0) break;
    const job = await claimNextJob(options.client, { types, now: now() });
    if (!job) break;
    processed.push(await processClaimedJob(job, options, logger));
  }

  return { processed, requeuedAbandoned, deadLetteredAbandoned };
}

/**
 * Runs one already-claimed job and records its outcome.
 *
 * Exported because it is the unit worth testing in isolation: the claim is the queue's
 * concern, and this is the runner's.
 */
export async function processClaimedJob(
  job: JobRow,
  options: RunnerOptions,
  parentLogger?: Logger,
): Promise<ProcessedJob> {
  const logger = (
    parentLogger ??
    options.logger ??
    systemLogger({ operation: 'job_runner' })
  ).child({ job_id: job.id, attempt: job.attempts });

  const handler = options.registry.get(job.type);
  const timeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;

  try {
    // An unknown type is permanent on purpose. Retrying it for a quarter of an hour
    // cannot make the handler exist, and `dead` is where an operator will see it.
    if (!handler) throw new PermanentJobError('handler_not_registered');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const context: JobHandlerContext = {
      job,
      client: options.client,
      logger,
      signal: controller.signal,
    };

    try {
      await handler.run(context);
    } finally {
      clearTimeout(timer);
    }

    const completed = await completeJob(options.client, job.id);
    if (!completed) {
      // The row was no longer `running`: a reaper took it while this attempt was in
      // flight. The work may well have succeeded, but this worker no longer owns the
      // row and must not overwrite whoever does.
      logger.warn('job completed but claim was lost', { outcome: 'lost', reason: 'claim_expired' });
      return {
        jobId: job.id,
        type: job.type,
        attempts: job.attempts,
        outcome: 'lost',
        reason: null,
      };
    }

    logger.info('job done', { outcome: 'done', status: 'done' });
    return { jobId: job.id, type: job.type, attempts: job.attempts, outcome: 'done', reason: null };
  } catch (thrown) {
    const failure = sanitiseJobError(thrown);
    const result: FailJobResult = await failJob(options.client, job.id, {
      reason: failure.reason,
      permanent: failure.permanent,
      attempts: job.attempts,
      now: (options.now ?? (() => new Date()))(),
      ...(options.random ? { random: options.random } : {}),
    });

    // `error` for a dead-letter — it needs an operator — and `warn` for a scheduled
    // retry, which is the queue working as designed.
    const level = result.status === 'dead' ? 'error' : 'warn';
    logger[level](result.status === 'dead' ? 'job dead-lettered' : 'job failed, will retry', {
      outcome: result.status,
      status: result.status,
      reason: failure.reason,
    });

    return {
      jobId: job.id,
      type: job.type,
      attempts: job.attempts,
      outcome: result.status,
      reason: failure.reason,
    };
  }
}

/* --------------------------------------------------------------- forever -- */

export interface RunForeverOptions extends RunnerOptions {
  readonly idleDelayMs?: number;
  /** Stops the loop. Required: a loop with no stop signal cannot be shut down cleanly. */
  readonly signal: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Polls until aborted.
 *
 * A failure of the *queue itself* — the database is unreachable, the service-role key
 * is wrong — is logged and the loop backs off rather than exiting. A worker that exits
 * on the first transport error turns a thirty-second outage into an outage that lasts
 * until somebody notices the process is gone.
 */
export async function runJobsForever(options: RunForeverOptions): Promise<void> {
  const logger = options.logger ?? systemLogger({ operation: 'job_runner' });
  const idle = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  logger.info('job runner started', { count: options.registry.types().length });

  while (!options.signal.aborted) {
    try {
      const result = await runJobsOnce(options);
      if (result.processed.length === 0) await sleep(idle, options.signal);
    } catch (thrown) {
      logger.error('job runner poll failed', {
        reason: thrown instanceof Error ? thrown.name : 'unknown',
        outcome: 'error',
      });
      await sleep(idle, options.signal);
    }
  }

  logger.info('job runner stopped', { outcome: 'stopped' });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
