/**
 * NVIDIA NIM transport, tool-calling variant.
 *
 * WHY THIS FILE EXISTS, STATED PLAINLY
 * ------------------------------------
 * `services/ai/providers/nvidia.ts` is the repository's single NVIDIA-aware file and says
 * so in its header. It is correct, and this file dents that property. It exists because
 * `services/ai/providers/**` belongs to another lane, the shared `ModelCallRequest` has
 * no `tools` field, and tool calling cannot be bolted on from outside. This lane
 * reported the gap as a planning defect with the exact additive diff for
 * `providers/transport.ts` and `providers/nvidia.ts`; when that lands, the body of
 * `send` below collapses into a call to the shared transport and the vendor knowledge
 * here disappears. Nothing else in this directory names a vendor.
 *
 * THE THREE LESSONS FROM `providers/nvidia.ts`, HONOURED RATHER THAN REDISCOVERED
 * ------------------------------------------------------------------------------
 *  1. **Models die.** HTTP 410 means end of life. It is permanent for a configuration
 *     and must never be retried — a retry burns a second call and sends the operator
 *     chasing a network fault that does not exist. Mapped to `AiNotConfiguredError`,
 *     because the fix is a config change.
 *  2. **`/v1/models` is the catalogue, not your entitlements.** A listed model can still
 *     answer "not found for account". Also configuration, also not transient. 404 joins
 *     410, 401 and 403 on the permanent side.
 *  3. **Some NIM models are reasoning models** and spend the whole budget thinking,
 *     returning `content: null` with `finish_reason: 'length'`. That is a different
 *     failure from a refusal and is reported as one — see `REASONING_TOKEN_FLOOR`.
 *     `reasoning_content` is read only to detect the case; it is never returned upward
 *     and never logged, because it can restate the fenced untrusted input verbatim and
 *     would walk tenant text straight past the redaction allowlist (CLAUDE.md rule 8).
 *
 * The model must support tool calling. `nvidia/nemotron-3.5-bolt-e4b` does — a `tools`
 * array comes back as `finish_reason: "tool_calls"` with a populated `tool_calls`. The
 * model id is `AI_MODEL`, read in `lib/env.ts` and nowhere else, so this file names no
 * model.
 */

import { serverEnv } from '@/lib/env';
import { nvidiaApiKey } from '@/lib/server-only/secrets';

import { AiNotConfiguredError, AiProviderError } from '../../errors';
import type {
  AgentChatMessage,
  ModelToolCall,
  ToolCallingReply,
  ToolCallingRequest,
  ToolCallingTransport,
} from './messages';

export const NIM_TOOL_TRANSPORT_ID = 'nvidia';

/**
 * Per-call timeout.
 *
 * Shorter than the classification transport's 45s because the agent makes several calls
 * inside one HTTP request and the loop's own wall-clock budget has to hold overall. A
 * single round that takes half a minute has already failed the user.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** See lesson three. Only ever raises the caller's budget, never caps it. */
const REASONING_TOKEN_FLOOR = 2_048;

/** Largest reply body accepted, as a guard against a pathological response. */
const MAX_TOOL_CALLS_IN_REPLY = 8;

function readApiKey(): string | null {
  try {
    const key = nvidiaApiKey();
    return key && key.trim().length > 0 ? key : null;
  } catch {
    return null;
  }
}

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Permanent for a configuration. Never retried. See lessons one and two. */
function isConfigurationFault(status: number): boolean {
  return status === 401 || status === 403 || status === 404 || status === 410;
}

/** The subset of the OpenAI-compatible reply this transport relies on. */
interface ChatCompletionReply {
  readonly model?: unknown;
  readonly choices?: readonly {
    readonly finish_reason?: unknown;
    readonly message?: {
      readonly content?: unknown;
      readonly reasoning_content?: unknown;
      readonly tool_calls?: readonly {
        readonly id?: unknown;
        readonly type?: unknown;
        readonly function?: { readonly name?: unknown; readonly arguments?: unknown };
      }[];
    };
  }[];
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
  readonly title?: unknown;
  readonly detail?: unknown;
}

/** The wire shape of one message. Built here; the loop never sees provider JSON. */
function toWireMessage(message: AgentChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'assistant':
      // `content` must be present even when the turn was only a tool call; several
      // OpenAI-compatible servers reject a missing key outright.
      return message.toolCalls.length === 0
        ? { role: 'assistant', content: message.content ?? '' }
        : {
            role: 'assistant',
            content: message.content ?? '',
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.rawArguments },
            })),
          };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
}

