/**
 * Chat transport selection for the ask route.
 *
 * `services/ai/providers/index.ts` exports `getAiProvider()`, which hands back an
 * `AiProvider` — an object with exactly two methods, `classify` and
 * `extractDocumentFields`. Both answer a frozen prompt against a frozen schema, and
 * neither is a question-answering call, so neither can serve this route.
 *
 * What this route needs is the layer underneath: `ModelTransport`, the "send these bytes
 * to a model and give me the text back" seam that `services/ai` deliberately split out
 * so that the recorded transport in `evals/` could replace the network and nothing else.
 * Both concrete transports are exported from their own modules; what is missing is a
 * `getModelTransport()` beside `getAiProvider()`. Reported as a planning defect. Until
 * it exists, this file is the two-case switch it would be — five lines, kept in one
 * place and named after the thing it is standing in for.
 *
 * Note what is *not* duplicated here: no prompt, no fence, no schema, no retry policy.
 * Those stay in `services/ai` (fence, reply evaluation) and in `features/rag` (prompt,
 * schema, retry), so this file has no security surface to get wrong.
 */

import { serverEnv } from '@/lib/env';
import { AiNotConfiguredError } from '@/services/ai';
import { createAnthropicTransport } from '@/services/ai/providers/anthropic';
import { createNvidiaTransport } from '@/services/ai/providers/nvidia';
import type { ModelTransport } from '@/services/ai/providers/transport';

/**
 * The configured transport, chosen by `AI_PROVIDER`.
 *
 * Throws for an unknown value rather than falling back to one, for the reason
 * `getAiProvider()` gives: a deployment that misspells its provider should fail loudly,
 * not quietly call a model nobody chose.
 */
export function resolveChatTransport(): ModelTransport {
  const provider = serverEnv().AI_PROVIDER;
  switch (provider) {
    case 'anthropic':
      return createAnthropicTransport();
    case 'nvidia':
      return createNvidiaTransport();
    default:
      throw new AiNotConfiguredError(`unknown_provider_${String(provider)}`);
  }
}

/** The resolved chat model id. Read here so no module in `features/rag` names a model. */
export function resolveChatModel(): string {
  return serverEnv().AI_MODEL;
}
