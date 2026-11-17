/**
 * The simulator's route into the pipeline.
 *
 * WHAT A SIMULATED MESSAGE IS, AND WHAT IT IS NOT
 * ----------------------------------------------
 * Meta credentials are not configured for this build and will not be. Without them a
 * live WhatsApp message cannot arrive, and a demo that waits for one has nothing to
 * show. The temptation at that point is to fake the *result*: insert a row that looks
 * like an arrival and render it. That demonstrates the renderer and nothing else.
 *
 * So this module fakes the *carrier* instead. It assembles a payload in the exact shape
 * Meta's WhatsApp Cloud API posts, **signs it**, and POSTs it to this application's own
 * webhook endpoint — lane w3-l6's production handler. What then runs is the real path,
 * end to end:
 *
 *   · `X-Hub-Signature-256` verified as an HMAC-SHA256 over the raw body, with
 *     `timingSafeEqual`, before anything parses it
 *   · every message id claimed by an insert into `webhook_events`, whose
 *     `unique (provider, event_id)` constraint — not application code — is what makes
 *     Meta's at-least-once retries have exactly-once effects
 *   · normalisation into `inbound_messages` and a job enqueued for sender resolution
 *
 * THE SIGNATURE IS THE POINT, NOT A FORMALITY. An earlier draft of this module sent an
 * `x-propertysuite-simulated: true` header and no signature, on the assumption that
 * simulated mode would wave it through. w3-l6's endpoint correctly answers 401: a header
 * that bypasses verification is precisely the "silently accept unsigned traffic" hole
 * that makes a webhook endpoint a public write API. What makes simulated mode safe is
 * not any key's secrecy but that the *code path* is identical — same HMAC, same
 * comparison, same rejection of an absent header. Only the key's provenance differs.
 *
 * WHICH KEY, AND WHY IT IS NOT DECIDED HERE. An earlier draft of this module signed with
 * the published `SIMULATED_SIGNING_KEY` unconditionally. That worked in development and
 * failed in every deployment, because `resolveWebhookMode` — correctly — has no path
 * from `NODE_ENV=production` back to the published key: with `WHATSAPP_APP_SECRET` set
 * the endpoint verifies against the real secret and the published key mismatches (401);
 * without it the endpoint refuses every delivery outright (500). Either way the
 * simulator fell through to `writeDirectly()` on the deployed site, which is exactly
 * where the demo's claim stops being true.
 *
 * So the key is **passed in**, resolved per request by the simulate route through the
 * same `resolveWebhookMode` table the endpoint itself consults, from the same validated
 * environment. The simulator therefore signs with whatever key the verifier will use:
 * the published one in development, the real `WHATSAPP_APP_SECRET` in production. This
 * module never reads it — `features/inbox/domain/**` is client-importable and must not
 * touch `services/integrations/server-only/**`. It is handed a string, uses it once, and
 * never logs, returns or audits it (CLAUDE.md rule 8).
 *
 * This is not a downgrade of verification and cannot become one. The simulator holds no
 * credential of its own; it borrows the server's. An operator who can call the simulate
 * route is already authenticated, already a manager or coordinator in their own
 * organization, and the key never leaves the server process that read it.
 *
 * THE FALLBACK, AND WHY IT IS LOUD
 * --------------------------------
 * If the webhook endpoint cannot be reached at all the simulator writes the row directly
 * with the service-role client rather than failing silently. That is a worse path and it
 * is labelled as one: the response carries `ingestion_path: 'direct'`, the chip is
 * `destructive`, and the copy says the webhook was unavailable. A fallback nobody can
 * see is a lie; a fallback on screen is a status.
 *
 * Reaching it now means something is genuinely wrong — an unreachable endpoint, a
 * misconfigured production deployment, a wrong `APP_BASE_URL` — rather than "we
 * deployed". Every reason code it can carry is enumerated on `WebhookOutcome.reason`.
 */

