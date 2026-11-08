/**
 * A `ModelTransport` that replays a scripted list of replies and records every request.
 *
 * Substituting the *transport* rather than the whole provider is what makes these tests
 * worth running: the real fencing, the real JSON extraction, the real
 * `ClassificationSchema` validation and the real single-retry loop all execute. A double
 * placed at the `AiProvider` boundary would only prove that a stub returns its argument.
 *
 * `requests` is the assertion surface for the prompt-isolation tests: it holds the exact
 * `system` string and the exact user turns the adapter built.
 */

import type { ModelCallReply, ModelCallRequest, ModelTransport } from '@/services/ai';

export interface ScriptedReply {
  /** Raw reply text, exactly as a model would emit it — valid JSON or not. */
  readonly text: string;
  readonly stopReason?: string | null;
  readonly tokensIn?: number | null;
  readonly tokensOut?: number | null;
  readonly model?: string;
}

export interface ScriptedTransport extends ModelTransport {
  /** Every request the adapter issued, in order. */
  readonly requests: readonly ModelCallRequest[];
}

/**
 * Builds the transport.
 *
 * Running past the end of the script throws rather than repeating the last reply: a test
 * that accidentally triggers a third attempt should fail loudly, because the adapter is
 * specified to make at most two.
 */
export function scriptedTransport(
  replies: readonly ScriptedReply[],
  id = 'scripted',
): ScriptedTransport {
  const requests: ModelCallRequest[] = [];
  let index = 0;

  return {
    id,
    requests,
    async send(request: ModelCallRequest): Promise<ModelCallReply> {
      requests.push(request);
      const reply = replies[index];
      index += 1;
      if (!reply) {
        throw new Error(`scriptedTransport: no reply scripted for attempt ${index}`);
      }
      return {
        text: reply.text,
        model: reply.model ?? request.model,
        stopReason: reply.stopReason ?? 'end_turn',
        tokensIn: reply.tokensIn ?? 100,
        tokensOut: reply.tokensOut ?? 50,
      };
    },
  };
}

/** A schema-valid classification, as JSON text. Overridable field by field. */
export function validClassificationJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    category: 'hvac',
    summary: 'Air conditioning is running but not cooling.',
    reported_symptoms: ['AC running', 'room not cooling'],
    suggested_priority: 'normal',
    missing_information: [],
    requires_clarification: false,
    clarification_question: null,
    ...overrides,
  });
}
