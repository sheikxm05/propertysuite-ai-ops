/**
 * `POST /api/v1/inbox/simulate` — inject a message as if WhatsApp had delivered it.
 *
 * This is the route the whole demo stands on, so it is worth being exact about what it
 * does and does not claim.
 *
 * IT IS A SIMULATED CARRIER, NOT A SIMULATED RESULT. The handler builds a Meta WhatsApp
 * Cloud API webhook body, **signs it** with `computeWebhookSignature`, and POSTs it to
 * lane w3-l6's production webhook handler. Signature verification, the
 * `unique (provider, event_id)` idempotency gate, normalisation and the job enqueue are
 * all the real code. The only fiction is who made the HTTP request.
 *
 * AND IT STAYS TRUE IN PRODUCTION. The signing key is resolved here, per request,
 * through `resolveWebhookMode` — the same pure decision table
 * `services/integrations/server-only/whatsapp-webhook.ts` consults, fed from the same
 * validated environment. So the simulator signs with whatever key the verifier is about
 * to use: the published simulated key in development, `WHATSAPP_APP_SECRET` in
 * production. Previously it signed with the published key unconditionally, which meant
 * that on any deployment with `NODE_ENV=production` the webhook either mismatched the
 * signature (401, secret present) or refused outright (500, secret absent) and the demo
 * silently ran its degraded direct-write path — the one path that skips every claim the
 * screen makes. Nothing here downgrades verification: there is no flag, the table is
 * untouched, and the route holds no key of its own. It reads the server's key through
 * the server-only accessor, hands it to `deliverToWebhook`, and that is the end of it —
 * the key is never logged, never audited and never in a response (CLAUDE.md rule 8).
 *
 * THEN IT TURNS THE CRANK ONCE. Sender resolution is a queued job, and a demo that
 * needed a separate worker process running in another terminal is a demo that fails on
 * camera. So after the webhook answers, this route runs `runJobsOnce()` with w3-l6's own
 * `createWhatsAppInboundHandler()` — the same handler the standalone worker would run,
 * not a reimplementation of it. One batch, synchronously, and then the row is read back.
 *
 * WHAT IS DERIVED, NOT ACCEPTED
 *   · the organization — `ctx.membership`, always (CLAUDE.md rule 5)
 *   · the sender's number, when a tenant is named — read from that tenant's row through
 *     `tenant_contact()` with the caller's own credentials, so a number cannot be
 *     harvested for a tenant the caller may not see
 *   · `external_message_id` — generated here unless the caller is deliberately replaying
 *     a previous one, which is the duplicate demonstration
 *
 * WHY IT IS PRIVILEGED. `ctx.serviceRole` is used for three things: running the job
 * batch, reading back the row the webhook wrote, and the degraded direct write when the
 * webhook cannot be reached at all. `inbound_messages` has no client-facing INSERT policy
 * — in production an unauthenticated webhook writes it — so a caller-scoped insert would
 * be refused by RLS, correctly. Every read that decides what the caller may *see* still
 * goes through `ctx.supabase`.
 *
 * NOTHING IN HERE LOGS THE MESSAGE. The body is carried to the webhook and never to a
 * logger (CLAUDE.md rule 8). The audit row records the scenario key, the ingestion path
 * and the counts — not a character of what was said.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { accepted } from '@/lib/api/responses';
import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { isProduction } from '@/lib/env';
import type { Logger } from '@/lib/observability/logger';
import { resolveWebhookMode } from '@/services/integrations';
import { createWhatsAppInboundHandler } from '@/services/integrations/server-only/inbound-job';
import {
  whatsappAppSecret,
  whatsappVerifyToken,
} from '@/services/integrations/server-only/whatsapp-secrets';
import { JobHandlerRegistry, runJobsOnce } from '@/services/workers';
import {
  SIMULATED_PROVIDER,
  SimulateMessageSchema,
  audienceFor,
  deliverToWebhook,
  inboxContextFrom,
  maySimulate,
  newExternalMessageId,
  observeDelivery,
  phoneKey,
  tenantDirectory,
  writeDirectly,
  type SimulateMessageInput,
  type SimulatedDelivery,
} from '@/features/inbox/domain';

/**
 * Six a minute. An injection costs a webhook round trip, a row and a job, and a
 * demonstrator clicking faster than that is a stuck key rather than a use case.
 */
const SIMULATE_RATE_LIMIT = { key: 'inbox:simulate', perMinute: 6 } as const;