import { serverEnv } from '@/lib/env';
import { REQUEST_ID_HEADER } from '@/lib/observability/correlation';
import type { Logger } from '@/lib/observability/logger';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';
import {
  SIGNATURE_HEADER,
  WHATSAPP_PROVIDER,
  computeWebhookSignature,
} from '@/services/integrations';

import { waveThree, type InboundMessageRow } from './wave-three';

/** Lane w3-l6's endpoint, frozen by `lanes.json` and §5.5. */
export const WEBHOOK_PATH = '/api/v1/webhooks/whatsapp';

/**
 * `provider` written onto the row when the simulator has to write it itself.
 *
 * Deliberately NOT `WHATSAPP_PROVIDER`. `inbound_messages` carries
 * `unique (provider, external_message_id)`, and a fallback row claiming to be a genuine
 * `whatsapp` delivery would occupy the id the real webhook would later use — so a
 * recovered webhook could no longer ingest the same message. A distinct provider keeps
 * the degraded row visible, honest, and out of the real path's way.
 */
export const SIMULATED_PROVIDER = 'whatsapp_simulated';

const DELIVERY_TIMEOUT_MS = 8_000;

export type IngestionPath = 'webhook' | 'direct';

export interface SimulatedDelivery {
  /** Digits only, no `+`. Meta sends `wa_id` in this form. */
  readonly from: string;
  readonly body: string;
  /** `wamid.`-prefixed. The idempotency key the webhook deduplicates on. */
  readonly externalMessageId: string;
  readonly receivedAt: Date;
}

/* ---------------------------------------------------------------- payload -- */

