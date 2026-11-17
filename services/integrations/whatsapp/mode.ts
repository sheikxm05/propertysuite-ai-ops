/**
 * Live versus simulated, decided once, in one pure function.
 *
 * The constraint this lane was built under: there are no Meta credentials and there
 * will not be any — business verification takes days. The wrong responses to that are
 * (a) build nothing and describe it, or (b) build a mode that skips verification. Both
 * were rejected. What is here instead is one verification implementation with two key
 * sources, and a decision table that cannot be talked into the unsafe cell.
 *
 *     WHATSAPP_APP_SECRET   NODE_ENV      →  outcome
 *     ───────────────────   ──────────       ────────────────────────────────────────
 *     present               any           →  live      (verify with the real secret)
 *     absent                production    →  MISCONFIGURED — every delivery refused
 *     absent                anything else →  simulated (verify with the published key)
 *
 * Three properties fall out of that table, and they are the ones worth checking:
 *
 *  1. **Simulated mode is unreachable once a secret exists.** The first row has no
 *     environment qualifier and no override flag. There is no `WHATSAPP_SIMULATE=1`
 *     anywhere in this lane, deliberately: a flag that downgrades verification is a
 *     flag that will one day be set in production by someone debugging at 2am.
 *  2. **Absence in production is a failure, not a downgrade.** The second row returns
 *     `misconfigured`, and the route turns that into a 500 with nothing processed.
 *     Falling back to the published key there would mean anyone who read this file
 *     could post arbitrary tenant messages into the system.
 *  3. **Unsigned traffic is refused in every row.** The mode chooses a *key*; it never
 *     chooses whether to check. `verifyWebhookSignature` is called identically in rows
 *     one and three.
 *
 * `hub.verify_token` follows the same table for the same reasons, with its own
 * variable, so a deployment can configure the handshake and the signature independently.
 */

import { SIMULATED_SIGNING_KEY, SIMULATED_VERIFY_TOKEN } from './constants';

/** Which key source is in force. Reported to the caller; never inferred by the caller. */
export type WebhookMode = 'live' | 'simulated';

export interface WebhookModeInput {
  /** `WHATSAPP_APP_SECRET`, or `null` when unconfigured. */
  readonly appSecret: string | null;
  /** `WHATSAPP_VERIFY_TOKEN`, or `null` when unconfigured. */
  readonly verifyToken: string | null;
  /** True when `NODE_ENV === 'production'`. Passed in so this module stays pure. */
  readonly isProduction: boolean;
}

export type WebhookModeResolution =
  | {
      readonly ok: true;
      readonly mode: WebhookMode;
      /** The HMAC key for `X-Hub-Signature-256`. Never logged, never returned. */
      readonly signingKey: string;
      /** The expected `hub.verify_token`. Never logged, never returned. */
      readonly verifyToken: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'app_secret_absent_in_production' | 'verify_token_absent_in_production';
    };

/**
 * Resolves the key material and the mode, or refuses.
 *
 * Note the asymmetry that is intentional: the *signature* decision is made from
 * `appSecret` alone and the *handshake* decision from `verifyToken` alone, but a
 * production deployment missing either is refused outright. A half-configured
 * production webhook is a worse state than an unconfigured one, because it looks like
 * it works.
 */
export function resolveWebhookMode(input: WebhookModeInput): WebhookModeResolution {
  const { appSecret, verifyToken, isProduction } = input;

  if (isProduction && !appSecret) {
    return { ok: false, reason: 'app_secret_absent_in_production' };
  }
  if (isProduction && !verifyToken) {
    return { ok: false, reason: 'verify_token_absent_in_production' };
  }

  // A configured secret always wins. There is no path from here back to the simulated
  // key once `appSecret` is a non-empty string.
  if (appSecret) {
    return {
      ok: true,
      mode: 'live',
      signingKey: appSecret,
      // A deployment may configure the secret before the handshake token; outside
      // production the simulated token keeps the handshake demonstrable meanwhile.
      verifyToken: verifyToken ?? SIMULATED_VERIFY_TOKEN,
    };
  }

  return {
    ok: true,
    mode: 'simulated',
    signingKey: SIMULATED_SIGNING_KEY,
    verifyToken: verifyToken ?? SIMULATED_VERIFY_TOKEN,
  };
}
