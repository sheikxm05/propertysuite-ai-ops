/**
 * ===========================================================================
 * PLANNING DEFECT — THIS MODULE SHOULD NOT EXIST. REPORTED, NOT WORKED AROUND.
 * ===========================================================================
 *
 * The four WhatsApp variables belong in `lib/server-only/secrets.ts`, which lane w0-l5
 * owns and this lane may not write (CLAUDE.md rule 2). They are currently commented out
 * in `.env.example` as later-phase, and `.env.example` belongs to w0-l1.
 *
 * The briefing's instruction was: report the exact additions needed and *code against
 * the accessor names you propose*. So the names below are the proposed ones, and when
 * the owning lanes apply the diff in this lane's report, the four function bodies here
 * collapse to a re-export:
 *
 *     export {
 *       whatsappVerifyToken, whatsappAppSecret,
 *       whatsappAccessToken, whatsappPhoneNumberId,
 *     } from '@/lib/server-only/secrets';
 *
 * Nothing else in this lane changes, because nothing else in this lane imports those
 * names from anywhere but here. That is the whole reason this is one module with four
 * functions rather than four `process.env` reads scattered across the integration.
 *
 * Until then it honours the same three guarantees the real module does: it lives under
 * `server-only/` so `eslint.config.mjs` refuses a client import, it imports the
 * `server-only` package so a client import is a *build* failure, and it asserts the
 * runtime. It also goes through the same `presentValue` / `parseEnvOrThrow` helpers
 * from `lib/env.ts`, so `WHATSAPP_APP_SECRET=` — set but blank, which is what a copied
 * `.env.example` produces — reads as absent and selects simulated mode, instead of
 * failing a length check at boot.
 *
 * None of these values is ever logged or returned in a response. `WHATSAPP_APP_SECRET`
 * and `WHATSAPP_VERIFY_TOKEN` are compared against, never echoed; the mode a request
 * ran in is reported, the key that decided it is not.
 */

import 'server-only';

import { z } from 'zod';

import { assertServerRuntime, parseEnvOrThrow, presentValue } from '@/lib/env';

/**
 * All four are optional, and that is the design rather than laxity.
 *
 * A deployment with none of them is the normal development and demo state: the webhook
 * runs in simulated mode and the outbound adapter uses the recording sink. A deployment
 * with `NODE_ENV=production` and no app secret is refused at request time by
 * `resolveWebhookMode`, not here — failing at boot would be defensible, but it would
 * also mean this module decides production policy, and policy belongs in the pure
 * decision table where it can be read in one place.
 */
const WhatsAppSecretsSchema = z.object({
  /** Echoed back to Meta's `GET` handshake after a constant-time comparison. */
  WHATSAPP_VERIFY_TOKEN: presentValue(z.string().min(8).optional()),
  /** HMAC-SHA256 key for `X-Hub-Signature-256`, over the raw request body. */
  WHATSAPP_APP_SECRET: presentValue(z.string().min(16).optional()),
  /** Bearer token for the Graph API send call. */
  WHATSAPP_ACCESS_TOKEN: presentValue(z.string().min(20).optional()),
  /** The business phone number id the send call is addressed to. Not itself a secret. */
  WHATSAPP_PHONE_NUMBER_ID: presentValue(z.string().min(1).max(64).optional()),
});

type WhatsAppSecrets = z.infer<typeof WhatsAppSecretsSchema>;

let cache: WhatsAppSecrets | null = null;

function read(): WhatsAppSecrets {
  if (cache) return cache;
  cache = parseEnvOrThrow(WhatsAppSecretsSchema, {
    WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
    WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
  });
  return cache;
}

/** The handshake token, or `null` when unconfigured. */
export function whatsappVerifyToken(): string | null {
  assertServerRuntime('whatsappVerifyToken()');
  return read().WHATSAPP_VERIFY_TOKEN ?? null;
}

/** The signature key, or `null` — which is what selects simulated mode. */
export function whatsappAppSecret(): string | null {
  assertServerRuntime('whatsappAppSecret()');
  return read().WHATSAPP_APP_SECRET ?? null;
}

/** The Graph API bearer token, or `null` — which selects the recording sink. */
export function whatsappAccessToken(): string | null {
  assertServerRuntime('whatsappAccessToken()');
  return read().WHATSAPP_ACCESS_TOKEN ?? null;
}

/** The business phone number id, or `null`. */
export function whatsappPhoneNumberId(): string | null {
  assertServerRuntime('whatsappPhoneNumberId()');
  return read().WHATSAPP_PHONE_NUMBER_ID ?? null;
}

/** Test and boot seam: forget the memoised values after the environment changes. */
export function resetWhatsAppSecretsCache(): void {
  cache = null;
}
