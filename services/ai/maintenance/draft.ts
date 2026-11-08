/**
 * Draft assembly — turning a validated classification into something a human reviews.
 *
 * Three jobs, none of which may be left to the model:
 *
 *  1. **The clarification overlay.** When the *server* could not resolve which unit the
 *     message is about, the draft must say so regardless of how confident the model was.
 *     The model does not know how many tenancies the caller holds, so it cannot be the
 *     authority on that, and a confident-but-unitless draft would be a confirm button
 *     with nothing behind it.
 *  2. **The clarification question itself**, when the ambiguity is about the unit. A
 *     required UX step must not depend on a generation.
 *  3. **A suggested, editable title and description.** `ConfirmTicketSchema` carries
 *     `title` and `description` separately from the draft precisely so the human can
 *     change them before committing. Suggesting them here keeps the suggestion derived
 *     from already-validated text rather than from a second model call — a second call
 *     would be a second chance for injected text to shape the stored record.
 *
 * Everything returned by the overlay is re-parsed through `ClassificationSchema`, so it
 * cannot produce a draft the rest of the system would reject: a 21st
 * `missing_information` entry or an over-long question fails here, not at the confirm
 * boundary.
 *
 * **This module is client-safe on purpose.** It imports `packages/shared` and nothing
 * else at runtime — no Supabase client, no `lib/**` server module — so the review form in
 * `features/ai-intake/**` can compute the same suggestions the server would, from the
 * same code, without the response envelope having to grow fields outside the frozen
 * `ClassifyResponseSchema`.
 */

import {
  ClassificationSchema,
  DescriptionSchema,
  TitleSchema,
  type Classification,
} from '@shared/index';

import type { UnitResolution } from '../providers/types';

/** Marker added to `missing_information` when the unit could not be resolved. */
export const MISSING_UNIT_MARKER = 'Which unit this report is about';

/**
 * The server's own clarification questions, by unresolved state.
 *
 * `ambiguous` is actionable by the tenant; `none` is not, so it points at a human. Both
 * are fixed strings: a question the application requires an answer to must read the same
 * way every time.
 */
export const UNIT_CLARIFICATION_QUESTIONS: Readonly<Record<'ambiguous' | 'none', string>> =
  Object.freeze({
    ambiguous:
      'Which of your units is this about? Please choose the unit before submitting the report.',
    none: 'We could not find an active tenancy for your account. Please contact your property manager.',
  });

/** The only part of the unit context this module needs. Keeps it free of server imports. */
export interface UnitResolutionView {
  readonly resolution: UnitResolution;
}

/**
 * Applies the server's unit knowledge over the model's draft.
 *
 * Precedence is the server's: when the unit is unresolved the server's question replaces
 * the model's, because "which of your units is this about" is answerable and actionable,
 * whereas the model's question was formed without knowing a tenancy count.
 *
 * When the unit *is* resolved, the model's own clarification stands untouched — it may
 * legitimately still need to know whether the leak is hot or cold water.
 */
export function applyUnitClarification(
  classification: Classification,
  unit: UnitResolutionView,
): Classification {
  if (unit.resolution === 'resolved') return classification;

  const missing = dedupe([...classification.missing_information, MISSING_UNIT_MARKER]).slice(0, 20);

  return ClassificationSchema.parse({
    ...classification,
    requires_clarification: true,
    clarification_question: UNIT_CLARIFICATION_QUESTIONS[unit.resolution],
    missing_information: missing,
  });
}

/**
 * A suggested ticket title: the first sentence of the summary, bounded to `TitleSchema`.
 *
 * Returns `null` rather than a truncated fragment when nothing of acceptable length can
 * be cut, so the form shows an empty required field instead of a bad default the human
 * might accept without reading.
 */
export function suggestTitle(classification: Classification): string | null {
  const firstSentence = classification.summary.split(/(?<=[.!?])\s/)[0] ?? classification.summary;
  const candidate = firstSentence.trim().replace(/[.\s]+$/, '');
  const bounded = candidate.length > 200 ? candidate.slice(0, 197).trimEnd() : candidate;
  const result = TitleSchema.safeParse(bounded);
  return result.success ? result.data : null;
}

/**
 * A suggested ticket description.
 *
 * `DescriptionSchema` demands at least 10 characters, which a terse summary can miss, so
 * the symptoms are appended when present. `null` when the result is still too short: the
 * human then writes it, which is the correct outcome for a message that said almost
 * nothing.
 */
export function suggestDescription(classification: Classification): string | null {
  const parts = [classification.summary.trim()];
  if (classification.reported_symptoms.length > 0) {
    parts.push(`Reported: ${classification.reported_symptoms.join('; ')}.`);
  }
  const result = DescriptionSchema.safeParse(parts.join(' '));
  return result.success ? result.data : null;
}

function dedupe(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}
