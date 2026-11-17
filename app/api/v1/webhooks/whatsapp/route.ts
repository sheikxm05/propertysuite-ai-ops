/**
 * `GET|POST /api/v1/webhooks/whatsapp`
 *
 * Deliberately three lines of re-export. Every decision — the signature check, the
 * live-versus-simulated mode, the idempotency gate, the normalisation — lives in
 * `services/integrations/server-only/whatsapp-webhook.ts`, so a route file cannot
 * accumulate security logic by accretion and the reviewable surface is one module.
 *
 * GET   Meta's subscription handshake: constant-time `hub.verify_token` comparison,
 *       then the raw `hub.challenge` echoed back as `text/plain` (Meta's contract — it
 *       is the one response here that is not the `{ data }` envelope).
 *
 * POST  A delivery. `X-Hub-Signature-256` is verified as an HMAC-SHA256 over the **raw
 *       request body** before anything parses it, with `crypto.timingSafeEqual`. Each
 *       message id is then claimed by an unconditional insert into
 *       `public.webhook_events`, whose `unique (provider, event_id)` constraint — not
 *       application logic — is what makes Meta's at-least-once retries have
 *       exactly-once effects. Accepted messages are normalised into
 *       `public.inbound_messages` and handed to the existing job queue; the response is
 *       200 and the sender resolution happens out of band.
 *
 * Unauthenticated by necessity: Meta presents an HMAC, not a session cookie. That is
 * why this route does not use `withApiHandler` — see the planning defect recorded at
 * the top of `services/integrations/server-only/webhook-handler.ts`. The frozen §5.2
 * error envelope, the correlation header and the eight error codes still come from
 * `lib/api/**`; only the credential differs.
 *
 * `middleware.ts` does not match `/api/**`, so nothing redirects this path.
 */

/**
 * Node runtime, not edge: signature verification uses `node:crypto`
 * (`createHmac`, `timingSafeEqual`), and the job enqueue uses the service-role client.
 */
export const runtime = 'nodejs';

/** A webhook must never be prerendered or cached. Every delivery is a distinct write. */
export const dynamic = 'force-dynamic';

export { GET, POST } from '@/services/integrations/server-only/whatsapp-webhook';
