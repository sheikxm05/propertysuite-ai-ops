/**
 * NVIDIA NIM transport — the OpenAI-compatible chat-completions API at
 * `https://integrate.api.nvidia.com/v1`.
 *
 * This file is the ONLY place in the repository that knows NVIDIA exists, which is the
 * property `services/ai/providers/types.ts` promises: the neutral core
 * (`createAiProvider`) owns fencing, schema validation and the retry-once-then-reject
 * path, and a transport only moves bytes. Swapping providers is this file plus one
 * `case` in `index.ts`.
 *
 * Deliberately uses `fetch` rather than the `openai` SDK: the dependency list is frozen
 * (parallel-execution-plan.md §5.1) and NIM is plain REST, so a dependency would buy
 * nothing. CLAUDE.md rule 3 forbids installing one regardless.
 *
 * ----------------------------------------------------------------------------
 * THREE THINGS LEARNED BY PROBING THE LIVE API, each of which would otherwise be a
 * production defect:
 *
 *  1. **Models die.** `meta/llama-3.1-70b-instruct` returns HTTP 410 Gone — it reached
 *     end of life on 2026-08-26. A 410 is not retryable and must not be reported as a
 *     transient upstream error, or the retry path will burn a second call and the
 *     operator will chase a network problem that does not exist. Mapped to
 *     `AiNotConfiguredError`, because the fix is a config change.
 *
 *  2. **`/v1/models` lists the catalogue, not your entitlements.** A model can appear in
 *     the list and still answer `Function '<uuid>': Not found for account '<id>'`. That
 *     is also a configuration fault, not a transient one.
 *
 *  3. **Some NIM models are reasoning models** and spend the token budget thinking:
 *     `nvidia/nemotron-3.5-lightning-30b-a3b` returned 325 reasoning tokens and a NULL
 *     `content` for a trivial prompt at `max_tokens: 16`. So a null `content` with
 *     `finish_reason: 'length'` means the budget was exhausted before any answer was
 *     emitted, which is a different failure from "the model refused" and is reported as
 *     such.
 *
 * `reasoning_content` is read ONLY to detect that case. It is never returned upward and
 * never logged: it can restate the fenced untrusted input verbatim, so treating it as
 * loggable would leak document text and tenant messages straight past the redaction
 * allowlist (CLAUDE.md rule 8).
 */

import { serverEnv } from '@/lib/env';
import { nvidiaApiKey } from '@/lib/server-only/secrets';

import { AiNotConfiguredError, AiProviderError } from '../errors';
import { createAiProvider } from './provider';
import type { ModelCallReply, ModelCallRequest, ModelTransport } from './transport';
import type { AiProvider } from './types';

export const NVIDIA_TRANSPORT_ID = 'nvidia';

/** Client-side request timeout. A classification that takes a minute has failed. */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Minimum `max_tokens` sent to NIM, regardless of what the neutral core asked for.
 *
 * The core sizes its budget for the ANSWER. A NIM reasoning model spends that same
 * budget thinking first and only then emits `content`, so the core's figure starves it:
 * the reply comes back `finish_reason: 'length'` with `content: null` and a few hundred
 * `reasoning_tokens` burned. Measured on `nvidia/nemotron-3.5-lightning-30b-a3b`: 325
 * reasoning tokens for a one-line prompt.
 *
 * Raising a floor here rather than in the core is deliberate — it is a property of this
 * provider's models, not of the task, and the core must stay provider-neutral. It only
 * ever RAISES the budget, so a caller asking for more is never capped.
 */
const REASONING_TOKEN_FLOOR = 2_048;

/**
 * Reads the credential without throwing.
 *
 * Mirrors the Anthropic provider: a missing or blank key must surface as the clean
 * "not configured" path, never as a boot-shaped 500 from env validation.
 */