function parseToolCalls(raw: ChatCompletionReply['choices']): readonly ModelToolCall[] {
  const calls = raw?.[0]?.message?.tool_calls ?? [];
  const parsed: ModelToolCall[] = [];

  for (const call of calls.slice(0, MAX_TOOL_CALLS_IN_REPLY)) {
    const id = asString(call.id);
    const name = asString(call.function?.name);
    if (!id || !name) continue;
    // `arguments` is a JSON *string* on this API. It is not parsed here: parsing is
    // validation, validation belongs to the tool's own Zod schema, and a transport that
    // started interpreting payloads would stop being a transport.
    const rawArguments =
      typeof call.function?.arguments === 'string' ? call.function.arguments : '{}';
    parsed.push({ id, name, rawArguments });
  }

  return parsed;
}

/**
 * The live transport.
 *
 * Refuses up front when the deployment is not configured for NVIDIA. `AI_MODEL` would
 * otherwise be sent to NIM unchanged — an Anthropic model id posted to NVIDIA returns a
 * 404 that reads like an outage. Failing closed with a named reason is kinder.
 */
export function createNimToolTransport(): ToolCallingTransport {
  return {
    id: NIM_TOOL_TRANSPORT_ID,

    async send(request: ToolCallingRequest, signal?: AbortSignal): Promise<ToolCallingReply> {
      const env = serverEnv();
      if (env.AI_PROVIDER !== 'nvidia') {
        throw new AiNotConfiguredError(
          `agent_requires_tool_capable_provider (AI_PROVIDER=${env.AI_PROVIDER})`,
        );
      }

      const apiKey = readApiKey();
      if (!apiKey) throw new AiNotConfiguredError('missing_nvidia_api_key');

      const baseUrl = env.NVIDIA_BASE_URL.replace(/\/+$/, '');

      const body = {
        model: request.model,
        temperature: env.NVIDIA_TEMPERATURE,
        max_tokens: Math.max(request.maxOutputTokens, REASONING_TOKEN_FLOOR),
        messages: request.messages.map(toWireMessage),
        tools: request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          },
        })),
        // `auto`, never `required`. Forcing a tool call on the final round would make it
        // impossible for the model to simply answer, and an agent that must always call
        // something is an agent that will call something it should not.
        tool_choice: 'auto',
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
        const name = error instanceof Error ? error.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new AiProviderError('aborted', { provider: NIM_TOOL_TRANSPORT_ID, cause: error });
        }
        throw new AiProviderError('unreachable', { provider: NIM_TOOL_TRANSPORT_ID, cause: error });
      }

      let payload: ChatCompletionReply;
      try {
        payload = (await response.json()) as ChatCompletionReply;
      } catch (error) {
        throw new AiProviderError('upstream_error', {
          provider: NIM_TOOL_TRANSPORT_ID,
          upstreamStatus: response.status,
          cause: error,
        });
      }

      if (!response.ok) {
        // NIM returns problem+json. `detail` names the model and the account and carries
        // no request content, so it is safe to use as a reason.
        const reason = asString(payload.detail) ?? asString(payload.title) ?? 'nvidia_error';

        if (isConfigurationFault(response.status)) {
          throw new AiNotConfiguredError(
            response.status === 410 ? `model_end_of_life: ${reason}` : `nvidia_rejected: ${reason}`,
          );
        }
        if (response.status === 429) {
          throw new AiProviderError('rate_limited', {
            provider: NIM_TOOL_TRANSPORT_ID,
            upstreamStatus: response.status,
          });
        }
        throw new AiProviderError('upstream_error', {
          provider: NIM_TOOL_TRANSPORT_ID,
          upstreamStatus: response.status,
        });
      }

      const choice = payload.choices?.[0];
      const text = asString(choice?.message?.content);
      const toolCalls = parseToolCalls(payload.choices);
      const finishReason = asString(choice?.finish_reason);

      if (text === null && toolCalls.length === 0) {
        // Lesson three. The *presence* of reasoning content is the signal; its content is
        // never read, never surfaced and never logged.
        const spentOnReasoning =
          typeof choice?.message?.reasoning_content === 'string' &&
          choice.message.reasoning_content.length > 0;

        throw new AiProviderError('upstream_error', {
          provider: NIM_TOOL_TRANSPORT_ID,
          upstreamStatus: response.status,
          cause: new Error(
            spentOnReasoning
              ? `empty_content_after_reasoning (finish_reason=${finishReason ?? 'null'}); raise max_tokens or choose a non-reasoning model`
              : `empty_content (finish_reason=${finishReason ?? 'null'})`,
          ),
        });
      }

      return {
        text,
        toolCalls,
        model: asString(payload.model) ?? request.model,
        finishReason,
        tokensIn: asNumber(payload.usage?.prompt_tokens),
        tokensOut: asNumber(payload.usage?.completion_tokens),
      };
    },
  };
}

/** Whether a live agent run is possible at all. Used by the route's fail-closed check. */
export function hasAgentModelCredential(): boolean {
  return readApiKey() !== null;
}