/** A Meta WhatsApp Cloud API `messages` webhook body, with one text message in it. */
export function buildWhatsAppPayload(delivery: SimulatedDelivery): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'propertysuite-simulated-waba',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '971000000000',
                phone_number_id: 'propertysuite-simulated-number',
              },
              contacts: [{ profile: { name: 'Simulated sender' }, wa_id: delivery.from }],
              messages: [
                {
                  from: delivery.from,
                  id: delivery.externalMessageId,
                  timestamp: String(Math.floor(delivery.receivedAt.getTime() / 1000)),
                  type: 'text',
                  text: { body: delivery.body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** `wamid.`-shaped, unique per injection, so the webhook's idempotency key is honest. */
export function newExternalMessageId(): string {
  const unique = globalThis.crypto.randomUUID().replace(/-/g, '');
  return `wamid.SIM${unique.toUpperCase()}`;
}

/* --------------------------------------------------------------- delivery -- */

/** What the webhook reported about one delivery. Counts only — never message text. */
export interface WebhookOutcome {
  readonly delivered: boolean;
  readonly status: number | null;
  /**
   * Reason code when the delivery did not land. Never the server's own message, and
   * never any part of the key material that decided it.
   *
   *   webhook_key_unresolved      the route could not resolve a key the endpoint would
   *                               accept — a production deployment missing
   *                               `WHATSAPP_APP_SECRET` or `WHATSAPP_VERIFY_TOKEN`
   *   webhook_unreachable         no HTTP response at all: DNS, refused, timeout.
   *                               Usually `APP_BASE_URL` pointing somewhere this
   *                               deployment is not
   *   webhook_signature_rejected  401 — the endpoint verified against a different key
   *   webhook_refused             any other non-2xx
   *
   * All four mean the signed round trip did not happen and the row, if any, was written
   * by the degraded path.
   */
  readonly reason: string | null;
  /** `simulated` or `live`, as the endpoint reported it. */
  readonly mode: string | null;
  readonly received: number;
  readonly accepted: number;
  /**
   * Ids the `unique (provider, event_id)` index had already seen.
   *
   * The duplicate-suppression beat: send the same payload twice and the second answers
   * 200 with `duplicates: 1`, because Postgres raised 23505 — not because application
   * code noticed a repeat. That distinction is the whole claim, so the UI reports it.
   */
  readonly duplicates: number;
}

const NOT_DELIVERED: Omit<WebhookOutcome, 'reason' | 'status'> = {
  delivered: false,
  mode: null,
  received: 0,
  accepted: 0,
  duplicates: 0,
};

/**
 * Signs the payload and posts it to the webhook.
 *
 * `options.signingKey` is the key the endpoint will verify with, resolved by the caller
 * — never by this module, which is client-importable and may not reach a secret. `null`
 * means the caller could not resolve one, which in practice is a production deployment
 * with no `WHATSAPP_APP_SECRET`: the endpoint would refuse every delivery, so the
 * delivery is not attempted and the degraded path is taken with a reason code that says
 * which. Signing with the published key there and watching it 401 would be theatre.
 *
 * The bytes that are signed are the bytes that are sent — one `JSON.stringify`, used for
 * both. Signing a re-serialisation would produce a signature over a different body and a
 * 401 that looked like a bug in the verifier.
 *
 * The base URL comes from validated configuration, never from a request header: deriving
 * it from `Host` would let a caller point this delivery at a server of their choosing,
 * which is a server-side request forgery originating inside our own process. The same
 * reasoning is written out at length in `services/ai/maintenance/ticket-creation.ts`, and
 * the two should not differ.
 *
 * No session cookie is forwarded. The webhook is unauthenticated by nature — Meta
 * presents an HMAC, not a cookie — and attaching the operator's credentials to it would
 * be handing them to a code path that has no use for them.
 */
export async function deliverToWebhook(
  delivery: SimulatedDelivery,
  options: {
    requestId: string;
    logger: Logger;
    /**
     * The HMAC key `X-Hub-Signature-256` is computed with. Must be the key the endpoint
     * resolves for this same request, or the round trip is a 401 by construction.
     * `null` when no such key exists. Used once, here; never logged or returned.
     */
    signingKey: string | null;
  },
): Promise<WebhookOutcome> {
  if (!options.signingKey) {
    options.logger.warn('no webhook key could be resolved, so nothing was signed', {
      reason: 'webhook_key_unresolved',
      route: WEBHOOK_PATH,
      outcome: 'degraded',
    });
    return { ...NOT_DELIVERED, status: null, reason: 'webhook_key_unresolved' };
  }

  const base = serverEnv().APP_BASE_URL;
  const payload = JSON.stringify(buildWhatsAppPayload(delivery));
  const signature = computeWebhookSignature(payload, options.signingKey);

  let response: Response;
  try {
    response = await fetch(new URL(WEBHOOK_PATH, base).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signature,
        [REQUEST_ID_HEADER]: options.requestId,
      },
      body: payload,
      cache: 'no-store',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch {
    // Connection refused, DNS, timeout. Nothing from the error is logged: it can carry a
    // URL with credentials in it and it says nothing a reason code does not.
    options.logger.warn('simulated delivery could not reach the webhook', {
      reason: 'webhook_unreachable',
      route: WEBHOOK_PATH,
    });
    return { ...NOT_DELIVERED, status: null, reason: 'webhook_unreachable' };
  }

  if (!response.ok) {
    options.logger.warn('webhook refused a simulated delivery', {
      reason: response.status === 401 ? 'webhook_signature_rejected' : 'webhook_refused',
      route: WEBHOOK_PATH,
      status_code: response.status,
    });
    return {
      ...NOT_DELIVERED,
      status: response.status,
      reason: response.status === 401 ? 'webhook_signature_rejected' : 'webhook_refused',
    };
  }

  const counts = await readCounts(response);

  options.logger.info('simulated delivery accepted by the webhook', {
    route: WEBHOOK_PATH,
    status_code: response.status,
    status: counts.mode ?? 'unknown',
    count: counts.accepted,
    outcome: 'delivered',
  });

  return {
    delivered: true,
    status: response.status,
    reason: null,
    mode: counts.mode,
    received: counts.received,
    accepted: counts.accepted,
    duplicates: counts.duplicates,
  };
}

/**
 * Reads the webhook's counts out of the `{ data }` envelope.
 *
 * Tolerant on purpose: the counts are a demo affordance, and a shape surprise here must
 * not turn a successful ingestion into a reported failure. The delivery already
 * succeeded by the time this runs.
 */
async function readCounts(
  response: Response,
): Promise<{ mode: string | null; received: number; accepted: number; duplicates: number }> {
  const empty = { mode: null, received: 0, accepted: 0, duplicates: 0 };
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return empty;
  }

  if (typeof parsed !== 'object' || parsed === null) return empty;
  const data = (parsed as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return empty;

  const body = data as Record<string, unknown>;
  return {
    mode: typeof body.mode === 'string' ? body.mode : null,
    received: numberOr(body.received),
    accepted: numberOr(body.accepted),
    duplicates: numberOr(body.duplicates),
  };
}

function numberOr(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/* ------------------------------------------------------------ observation -- */

/** The projection used everywhere a full row is read back. */
const ROW_COLUMNS =
  'id, organization_id, provider, external_message_id, from_identifier, body, received_at, status, ticket_id';

/**
 * Reads back the row the webhook wrote. **Observes only — mutates nothing.**
 *
 * Service-role, because an unattributed row (`organization_id is null`) is visible to no
 * organization by policy, and reporting what actually happened to the operator who just
 * injected it is the point of the simulator.
 *
 * It is tempting to go further and *adopt* an unattributed row into the operator's
 * organization so it shows up in the list. This deliberately does not: `0004`'s SELECT
 * policy carries `organization_id is not null` specifically to keep unattributed messages
 * out of every organization's view rather than leaking them to the first one that asks,
 * and the resolution job writes `organization_id = null` for `unmatched` on purpose.
 * Attributing the row here would be this lane quietly overruling that decision from the
 * outside. The mismatch between "an unmatched message must surface in the inbox" and "an
 * unattributed row is visible to nobody" is a real planning defect and is reported as
 * one; it is not worked around here.
 */
export async function observeDelivery(
  serviceRole: PrivilegedSupabaseClient,
  externalMessageId: string,
): Promise<InboundMessageRow | null> {
  const { data, error } = await waveThree(serviceRole)
    .from('inbound_messages')
    .select(ROW_COLUMNS)
    .eq('external_message_id', externalMessageId)
    .maybeSingle();

  if (error || !data) return null;
  return data as InboundMessageRow;
}

/* --------------------------------------------------------------- fallback -- */

/**
 * The degraded path: write the row ourselves.
 *
 * Reached only when the webhook could not be contacted at all. Service-role, because
 * `0004` revokes INSERT on `inbound_messages` from `authenticated` outright — a
 * caller-scoped insert would be refused, correctly.
 *
 * `organizationId` is the caller's own, from `ctx.membership`. It is never read from the
 * request body (CLAUDE.md rule 5), which is what stops this path from being a way to post
 * a message into somebody else's inbox.
 */
export async function writeDirectly(
  serviceRole: PrivilegedSupabaseClient,
  delivery: SimulatedDelivery,
  organizationId: string,
  logger: Logger,
): Promise<InboundMessageRow> {
  const { data, error } = await waveThree(serviceRole)
    .from('inbound_messages')
    .insert({
      organization_id: organizationId,
      provider: SIMULATED_PROVIDER,
      external_message_id: delivery.externalMessageId,
      from_identifier: delivery.from,
      body: delivery.body,
      received_at: delivery.receivedAt.toISOString(),
      status: 'received',
    })
    .select(ROW_COLUMNS)
    .single();

  if (error || !data) {
    logger.warn('direct simulated write failed', { reason: 'inbound_message_insert_failed' });
    throw new Error('inbound_message_insert_failed');
  }

  logger.warn('simulated message written directly — the webhook was unavailable', {
    reason: 'webhook_unavailable',
    provider: WHATSAPP_PROVIDER,
    outcome: 'degraded',
  });
  return data as InboundMessageRow;
}
