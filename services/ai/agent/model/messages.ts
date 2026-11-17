/**
 * The tool-calling model seam.
 *
 * `services/ai/providers/transport.ts` already defines a transport seam, and this is
 * deliberately NOT a competitor to it. That one carries `{ system, userTurns }` — one
 * instruction and a list of user turns — which is everything a single-shot
 * classification needs and strictly less than a tool-calling loop needs. A loop has to
 * send back the assistant turn that *contained* the tool call, with its call ids, and
 * then one `role: "tool"` message per result, or the model cannot match a result to the
 * call it made.
 *
 * So the shapes below extend the same idea rather than replacing it: a transport still
 * only moves bytes, still owns no policy, still never sees a Supabase client, and still
 * gets its system prompt from the caller rather than inventing one.
 *
 * PLANNING DEFECT, RECORDED HERE RATHER THAN WORKED AROUND SILENTLY
 * ----------------------------------------------------------------
 * `services/ai/providers/nvidia.ts` says, correctly, that it is the only file in the
 * repository that knows NVIDIA exists. `model/nim-transport.ts` next to this one breaks
 * that property, because this lane does not own `services/ai/providers/**` and tool
 * calling needs four additional fields on the wire. The fix is a small additive change to
 * the shared transport; the exact diff is in this lane's report. Once applied,
 * `nim-transport.ts` becomes a delegate and the duplicated vendor knowledge goes away.
 */

import type { Json } from '@shared/index';

import type { JsonSchemaObject } from '../types';

/** One tool call the model asked for. `id` must be echoed back on the result. */
export interface ModelToolCall {
  /** Provider-assigned call id. Opaque. Used only to pair a result with its call. */
  readonly id: string;
  readonly name: string;
  /** The raw JSON string the model emitted. Not yet parsed and not yet trusted. */
  readonly rawArguments: string;
}

/**
 * One message in the conversation sent to the model.
 *
 * `system` appears exactly once, first, and is built from `prompt.ts` — never from a
 * caller. There is no variant through which request data could become a system message,
 * which is the same structural property `services/ai/providers/types.ts` relies on.
 */
export type AgentChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls: readonly ModelToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

/** A tool as advertised to the model. Mirrors the OpenAI-compatible `tools` entry. */
export interface ModelToolSpec {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchemaObject;
  };
}

export interface ToolCallingRequest {
  readonly model: string;
  readonly messages: readonly AgentChatMessage[];
  readonly tools: readonly ModelToolSpec[];
  readonly maxOutputTokens: number;
}

export interface ToolCallingReply {
  /** The assistant's prose, or `null` when it only asked for tools. */
  readonly text: string | null;
  /** Empty when the model answered instead of calling a tool. */
  readonly toolCalls: readonly ModelToolCall[];
  readonly model: string;
  readonly finishReason: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

export interface ToolCallingTransport {
  /** Stable id for logs. */
  readonly id: string;
  send(request: ToolCallingRequest, signal?: AbortSignal): Promise<ToolCallingReply>;
}

/** Serialises a tool result for a `role: "tool"` message. */
export function toolResultContent(data: Json, fencedText: string | null): string {
  const structured = JSON.stringify(data);
  return fencedText ? `${structured}\n\n${fencedText}` : structured;
}
