/**
 * The two WhatsApp webhook handlers, assembled from the pieces either side of this file.
 *
 * `app/api/v1/webhooks/whatsapp/route.ts` is three lines of re-export; everything that
 * decides anything is here, so the route file cannot acquire logic by accretion and the
 * security-relevant code sits in one reviewable module under `server-only/`.
 *
 * GET  — Meta's subscription handshake. Constant-time token comparison, echo challenge.
 * POST — a delivery. Verify, deduplicate, normalise, enqueue, 200.
 *
 * The ordering invariant worth restating once more, because it is the difference
 * between a verified webhook and a decorative one: `ctx.rawBody` is the octets Meta
 * sent, the HMAC is computed over those octets, and `JSON.parse` does not run until
 * after the comparison has succeeded. Nothing between the socket and
 * `verifyWebhookSignature` interprets the body.
 */

import 'server-only';

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { REQUEST_ID_HEADER } from '@/lib/observability/correlation';
import { isProduction } from '@/lib/env';
import { tryCreateServiceRoleClient } from '@/lib/supabase/server-only/service-role';

import {
  HUB_CHALLENGE_PARAM,
  HUB_MODE_PARAM,
  HUB_SUBSCRIBE_MODE,
  HUB_VERIFY_TOKEN_PARAM,
  MAX_WEBHOOK_BODY_BYTES,
  SIGNATURE_HEADER,
  WHATSAPP_PROVIDER,
} from '../whatsapp/constants';
import { resolveWebhookMode, type WebhookMode } from '../whatsapp/mode';
import { WhatsAppDeliverySchema, deliveryEventIds, normaliseDelivery } from '../whatsapp/payload';
import { constantTimeEquals, verifyWebhookSignature } from '../whatsapp/signature';
import { WebhookStorageUnavailableError, ingestDelivery } from './ingest';
import {
  withWebhookRoute,
  withWebhookVerificationRoute,
  type WebhookContext,
} from './webhook-handler';
import { whatsappAppSecret, whatsappVerifyToken } from './whatsapp-secrets';

/**
 * Rate limits.
 *
 * Generous, because the subject is the endpoint rather than a caller: Meta legitimately
 * batches and retries, and a limit tight enough to be interesting would mostly succeed
 * at rejecting real deliveries. It exists to bound the cost of an unauthenticated flood
 * reaching `arrayBuffer()`, not to shape Meta's traffic.
 */
const DELIVERY_RATE_LIMIT = { key: 'webhooks:whatsapp', perMinute: 600, burst: 120 } as const;
const HANDSHAKE_RATE_LIMIT = { key: 'webhooks:whatsapp:verify', perMinute: 30 } as const;

/* ------------------------------------------------------------ GET: verify -- */

/**
 * The subscription handshake.
 *
 * Meta calls this once when the webhook URL is registered and expects the value of
 * `hub.challenge` back as a bare body — not JSON, not an envelope. That is a wire
 * contract, so this is the one response in the lane that is not `{ data }`; failures
 * still use the frozen error envelope.
 *
 * The verify token is a bearer credential and is compared with `constantTimeEquals`.
 * `===` would leak it a character at a time to anyone able to call this endpoint
 * repeatedly and measure, which — the endpoint being public by necessity — is everyone.
 *
 * A wrong token, a missing token and a wrong `hub.mode` all produce the same 403 with
 * the same message. Distinguishing them would tell a prober how far along they are.
 */