export const POST = withPrivilegedApiHandler<SimulateMessageInput>(
  {
    bodySchema: SimulateMessageSchema,
    rateLimit: SIMULATE_RATE_LIMIT,
    audit: { action: 'inbound_message_simulated', entityType: 'inbound_message' },
  },
  async (ctx) => {
    const { body, membership, logger } = ctx;

    /* 1. Authorize. An owner or a provider has no inbox, so they cannot post into one. */
    if (!maySimulate(membership.role)) {
      throw new ApiRouteError('FORBIDDEN', {
        logFields: { reason: 'role_cannot_simulate_inbound', role: membership.role },
      });
    }

    /* 2. Resolve the sender. A named tenant's number comes from their row, never the body. */
    const context = inboxContextFrom(ctx);
    const from = await resolveSender(context, body, membership.role);

    /* 3. Build the delivery. A replay reuses the id on purpose; otherwise it is fresh. */
    const delivery: SimulatedDelivery = {
      from,
      body: body.body,
      externalMessageId: body.replay_of ?? newExternalMessageId(),
      receivedAt: new Date(),
    };

    /* 4. The real ingestion path: signed with the verifier's own key, by construction. */
    const attempt = await deliverToWebhook(delivery, {
      requestId: ctx.requestId,
      logger,
      signingKey: webhookSigningKey(logger),
    });

    let messageId: string | null = null;
    let path: 'webhook' | 'direct' = 'webhook';
    let status: string | null = null;
    let attributed = false;

    if (attempt.delivered) {
      /* 5. Run sender resolution now, with w3-l6's own handler. */
      await drainInboundJobs(ctx.serviceRole, logger);

      if (ctx.serviceRole) {
        const row = await observeDelivery(ctx.serviceRole, delivery.externalMessageId);
        messageId = row?.id ?? null;
        status = row?.status ?? null;
        attributed = Boolean(row?.organization_id);
      } else {
        logger.info('ingested row not read back', { reason: 'service_role_unavailable' });
      }
    } else {
      /*
       * 6. Degraded. Written directly, and labelled as a failure everywhere it appears:
       * `ingestion_path: 'direct'` in the response and the audit row, a `destructive`
       * chip, and copy that says the signature check and the idempotency gate did not
       * run. `fallback_reason` is always set here and names which of the four things
       * went wrong. Reaching this branch is now a fault report, not a deployment
       * artefact — the signing key no longer disagrees with the verifier by design.
       */
      if (!ctx.serviceRole) {
        throw new ApiRouteError('INTERNAL_ERROR', {
          logFields: { reason: 'simulator_has_no_ingestion_path' },
        });
      }
      try {
        const row = await writeDirectly(
          ctx.serviceRole,
          delivery,
          membership.organization.id,
          logger,
        );
        messageId = row.id;
        status = row.status;
        attributed = true;
        path = 'direct';
      } catch {
        throw new ApiRouteError('INTERNAL_ERROR', {
          logFields: { reason: 'simulated_write_failed' },
        });
      }
    }

    ctx.audit({
      entityId: messageId,
      metadata: {
        provider: path === 'direct' ? SIMULATED_PROVIDER : 'whatsapp',
        ingestion_path: path,
        webhook_mode: attempt.mode,
        webhook_status: attempt.status,
        accepted: attempt.accepted,
        duplicates: attempt.duplicates,
        fallback_reason: attempt.reason,
        resolution_status: status,
        attributed,
        replayed: Boolean(body.replay_of),
        scenario: body.scenario ?? null,
        sender_named_tenant: Boolean(body.tenant_id),
      },
    });

    /*
     * 202: the message has been handed to the ingestion pipeline and resolved.
     *
     * `ingestion_path`, `duplicates` and `attributed` are in the body rather than only in
     * a log line because the UI renders all three. A fallback nobody can see is a lie; an
     * unattributed message nobody is told about looks like a bug rather than a boundary.
     */
    return accepted(
      {
        id: messageId,
        external_message_id: delivery.externalMessageId,
        ingestion_path: path,
        webhook_mode: attempt.mode,
        webhook_status: attempt.status,
        fallback_reason: attempt.reason,
        received: attempt.received,
        accepted: attempt.accepted,
        duplicates: attempt.duplicates,
        /** `received | unmatched | classified | …` after resolution ran. */
        resolution_status: status,
        /**
         * Whether the row carries an organization, and therefore whether anyone can see
         * it. `false` means the sender resolved to no tenant: `0004`'s SELECT policy
         * requires `organization_id is not null`, so the message is visible to no
         * organization at all — which is the isolation boundary, stated as data.
         */
        attributed,
      },
      ctx.requestId,
    );
  },
);

