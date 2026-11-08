/**
 * Provider selection.
 *
 * `AI_PROVIDER` (validated in `lib/env.ts`, currently the single value `anthropic`)
 * chooses the transport; `AI_MODEL` chooses the model. Both are read here and nowhere
 * else, so a route never names a vendor and never names a model.
 *
 * The provider is memoised because constructing it creates an HTTP client. Memoisation
 * is per process, keyed on nothing: the env is validated once at boot and does not change
 * under us.
 *
 * THE TEST OVERRIDE, AND WHY IT IS NOT A BACK DOOR
 * -----------------------------------------------
 * `registerAiProviderOverride` lets the route tests and the eval suite substitute a
 * recorded transport. It throws in production, so a deployment cannot reach it. More
 * importantly, it cannot be used to inject a system prompt into a *running* request: the
 * override is a whole `AiProvider`, and `AiProvider.classify` still has no system-prompt
 * parameter. A route has no way to call it with one.
 */

import { isProduction, serverEnv } from '@/lib/env';

import { AiNotConfiguredError } from '../errors';
import { createAnthropicProvider } from './anthropic';
import type { AiProvider } from './types';

let cached: AiProvider | null = null;
let override: AiProvider | null = null;

/**
 * The configured adapter.
 *
 * Throws `AiNotConfiguredError` for an unknown provider rather than silently falling
 * back to one. A deployment that misspells `AI_PROVIDER` should fail loudly, not quietly
 * call a model nobody chose. (`lib/env.ts` already constrains the enum; this is the
 * second layer, for the day the enum grows.)
 */
export function getAiProvider(): AiProvider {
  if (override) return override;
  if (cached) return cached;

  const provider = serverEnv().AI_PROVIDER;
  switch (provider) {
    case 'anthropic':
      cached = createAnthropicProvider();
      return cached;
    default:
      throw new AiNotConfiguredError(`unknown_provider_${String(provider)}`);
  }
}

/** Substitutes the adapter. Tests and evals only — refused in production. */
export function registerAiProviderOverride(provider: AiProvider): void {
  if (isProduction()) {
    throw new Error('registerAiProviderOverride is not available in production.');
  }
  override = provider;
}

/** Clears a test override and the memoised instance. */
export function resetAiProvider(): void {
  override = null;
  cached = null;
}

export { createAnthropicProvider, hasAnthropicCredential } from './anthropic';
export { createClassificationProvider, evaluateReply } from './classification-provider';
export type { ClassificationProviderOptions } from './classification-provider';
export type { ModelCallReply, ModelCallRequest, ModelTransport } from './transport';
export type {
  AiProvider,
  ClassificationResult,
  ClassifyInput,
  ClassifyOptions,
  TrustedContext,
  UnitResolution,
  UntrustedInput,
} from './types';
