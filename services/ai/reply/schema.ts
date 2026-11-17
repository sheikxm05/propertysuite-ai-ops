/**
 * The reply-draft contract — what the model is allowed to return, and what this service
 * is allowed to hand back.
 *
 * Two schemas, deliberately not one:
 *
 *   `ReplyDraftModelOutputSchema`  the wire shape, snake_case, validated the moment the
 *                                  model's text has been parsed and before a single
 *                                  field is believed. Mirrors `ClassificationSchema` in
 *                                  `packages/shared/schemas/ai.ts`: `.strict()`, every
 *                                  field bounded, no coercion.
 *
 *   `ReplyDraftSchema`             the shape this module returns, camelCase, re-validated
 *                                  *after* the application has composed the greeting and
 *                                  the reference line onto it. `provider.ts` does the
 *                                  same thing when it appends its override note: an
 *                                  application-side edit must not be able to produce a
 *                                  value the application itself would reject.
 *
 * WHY `ReplyDraft` IS DEFINED HERE AND NOT IN `packages/shared`
 * ------------------------------------------------------------
 * It should be in `packages/shared/schemas/ai.ts`, beside `ClassificationSchema`, because
 * five lanes code against it. This lane owns `services/ai/reply/**` and nothing else, and
 * CLAUDE.md rule 2 forbids widening that. The type is *new*, not a second copy of a
 * shared one, so rule 4 is not broken — but the correct long-term home is shared, and
 * that is reported as a planning defect rather than worked around.
 *
 * Everything bounded here is bounded because the output is destined for WhatsApp and for
 * a human who has thirty seconds. A 2000-character "draft" is not a draft, it is a
 * second thing to read.
 */

import { boundedText } from '@shared/index';
import { z } from 'zod';

/** Honest signal about how well the inbound message supports a reply at all. */
export const REPLY_CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;

export type ReplyConfidence = (typeof REPLY_CONFIDENCE_LEVELS)[number];

/**
 * Longest body the model may return.
 *
 * Two or three WhatsApp sentences. The ceiling is a contract term, not a safety net: a
 * model that returns 600 characters has written an email, and the schema rejecting it is
 * the correct outcome because the retry turn will say so.
 */
export const MAX_MODEL_BODY_CHARS = 600;

/** Ceiling after the application has added a greeting line and a reference line. */
export const MAX_COMPOSED_BODY_CHARS = 800;

/** Questions a manager will actually read before replying. More than this is a list. */
export const MAX_CLARIFYING_QUESTIONS = 3;

export const MAX_QUESTION_CHARS = 160;

/**
 * The model's structured output.
 *
 * `.strict()` for the same reason `ClassificationSchema` is strict: an extra key means
 * the model is not following the contract, and silently stripping it would hide that —
 * including the case where the extra key is an injected message's idea of a new field.
 */
export const ReplyDraftModelOutputSchema = z
  .object({
    body: boundedText(3, MAX_MODEL_BODY_CHARS),
    clarifying_questions: z
      .array(boundedText(3, MAX_QUESTION_CHARS))
      .max(MAX_CLARIFYING_QUESTIONS),
    confidence: z.enum(REPLY_CONFIDENCE_LEVELS),
  })
  .strict();

export type ReplyDraftModelOutput = z.infer<typeof ReplyDraftModelOutputSchema>;

/**
 * THE FROZEN RETURN TYPE. Five other lanes code against exactly this shape.
 *
 * It carries no identifier, no recipient, no channel and no send affordance, because
 * this module does not send anything and must not look as though it could. A human reads
 * `body` in the inbox, edits it, and clicks Send — that is CLAUDE.md rule 7.
 */
export interface ReplyDraft {
  readonly body: string;
  readonly clarifyingQuestions: readonly string[];
  readonly confidence: ReplyConfidence;
}

/**
 * The returned shape, re-validated after composition.
 *
 * Bounds are looser than the model's because the application has legitimately added to
 * the body; they are still bounds, so a defect in the composer cannot emit an unbounded
 * string into a WhatsApp send path.
 */
export const ReplyDraftSchema = z
  .object({
    body: boundedText(3, MAX_COMPOSED_BODY_CHARS),
    clarifyingQuestions: z.array(boundedText(3, MAX_QUESTION_CHARS)).max(MAX_CLARIFYING_QUESTIONS),
    confidence: z.enum(REPLY_CONFIDENCE_LEVELS),
  })
  .strict();

/**
 * The call's input, validated at runtime as well as at compile time.
 *
 * `nullish` rather than `nullable` on the two optional facts: the frozen signature says
 * `string | null`, but a JavaScript caller — a webhook handler, a job runner — can and
 * will pass `undefined`, and failing a draft over that would be a silly way to lose one.
 * Unknown keys are stripped rather than rejected, for the same reason.
 */
export const DraftTenantReplyInputSchema = z.object({
  messageBody: z.string(),
  tenantName: z.string().nullish(),
  ticketReference: z.string().nullish(),
});

export type DraftTenantReplyInput = {
  readonly messageBody: string;
  readonly tenantName: string | null;
  readonly ticketReference: string | null;
};