export const GET = withWebhookVerificationRoute(
  { provider: WHATSAPP_PROVIDER, rateLimit: HANDSHAKE_RATE_LIMIT },
  ({ request, requestId, logger }) => {
    const config = requireWebhookConfig();
    const params = new URL(request.url).searchParams;

    const mode = params.get(HUB_MODE_PARAM) ?? '';
    const token = params.get(HUB_VERIFY_TOKEN_PARAM) ?? '';
    const challenge = params.get(HUB_CHALLENGE_PARAM) ?? '';

    const modeOk = constantTimeEquals(mode, HUB_SUBSCRIBE_MODE);
    const tokenOk = constantTimeEquals(token, config.verifyToken);

    if (!modeOk || !tokenOk || challenge.length === 0) {
      throw new ApiRouteError('FORBIDDEN', {
        message: 'Webhook verification failed.',
        logFields: {
          provider: WHATSAPP_PROVIDER,
          reason: 'hub_verification_failed',
          outcome: 'rejected',
        },
      });
    }

    logger.info('webhook subscription verified', {
      provider: WHATSAPP_PROVIDER,
      outcome: 'verified',
      // The *mode* is reported; the token that proved it never is.
      status: config.mode,
    });

    // Meta requires the raw challenge. Length-bounded so a caller cannot use the
    // handshake as an arbitrary-length echo endpoint.
    return new Response(challenge.slice(0, 256), {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        [REQUEST_ID_HEADER]: requestId,
      },
    });
  },
);

/* ---------------------------------------------------------- POST: deliver -- */

export const POST = withWebhookRoute(
  {
    provider: WHATSAPP_PROVIDER,
    rateLimit: DELIVERY_RATE_LIMIT,
    maxBodyBytes: MAX_WEBHOOK_BODY_BYTES,

    /**
     * Authentication: the HMAC, over the raw bytes, before anything parses them.
     *
     * The failure is `UNAUTHENTICATED` rather than `FORBIDDEN` because what failed is a
     * credential check, not an authorization decision — there is no authenticated
     * principal here whose permissions could be insufficient. All three failure reasons
     * (absent header, malformed header, mismatch) return the same status and the same
     * message; only the server log distinguishes them.
     */
    authenticate(ctx: WebhookContext) {
      const config = requireWebhookConfig();
      const verification = verifyWebhookSignature({
        rawBody: ctx.rawBody,
        header: ctx.request.headers.get(SIGNATURE_HEADER),
        key: config.signingKey,
      });

      if (!verification.ok) {
        throw new ApiRouteError('UNAUTHENTICATED', {
          logFields: {
            provider: WHATSAPP_PROVIDER,
            reason: verification.reason,
            outcome: 'rejected',
            // Which key source rejected it. Useful when a live deployment starts
            // failing; reveals nothing, because the mode is already in every response.
            status: config.mode,
          },
        });
      }
    },
  },

  async (ctx) => {
    const config = requireWebhookConfig();

    /* parse — only now that the bytes are proven ---------------------------- */
    const delivery = parseDelivery(ctx.rawBody);
    const normalised = normaliseDelivery(delivery);
    const allEventIds = deliveryEventIds(delivery);

    /* the queue and the ledger are service-role only ------------------------ */
    const client = tryCreateServiceRoleClient();
    if (!client) {
      // `webhook_events`, `inbound_messages` and `jobs` all have RLS enabled with zero
      // policies. With no service-role credential there is nowhere to record the
      // delivery, and answering 200 would tell Meta the message was safely received
      // when it was discarded. A 500 makes Meta retry, which is the correct behaviour
      // for a delivery we genuinely failed to accept.
      throw new ApiRouteError('INTERNAL_ERROR', {
        logFields: { provider: WHATSAPP_PROVIDER, reason: 'service_role_unavailable' },
      });
    }

    let result;
    try {
      result = await ingestDelivery({
        client,
        logger: ctx.logger,
        messages: normalised.messages,
        allEventIds,
        requestId: ctx.requestId,
      });
    } catch (thrown) {
      if (thrown instanceof WebhookStorageUnavailableError) {
        // Migration 0004 has not been applied. Same reasoning as above: retriable on
        // our side, so say so rather than acknowledging a delivery we dropped.
        throw new ApiRouteError('INTERNAL_ERROR', {
          logFields: {
            provider: WHATSAPP_PROVIDER,
            reason: 'webhook_tables_absent',
            pg_code: thrown.pgCodeValue,
          },
        });
      }
      throw thrown;
    }

    ctx.logger.info('whatsapp delivery accepted', {
      provider: WHATSAPP_PROVIDER,
      outcome: 'accepted',
      status: config.mode,
      count: allEventIds.length,
    });

    /*
     * 200, and the counts.
     *
     * Always 200 once the signature verified and the ledger was reachable, including
     * when every id was a duplicate — a duplicate is a *successful* outcome of an
     * at-least-once channel, and reporting it as an error would make Meta retry the one
     * thing that is already correct. `mode` is in the body because the briefing's demo
     * requirement is that simulated mode says so: a reviewer reading the response can
     * see which key verified the request without reading the server's configuration.
     */
    return ok(
      {
        provider: WHATSAPP_PROVIDER,
        mode: config.mode,
        received: allEventIds.length,
        accepted: result.accepted,
        duplicates: result.duplicates,
        // New, non-text message ids: acknowledged and deduplicated, but with no
        // `inbound_messages` row. A *duplicate* image counts under `duplicates`, which
        // is why this is `result.unsupported` and not `normalised.unsupportedCount` —
        // the latter counts every non-text message in the delivery, seen before or not.
        unsupported: result.unsupported,
        failed: result.failed,
        statuses: normalised.statusCount,
        events: result.events.map((event) => ({
          // The `wamid` is the provider's own opaque id and is already known to the
          // sender. No part of the message accompanies it.
          event_id: event.eventId,
          outcome: event.outcome,
        })),
      },
      ctx.requestId,
    );
  },
);

