/**
 * Transport selection for the agent loop.
 *
 * Mirrors `services/ai/providers/index.ts`, including the reason the override is not a
 * back door: an override replaces the whole transport, and a transport cannot inject a
 * system prompt into a running request — `ToolCallingRequest.messages` is built by
 * `loop.ts` from `prompt.ts`, and the override is refused in production regardless.
 *
 * Memoised per process. Constructing a transport creates nothing expensive today, but
 * the shape matches the providers barrel so the two do not drift.
 */

import { isProduction } from '@/lib/env';

import { createNimToolTransport } from './nim-transport';
import type { ToolCallingTransport } from './messages';

let cached: ToolCallingTransport | null = null;
let override: ToolCallingTransport | null = null;

/** The configured tool-calling transport. */
export function getAgentTransport(): ToolCallingTransport {
  if (override) return override;
  if (!cached) cached = createNimToolTransport();
  return cached;
}

/** Substitutes the transport. Tests and evals only — refused in production. */
export function registerAgentTransportOverride(transport: ToolCallingTransport): void {
  if (isProduction()) {
    throw new Error('registerAgentTransportOverride is not available in production.');
  }
  override = transport;
}

/** Clears a test override and the memoised instance. */
export function resetAgentTransport(): void {
  override = null;
  cached = null;
}

export {
  createNimToolTransport,
  hasAgentModelCredential,
  NIM_TOOL_TRANSPORT_ID,
} from './nim-transport';
export { toolResultContent } from './messages';
export type {
  AgentChatMessage,
  ModelToolCall,
  ModelToolSpec,
  ToolCallingReply,
  ToolCallingRequest,
  ToolCallingTransport,
} from './messages';
