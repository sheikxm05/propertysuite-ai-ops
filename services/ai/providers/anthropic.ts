/**
 * The Anthropic transport. The only file in the repository that imports the vendor SDK.
 *
 * It does one thing: send a `ModelCallRequest` and return a `ModelCallReply`. No
 * prompting, no fencing, no validation, no retry policy — those are provider-neutral and
 * live in `classification-provider.ts`, which is why this file is short and why a second
 * vendor would be a sibling of it rather than a rewrite of the lane.
 *
 * MODEL ID
 * The id is passed in on every call and originates from `AI_MODEL` in `lib/env.ts`
 * (§5.7: default `claude-sonnet-5`). It is never written at a call site, never defaulted
 * here, and this file contains no model literal — grep it and you will find none.
 *
 * REQUEST SHAPE
 * `messages.create` is called with exactly `model`, `max_tokens`, `system` and
 * `messages`. No sampling parameters: `temperature`, `top_p` and `top_k` are rejected
 * with a 400 on the Claude 5 family, which is the configured default, so sending one
 * "for determinism" would break every call. Determinism is bought by the frozen prompt
 * and the strict output schema instead.
 *
 * The caller's text appears only in `messages`, already fenced. `system` is the frozen
 * registry constant. Nothing in this file concatenates the two.
 */

import { Anthropic, APIError, AuthenticationError, RateLimitError } from '@anthropic-ai/sdk';

import { serverEnv } from '@/lib/env';
import { anthropicApiKey } from '@/lib/server-only/secrets';

import { AiNotConfiguredError, AiProviderError } from '../errors';
import { createClassificationProvider } from './classification-provider';
import type { ModelCallReply, ModelCallRequest, ModelTransport } from './transport';
import type { AiProvider } from './types';

export const ANTHROPIC_TRANSPORT_ID = 'anthropic';

/** Client-side request timeout. A classification that takes a minute has failed. */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Reads the API key, treating "configured but blank" as absent.
 *
 * `lib/server-only/secrets.ts` validates `ANTHROPIC_API_KEY` with
 * `z.string().min(10).optional()`. An *unset* variable is `undefined` and passes as
 * absent; a variable that is present but empty — which is how `.env.local` ships it
 * before a key is issued — fails `.min(10)` and throws `EnvironmentError`. Both mean the
 * same thing to this lane: there is no credential. Catching it here turns a confusing
 * boot-shaped failure into the `AiNotConfiguredError` the routes already handle.
 *
 * The narrowest possible accommodation: `lib/**` belongs to another lane, so the fix is
 * reported as a planning defect rather than applied across the boundary.
 */
function readApiKey(): string | null {
  try {
    const key = anthropicApiKey();
    return key && key.trim().length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Builds the transport.
 *
 * The client is created lazily on first send, not at module load, so importing this file
 * in an environment with no credential — a unit-test run, a build — is harmless.
 */
export function createAnthropicTransport(): ModelTransport {
  let client: Anthropic | null = null;

  const clientOrThrow = (): Anthropic => {
    if (client) return client;
    const apiKey = readApiKey();
    if (!apiKey) throw new AiNotConfiguredError('missing_anthropic_api_key');
    client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
    return client;
  };

  return {
    id: ANTHROPIC_TRANSPORT_ID,

    async send(request: ModelCallRequest, signal?: AbortSignal): Promise<ModelCallReply> {
      const anthropic = clientOrThrow();

      try {
        const response = await anthropic.messages.create(
          {
            model: request.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: request.userTurns.map((text) => ({ role: 'user' as const, content: text })),
          },
          signal ? { signal } : {},
        );

        const text = response.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');

        return {
          text,
          model: response.model,
          stopReason: response.stop_reason ?? null,
          tokensIn: response.usage?.input_tokens ?? null,
          tokensOut: response.usage?.output_tokens ?? null,
        };
      } catch (error) {
        throw toTransportError(error);
      }
    },
  };
}

/**
 * Maps an SDK failure onto this lane's vocabulary.
 *
 * Typed SDK classes, not message matching. Authentication failure is a configuration
 * fault rather than a transient one, so it becomes `AiNotConfiguredError` and the route
 * reports "unavailable" instead of inviting the tenant to retry forever.
 */
function toTransportError(error: unknown): Error {
  if (error instanceof AiNotConfiguredError) return error;

  if (error instanceof AuthenticationError) {
    return new AiNotConfiguredError('anthropic_credential_rejected', error);
  }
  if (error instanceof RateLimitError) {
    return new AiProviderError('rate_limited', {
      upstreamStatus: error.status ?? 429,
      provider: ANTHROPIC_TRANSPORT_ID,
      cause: error,
    });
  }
  if (error instanceof APIError) {
    return new AiProviderError('upstream_error', {
      upstreamStatus: error.status ?? null,
      provider: ANTHROPIC_TRANSPORT_ID,
      cause: error,
    });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new AiProviderError('aborted', { provider: ANTHROPIC_TRANSPORT_ID, cause: error });
  }
  return new AiProviderError('unreachable', { provider: ANTHROPIC_TRANSPORT_ID, cause: error });
}

/**
 * The Anthropic-backed classification adapter: the neutral core plus this transport.
 *
 * `AI_MODEL` is read here, once, through the validated env accessor.
 */
export function createAnthropicProvider(): AiProvider {
  return createClassificationProvider({
    transport: createAnthropicTransport(),
    model: serverEnv().AI_MODEL,
  });
}

/** Whether a live call is possible at all. Used by the live-only eval gate. */
export function hasAnthropicCredential(): boolean {
  return readApiKey() !== null;
}