/* ---------------------------------------------------------------- helpers -- */

interface ResolvedWebhookConfig {
  readonly mode: WebhookMode;
  readonly signingKey: string;
  readonly verifyToken: string;
}

/**
 * Resolves the mode, or refuses the request.
 *
 * Called per request rather than memoised at import time so that a deployment which
 * adds `WHATSAPP_APP_SECRET` takes effect on the next request instead of the next cold
 * start — and so an import of this module costs no configuration read. The underlying
 * accessors memoise, so this is a map lookup after the first call.
 *
 * A production deployment with no app secret lands here as `INTERNAL_ERROR` with
 * nothing processed. That is the fail-closed half of simulated mode: the misconfigured
 * production webhook refuses every delivery rather than accepting unsigned ones.
 */
function requireWebhookConfig(): ResolvedWebhookConfig {
  const resolution = resolveWebhookMode({
    appSecret: whatsappAppSecret(),
    verifyToken: whatsappVerifyToken(),
    isProduction: isProduction(),
  });

  if (!resolution.ok) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { provider: WHATSAPP_PROVIDER, reason: resolution.reason, outcome: 'refused' },
    });
  }

  return {
    mode: resolution.mode,
    signingKey: resolution.signingKey,
    verifyToken: resolution.verifyToken,
  };
}

/**
 * Decodes and validates the delivery.
 *
 * A malformed body after a valid signature is a genuine oddity — somebody holding the
 * app secret sent us nonsense — so it is a 422 rather than a 400: the request was
 * well-formed HTTP and correctly authenticated, and the *content* is what cannot be
 * processed. Nothing about the body reaches the log line; only the issue count.
 */
function parseDelivery(rawBody: Uint8Array) {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
  } catch {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'Webhook payload could not be decoded.',
      logFields: { provider: WHATSAPP_PROVIDER, reason: 'body_not_utf8' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'Webhook payload could not be parsed.',
      logFields: { provider: WHATSAPP_PROVIDER, reason: 'body_not_json' },
    });
  }

  const result = WhatsAppDeliverySchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'Webhook payload did not match the expected shape.',
      logFields: {
        provider: WHATSAPP_PROVIDER,
        reason: 'delivery_schema_rejected',
        count: result.error.issues.length,
      },
    });
  }
  return result.data;
}
