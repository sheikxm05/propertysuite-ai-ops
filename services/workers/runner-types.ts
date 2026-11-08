/**
 * The handler contract, in its own module.
 *
 * Split out from `runner.ts` purely to break an import cycle: the runner needs the
 * handler type to hold a registry, and a handler needs the context type to be written.
 * Putting both in `runner.ts` would make `document-extraction-job.ts` import the runner
 * and the runner import the job, which TypeScript tolerates and `vitest` does not
 * always resolve in a predictable order.
 */

import type { JobRow, JobType } from '@shared/index';
import type { Logger } from '@/lib/observability/logger';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

/** What a handler receives. Deliberately small. */
export interface JobHandlerContext {
  /** The claimed row, including `attempts` as incremented by the claim. */
  readonly job: JobRow;
  /** Service-role client. **Bypasses RLS** — the handler owns its own tenant checks. */
  readonly client: PrivilegedSupabaseClient;
  /** Correlated to the job id. Redacts by allowlist; never give it document text. */
  readonly logger: Logger;
  /** Aborted at the visibility deadline, so a hung provider cannot hold a claim open. */
  readonly signal?: AbortSignal;
}

/**
 * One job type's behaviour.
 *
 * `run` resolves on success and throws on failure. It never reports its own outcome to
 * the queue — the runner owns the status transition, so a handler cannot accidentally
 * mark itself `done` after a partial write.
 */
export interface JobHandler {
  readonly type: JobType;
  run(context: JobHandlerContext): Promise<void>;
}
