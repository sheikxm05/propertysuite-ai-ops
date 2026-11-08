/**
 * Bounded retry policy for the job queue.
 *
 * `docs/requirements.md` §7 asks for bounded retries and a dead-letter state, and the
 * `jobs` table provides exactly two columns to implement them: `attempts` and
 * `next_run_at`. Everything below is arithmetic over those two.
 *
 * Why bounded matters more than it sounds. An unbounded retry on a permanently broken
 * job is not merely wasteful — it is a loop that calls a paid model API forever, writes
 * a log line every few seconds, and buries the real failures in the queue behind a job
 * that will never succeed. `dead` is the state that stops it, and it is terminal: no
 * code path in this lane moves a job out of `dead`. Re-driving one is a deliberate
 * operational act, not an automatic recovery.
 *
 * Why jitter. Three workers that fail on the same downstream outage retry at the same
 * instant and fail together, repeatedly, in lockstep. A random fraction of the delay
 * breaks the convoy. It is applied as a *reduction* of up to `JITTER_RATIO`, never an
 * increase, so the stated ceiling remains a real ceiling.
 */

/**
 * Attempts allowed before a job is dead-lettered.
 *
 * Five, which with the schedule below spans roughly 15 minutes of retrying — long
 * enough to ride out a provider restart or a brief network partition, short enough that
 * a broken job is visible in the queue within a quarter of an hour.
 */
export const MAX_JOB_ATTEMPTS = 5;

/** Delay after the first failure. */
export const BASE_BACKOFF_MS = 15_000;

/** Ceiling for a single wait, regardless of attempt count. */
export const MAX_BACKOFF_MS = 600_000;

/** Largest fraction of a delay that jitter may remove. */
export const JITTER_RATIO = 0.2;

/**
 * How long a claimed job may stay `running` before another worker may reclaim it.
 *
 * This is the queue's visibility timeout, and it exists because a worker can die
 * between claiming a job and reporting on it — a serverless timeout, an OOM kill, a
 * deploy. Without it that job stays `running` forever and is never retried and never
 * dead-lettered: the one failure mode a dead-letter design is supposed to rule out.
 *
 * Implemented with `next_run_at`, because the `jobs` table has no `claimed_at` column
 * and adding one would mean editing another lane's migration. On claim, `next_run_at`
 * is set to now plus this timeout; a `running` row whose `next_run_at` has passed is by
 * definition abandoned. The semantics of the column stay consistent — it has always
 * meant "not before this instant" — and no schema change is needed.
 *
 * Must comfortably exceed the slowest honest job: a 10 MB PDF parse plus a model call.
 */
export const JOB_VISIBILITY_TIMEOUT_MS = 300_000;

/**
 * Delay before attempt `attempts + 1`, given that `attempts` have already been made.
 *
 * `attempts` is the post-increment value the claim wrote, so after the first failure it
 * is 1 and the wait is `BASE_BACKOFF_MS`. Exponential, capped, then jittered downwards.
 */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const completed = Math.max(1, Math.floor(attempts));
  const exponential = BASE_BACKOFF_MS * 2 ** (completed - 1);
  const capped = Math.min(exponential, MAX_BACKOFF_MS);
  const jitter = capped * JITTER_RATIO * clamp01(random());
  return Math.max(1_000, Math.round(capped - jitter));
}

/** Has the job exhausted its budget? `true` means dead-letter rather than retry. */
export function isAttemptsExhausted(attempts: number): boolean {
  return attempts >= MAX_JOB_ATTEMPTS;
}

/** The instant the next attempt becomes eligible. */
export function nextRunAt(
  attempts: number,
  now: Date = new Date(),
  random: () => number = Math.random,
): Date {
  return new Date(now.getTime() + backoffDelayMs(attempts, random));
}

/** The instant a claim expires and the job may be reclaimed as abandoned. */
export function visibilityDeadline(now: Date = new Date()): Date {
  return new Date(now.getTime() + JOB_VISIBILITY_TIMEOUT_MS);
}

/**
 * The full schedule, for documentation and for the test that pins it.
 *
 * Computed with jitter disabled, so it describes the ceiling of each wait rather than
 * one sampled run.
 */
export function retryScheduleMs(): number[] {
  const schedule: number[] = [];
  for (let attempts = 1; attempts < MAX_JOB_ATTEMPTS; attempts += 1) {
    schedule.push(backoffDelayMs(attempts, () => 0));
  }
  return schedule;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
