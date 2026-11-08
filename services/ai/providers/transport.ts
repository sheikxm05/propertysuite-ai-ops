/**
 * The transport seam — one model call, no policy.
 *
 * `services/ai/providers/classification-provider.ts` owns everything that is actually
 * provider-neutral: building the frozen system prompt, fencing untrusted content,
 * extracting JSON, validating against `ClassificationSchema`, and the single retry. A
 * transport owns only "send these bytes to a model and give me the text back".
 *
 * Splitting it there rather than at the `AiProvider` boundary is what makes the eval set
 * runnable with no API key while still being worth running: the recorded transport in
 * `evals/maintenance/recorded-transport.ts` replaces the network and *nothing else*, so
 * an offline eval exercises the real fencing, the real parser, the real schema and the
 * real retry. A stub that replaced the whole provider would assert that a fake returns
 * what it was told to return.
 *
 * `ModelCallRequest.system` is present here because a transport has to send a system
 * prompt. It is not reachable from a caller: the public `AiProvider.classify` signature
 * has no system parameter, the provider constructs this object itself, and a transport
 * is supplied at construction time by `services/ai/providers/index.ts` — never per
 * request and never from a route.
 */

/** What a transport is asked to send. Constructed by the provider, never by a caller. */
export interface ModelCallRequest {
  /** Model id, already resolved from `AI_MODEL`. A transport must not substitute one. */
  readonly model: string;
  /** The frozen system instruction for the active prompt version. */
  readonly system: string;
  /**
   * User-role turns, in order. Turn 0 is trusted framing plus the fenced untrusted data;
   * a retry appends one more. Consecutive user turns are valid — the API combines them.
   */
  readonly userTurns: readonly string[];
  readonly maxOutputTokens: number;
}

/** What a transport returns. Text and counters only; no provider object leaks upward. */
export interface ModelCallReply {
  /** Concatenated text content. May be anything at all — it is not yet trusted. */
  readonly text: string;
  /** The model that actually answered, as reported by the provider. */
  readonly model: string;
  /** `end_turn`, `max_tokens`, `refusal`, ... or `null` if the provider omits it. */
  readonly stopReason: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

export interface ModelTransport {
  /** Stable id for logs. Becomes `AiProvider.id`. */
  readonly id: string;
  send(request: ModelCallRequest, signal?: AbortSignal): Promise<ModelCallReply>;
}
