/**
 * `services/workers` — the asynchronous job queue, lane w1-l6.
 *
 * `backoff`                  the bounded retry schedule and the visibility timeout
 * `job-errors`               the closed list of failure tokens, and retryable vs not
 * `job-queue`                enqueue (idempotent), claim (compare-and-swap), outcomes
 * `runner-types`             the handler contract
 * `runner`                   the loop that owns every status transition
 * `document-extraction-job`  the only handler in this build
 * `cli`                      a standalone entry point, not re-exported here
 *
 * Reachable only with a service-role client: `public.jobs` has RLS enabled with no
 * policies and no grants to `anon` or `authenticated`. Nothing in this directory may be
 * imported by a client component.
 *
 * `cli.ts` is deliberately absent from the barrel. It imports the service-role client
 * at module scope, and a barrel that pulled that in would make every importer of
 * `services/workers` — including the route handlers, which only need the enqueue
 * helpers — depend on a configured service-role credential.
 */

export * from './backoff';
export * from './job-errors';
export * from './job-queue';
export * from './runner-types';
export * from './runner';
export * from './document-extraction-job';

/**
 * The production registry: every handler this build knows about.
 *
 * A function rather than a constant so each caller gets its own registry and two
 * runners in one process cannot mutate each other's.
 */
import { createWhatsAppInboundHandler } from '@/services/integrations/server-only/inbound-job';

import { createDocumentExtractionHandler } from './document-extraction-job';
import { JobHandlerRegistry } from './runner';

export function createDefaultRegistry(): JobHandlerRegistry {
  return new JobHandlerRegistry()
    .register(createDocumentExtractionHandler())
    // Registered here and not only in the simulate route. The route built its own
    // registry so the demo could turn the crank synchronously; that left the PRODUCTION
    // runner with no handler for `whatsapp_inbound`, so a real Meta delivery enqueued a
    // job nothing could claim. The message landed, stayed `received`, and -- because
    // attribution never ran -- kept a null organization, which the staff SELECT policy
    // excludes. Invisible to everyone, which is exactly the failure 0005 describes.
    .register(createWhatsAppInboundHandler());
}
