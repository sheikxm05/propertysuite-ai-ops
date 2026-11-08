/**
 * Standalone entry point for the job runner.
 *
 *     npx tsx services/workers/cli.ts            # poll until interrupted
 *     npx tsx services/workers/cli.ts --once     # process one batch and exit
 *
 * Why a file here rather than an `npm` script: `package.json` belongs to lane w0-l1 and
 * §5.1 freezes its contents, so this lane adds no script entry. `tsx` is already a
 * dev dependency, so the commands above work with nothing installed and nothing
 * changed. A Wave 2 lane that owns deployment can wire a cron trigger, a container
 * command or a Supabase scheduled function to this same module.
 *
 * It requires `SUPABASE_SERVICE_ROLE_KEY`, because the queue is service-role only. When
 * the key is absent the process exits non-zero with a named reason rather than starting
 * a loop that cannot claim anything — a worker that polls successfully and finds
 * nothing looks identical to a worker that is not authorised, and the second is a
 * misconfiguration somebody needs to hear about.
 */

import { systemLogger } from '@/lib/observability/logger';
import { tryCreateServiceRoleClient } from '@/lib/supabase/server-only/service-role';

import { createDefaultRegistry } from './index';
import { runJobsForever, runJobsOnce } from './runner';

async function main(): Promise<number> {
  const logger = systemLogger({ operation: 'job_runner_cli' });
  const client = tryCreateServiceRoleClient();

  if (!client) {
    logger.error('job runner cannot start', {
      reason: 'service_role_credential_missing',
      outcome: 'error',
    });
    return 1;
  }

  const registry = createDefaultRegistry();
  const once = process.argv.includes('--once');

  if (once) {
    const result = await runJobsOnce({ client, registry, logger });
    logger.info('batch complete', {
      count: result.processed.length,
      outcome: 'batch_complete',
    });
    // A dead-lettered job is not a failure of this run — it is this run working — so the
    // exit code stays 0. The log line and the `dead` row are the signal.
    return 0;
  }

  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('shutdown requested', { reason: signal, outcome: 'stopping' });
      controller.abort();
    });
  }

  await runJobsForever({ client, registry, logger, signal: controller.signal });
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((thrown: unknown) => {
    // The message is not printed: it can carry a connection string or a row value.
    systemLogger({ operation: 'job_runner_cli' }).error('job runner crashed', {
      reason: thrown instanceof Error ? thrown.name : 'unknown',
      outcome: 'error',
    });
    process.exitCode = 1;
  });