/**
 * The key the webhook is about to verify this delivery with.
 *
 * WHY IT IS RESOLVED HERE. `features/inbox/domain/**` is client-importable, so it may
 * not reach `services/integrations/server-only/**` and may not read the environment for
 * a credential. A route handler may do both — `eslint.config.mjs` permits `app/api/**`
 * to import `server-only` — so the secret is read at this boundary and passed down as a
 * plain string that is used once and never stored, logged or returned.
 *
 * WHY `resolveWebhookMode` AND NOT A RULE OF OUR OWN. The one thing that must be true is
 * that this key equals the key `requireWebhookConfig()` picks in
 * `services/integrations/server-only/whatsapp-webhook.ts`. Restating that rule here
 * would make it two rules that agree today. Calling the same pure decision table with
 * the same two accessors and the same `isProduction()` makes them the same rule, so the
 * simulator cannot drift from the verifier — including the deliberate refusal in row
 * two, which this honours rather than escapes.
 *
 * `null` is therefore "the endpoint would refuse this delivery whatever I signed":
 * production with no `WHATSAPP_APP_SECRET` or no `WHATSAPP_VERIFY_TOKEN`, or key
 * material that fails its own schema. The caller takes the degraded path and says so.
 * The reason code is logged; the values behind it never are.
 */
function webhookSigningKey(logger: Logger): string | null {
  let resolution: ReturnType<typeof resolveWebhookMode>;
  try {
    resolution = resolveWebhookMode({
      appSecret: whatsappAppSecret(),
      verifyToken: whatsappVerifyToken(),
      isProduction: isProduction(),
    });
  } catch {
    // `EnvironmentError` — a WhatsApp variable is set but malformed (the app secret is
    // under 16 characters, say). The error names variables, never values, but nothing
    // from it is logged regardless: a reason code says as much and risks nothing.
    logger.warn('whatsapp key material did not validate', {
      reason: 'whatsapp_secrets_invalid',
      outcome: 'degraded',
    });
    return null;
  }

  if (!resolution.ok) {
    logger.warn('the webhook would refuse every delivery, so none was signed', {
      reason: resolution.reason,
      outcome: 'degraded',
    });
    return null;
  }

  return resolution.signingKey;
}

/**
 * Runs one batch of inbound-resolution jobs.
 *
 * w3-l6's handler, registered into a registry of its own. `createDefaultRegistry()` is
 * deliberately not used: it is w1-l6's production registry and contains the document
 * extraction handler, which has nothing to do with this request and should not be given
 * a chance to run inside an operator's click.
 *
 * Best effort. A resolution that does not run leaves the message `received`, which the
 * response reports honestly — far better than failing an ingestion that genuinely
 * succeeded.
 */
async function drainInboundJobs(
  serviceRole: Parameters<typeof runJobsOnce>[0]['client'] | undefined,
  logger: Parameters<typeof runJobsOnce>[0]['logger'],
): Promise<void> {
  if (!serviceRole) return;
  try {
    const registry = new JobHandlerRegistry().register(createWhatsAppInboundHandler());
    await runJobsOnce({ client: serviceRole, registry, logger, batchSize: 5 });
  } catch {
    logger?.info('inbound resolution batch did not complete', {
      reason: 'job_batch_failed',
    });
  }
}

/**
 * The number the simulated message comes from.
 *
 * A named tenant is looked up in the caller's own directory — which is scoped by role, so
 * a tenant caller can only ever name themselves — and a raw number is taken as given,
 * which is how the unmatched-sender case is demonstrated.
 *
 * A tenant caller may not supply a raw number. Letting them would let a tenant post a
 * message attributed to a number that is not theirs, and the one claim this screen makes
 * about tenants is that they see and say only their own.
 */
async function resolveSender(
  context: ReturnType<typeof inboxContextFrom>,
  body: SimulateMessageInput,
  role: Parameters<typeof audienceFor>[0],
): Promise<string> {
  if (body.tenant_id) {
    const directory = await tenantDirectory(context);
    const tenant = directory.find((entry) => entry.id === body.tenant_id);
    if (!tenant) {
      throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'tenant_not_visible' } });
    }
    const digits = (tenant.phone ?? '').replace(/\D/g, '').replace(/^00/, '');
    if (!phoneKey(digits)) {
      throw new ApiRouteError('UNPROCESSABLE', {
        message:
          'That tenant has no phone number on record, so WhatsApp could not reach us from it.',
        logFields: { reason: 'tenant_has_no_phone' },
      });
    }
    return digits;
  }

  if (audienceFor(role) === 'own-number') {
    throw new ApiRouteError('FORBIDDEN', { logFields: { reason: 'tenant_cannot_spoof_sender' } });
  }

  return body.from as string;
}
