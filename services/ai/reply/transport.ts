/**
 * Transport selection for reply drafting.
 *
 * Mirrors `services/ai/providers/index.ts` and `services/ai/agent/model/index.ts`: the
 * same switch on `AI_PROVIDER`, the same memoisation, the same test override that is
 * refused in production.
 *
 * WHY THIS FILE EXISTS AT ALL, STATED PLAINLY
 * -------------------------------------------
 * `getAiProvider()` returns an `AiProvider`, whose only two methods are `classify` and
 * `extractDocumentFields`. Neither drafts a reply, and this lane must not add a third
 * method to an interface five other lanes code against — `services/ai/providers/**`
 * belongs to lane w1-l5. What this module needs is one layer lower: the `ModelTransport`
 * seam, which is already provider-neutral and already exists. Both transport
 * constructors are exported from their own modules, so nothing is reimplemented here and
 * **no vendor is named below except as a module specifier**, exactly as in the providers
 * barrel. The one-line additive fix that would delete this file's switch — re-export
 * `createAnthropicTransport` and `createNvidiaTransport` from `services/ai/providers` —
 * is reported as a planning defect rather than applied, because that file is not ours.
 *
 * WHY THE OVERRIDE IS NOT A BACK DOOR
 * -----------------------------------
 * It replaces a whole `ModelTransport`, and a transport cannot inject a system prompt
 * into a running request: `ModelCallRequest.system` is built by `draft.ts` from
 * `prompt.v1.ts`, the public `draftTenantReply` signature has no prompt parameter, and
 * the override throws in production regardless. The argument is the same one
 * `providers/index.ts` makes, and it holds for the same structural reason.
 */

import { isProduction, serverEnv } from '@/lib/env';

import { AiNotConfiguredError } from '../errors';
import { createAnthropicTransport } from '../providers/anthropic';
import { createNvidiaTransport } from '../providers/nvidia';
import type { ModelTransport } from '../providers/transport';

let cached: ModelTransport | null = null;
let override: ModelTransport | null = null;

/**
 * The configured transport.
 *
 * Throws `AiNotConfiguredError` for an unknown provider rather than silently falling back
 * to one, for the reason the providers barrel gives: a deployment that misspells
 * `AI_PROVIDER` should fail loudly, not quietly call a model nobody chose.
 */
export function getReplyTransport(): ModelTransport {
  if (override) return override;
  if (cached) return cached;

  const provider = serverEnv().AI_PROVIDER;
  switch (provider) {
    case 'anthropic':
      cached = createAnthropicTransport();
      return cached;
    case 'nvidia':
      cached = createNvidiaTransport();
      return cached;
    default:
      throw new AiNotConfiguredError(`unknown_provider_${String(provider)}`);
  }
}

/**
 * The configured model id.
 *
 * Read from `AI_MODEL` here and nowhere else in this lane, so no module under
 * `services/ai/reply/**` contains a model literal — grep it and you will find none. The
 * transport must not substitute one.
 */
export function getReplyModelId(): string {
  return serverEnv().AI_MODEL;
}

/** Substitutes the transport. Tests and evals only — refused in production. */
export function registerReplyTransportOverride(transport: ModelTransport): void {
  if (isProduction()) {
    throw new Error('registerReplyTransportOverride is not available in production.');
  }
  override = transport;
}

/** Clears a test override and the memoised instance. */
export function resetReplyTransport(): void {
  override = null;
  cached = null;
}