function readApiKey(): string | null {
  try {
    const key = nvidiaApiKey();
    return key && key.trim().length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** The subset of the OpenAI-compatible reply this transport relies on. */
interface ChatCompletionReply {
  readonly model?: unknown;
  readonly choices?: readonly {
    readonly finish_reason?: unknown;
    readonly message?: {
      readonly content?: unknown;
      /** Present on reasoning models. Read for diagnosis only — never surfaced. */
      readonly reasoning_content?: unknown;
    };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
  };
  /** NIM problem+json error shape. */
  readonly title?: unknown;
  readonly detail?: unknown;
  readonly status?: unknown;
  readonly error?: unknown;
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Status codes that mean "the deployment is wrong", not "try again".
 *
 * 410 is the end-of-life case and 404 covers an unentitled or misspelled model. Both are
 * permanent for a given configuration, so they must not be retried.
 */
function isConfigurationFault(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

export function createNvidiaTransport(): ModelTransport {
  return {
    id: NVIDIA_TRANSPORT_ID,

    async send(request: ModelCallRequest, signal?: AbortSignal): Promise<ModelCallReply> {
      const apiKey = readApiKey();
      if (!apiKey) throw new AiNotConfiguredError('missing_nvidia_api_key');

      const env = serverEnv();
      const baseUrl = env.NVIDIA_BASE_URL.replace(/\/+$/, '');

      // The system instruction and the fenced turns arrive already built by the neutral
      // core. This transport must not reorder, merge or edit them: the fence's integrity
      // is the whole anti-injection control.
      const body = {
        model: request.model,
        temperature: env.NVIDIA_TEMPERATURE,
        max_tokens: Math.max(request.maxOutputTokens, REASONING_TOKEN_FLOOR),
        messages: [
          { role: 'system', content: request.system },
          ...request.userTurns.map((content) => ({ role: 'user', content })),
        ],
      };

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: composed,
          cache: 'no-store',
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new AiProviderError('aborted', { provider: NVIDIA_TRANSPORT_ID, cause: error });
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new AiProviderError('aborted', { provider: NVIDIA_TRANSPORT_ID, cause: error });
        }
        throw new AiProviderError('unreachable', { provider: NVIDIA_TRANSPORT_ID, cause: error });
      }

      let payload: ChatCompletionReply;
      try {
        payload = (await response.json()) as ChatCompletionReply;
      } catch (error) {
        throw new AiProviderError('upstream_error', {
          provider: NVIDIA_TRANSPORT_ID,
          upstreamStatus: response.status,
          cause: error,
        });
      }

      if (!response.ok) {
        // NIM returns problem+json: { type, title, detail, status }. `detail` names the
        // model and the account, so it is safe to carry as a reason; it contains no
        // request content.
        const reason = asString(payload.detail) ?? asString(payload.title) ?? 'nvidia_error';

        if (isConfigurationFault(response.status)) {
          throw new AiNotConfiguredError(
            response.status === 410 ? `model_end_of_life: ${reason}` : `nvidia_rejected: ${reason}`,
          );
        }
        if (response.status === 429) {
          throw new AiProviderError('rate_limited', {
            provider: NVIDIA_TRANSPORT_ID,
            upstreamStatus: response.status,
          });
        }
        throw new AiProviderError('upstream_error', {
          provider: NVIDIA_TRANSPORT_ID,
          upstreamStatus: response.status,
        });
      }

      const choice = payload.choices?.[0];
      const text = asString(choice?.message?.content);
      const stopReason = asString(choice?.finish_reason);

      if (text === null) {
        // Distinguish "spent the budget reasoning" from "returned nothing at all". The
        // presence of reasoning_content is the only signal; its CONTENT is never read,
        // logged or surfaced, because it can restate the fenced untrusted input.
        const spentOnReasoning =
          typeof choice?.message?.reasoning_content === 'string' &&
          choice.message.reasoning_content.length > 0;

        throw new AiProviderError('upstream_error', {
          provider: NVIDIA_TRANSPORT_ID,
          upstreamStatus: response.status,
          cause: new Error(
            spentOnReasoning
              ? `empty_content_after_reasoning (finish_reason=${stopReason ?? 'null'}); raise max_tokens or choose a non-reasoning model`
              : `empty_content (finish_reason=${stopReason ?? 'null'})`,
          ),
        });
      }

      return {
        text,
        model: asString(payload.model) ?? request.model,
        stopReason,
        tokensIn: asNumber(payload.usage?.prompt_tokens),
        tokensOut: asNumber(payload.usage?.completion_tokens),
      };
    },
  };
}

/**
 * The NVIDIA-backed adapter: the neutral core plus this transport. Serves both
 * capabilities — maintenance classification and document field extraction — because the
 * core, not the transport, owns the prompts and the schemas.
 */
export function createNvidiaProvider(): AiProvider {
  return createAiProvider({
    transport: createNvidiaTransport(),
    model: serverEnv().AI_MODEL,
  });
}

/** Whether a live call is possible at all. Used by the live-only eval gate. */
export function hasNvidiaCredential(): boolean {
  return readApiKey() !== null;
}
