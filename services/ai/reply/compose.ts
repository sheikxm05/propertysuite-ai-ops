/**
 * Everything the application decides for itself, after the model has finished.
 *
 * Three jobs live here, and none of them involve a model:
 *
 *   1. **Composition.** The greeting and the ticket reference are attached here, from
 *      the trusted arguments, so they never travel to the model and cannot be
 *      hallucinated, swapped or mangled by fenced text.
 *   2. **The leak guard.** A body that names a unit, an address, an amount, a date or a
 *      time is discarded. The model does not know those things, so it guessed.
 *   3. **The confidence ceiling.** The model's own confidence is capped by how much the
 *      inbound message actually contained. Same idiom as `resolvePriority()` capping a
 *      model's priority suggestion and `requires_human_review` being server-owned: where
 *      honesty matters, the application decides and the model advises.
 *
 * Pure functions, no I/O, no clock, no database handle, nothing logged. Everything here
 * is unit-testable by inspection, which is the point — a security control nobody can
 * read is a security control nobody can check.
 */

import type { ReplyConfidence, ReplyDraft } from './schema';

/**
 * What the draft says when the model produced nothing usable.
 *
 * Deliberately content-free and deliberately *true*. It commits to nothing, names
 * nothing, and promises no timescale — the only thing it asserts is that a human has the
 * message, which is exactly what has happened by the time a manager is looking at this
 * in the inbox. A fallback that invented reassurance would be worse than no draft.
 */
export const FALLBACK_BODY = "Thanks for getting in touch - I've got your message and I'm looking into it.";

/* ------------------------------------------------------------------ the leak guard -- */

interface LeakRule {
  /** Stable id. Safe to log: it names a rule, never the text that tripped it. */
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * Specifics the model cannot possibly know and must therefore never write.
 *
 * It has been given one thing: the tenant's message. It has no unit, no address, no
 * ledger, no calendar and no rota. Any of those appearing in a draft is either a
 * hallucination or an echo of the tenant's own words, and at the point this runs the two
 * are indistinguishable, because model output carries no provenance.
 *
 * So the rule is the conservative one: if a specific appears, the body is not used. The
 * cost of a false positive is a blander draft that a manager edits; the cost of a false
 * negative is a WhatsApp message telling the wrong tenant that someone is coming to their
 * flat on Tuesday. Those are not comparable, and the guard is tuned accordingly.
 *
 * `bare_number` is the catch-all and does most of the work. A two-sentence
 * acknowledgement has no legitimate reason to contain a three-digit number; a unit
 * number, a rent figure, a year, a phone number and a reference all do.
 */
const LEAK_RULES: readonly LeakRule[] = [
  {
    id: 'money',
    pattern:
      /(?:\b(?:aed|dhs|dh|usd|eur|gbp|dirhams?)\b\s*[:.]?\s*\d|[$€£]\s*\d|\d[\d,.]*\s*(?:aed|dhs|dirhams?)\b)/i,
  },
  {
    id: 'unit_or_address',
    pattern:
      /\b(?:unit|apt|apartment|flat|villa|suite|office|building|tower|floor|block|plot|street|road|avenue)\b[\s#.:,-]*(?:no\.?\s*)?[a-z]?\d/i,
  },
  { id: 'po_box', pattern: /\bp\.?\s*o\.?\s*box\b/i },
  {
    id: 'clock_time',
    pattern: /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:1[0-2]|[1-9])\s*[ap]\.?m\.?\b/i,
  },
  { id: 'weekday', pattern: /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b/i },
  {
    id: 'calendar_date',
    pattern:
      /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b|\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  },
  {
    id: 'time_commitment',
    pattern:
      /\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening)|next\s+week|this\s+week|the\s+weekend|(?:within|in)\s+\d+\s*(?:minutes?|hours?|days?|weeks?)|\d+\s*(?:working|business)\s+days?)\b/i,
  },
  {
    id: 'contact_detail',
    pattern: /\+\d[\d\s().-]{6,}|\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i,
  },
  {
    id: 'reference_number',
    pattern: /\b(?:ref|reference|ticket|case|job|invoice|receipt)\b[\s#.:-]*(?:no\.?\s*)?\d/i,
  },
  { id: 'bare_number', pattern: /\b\d{3,}\b/ },
];

/**
 * Which rules the text trips. Returns ids only — never the matched text.
 *
 * Returning the match would be the single easiest way to walk a tenant's message past the
 * redaction allowlist, because the caller is going to log whatever this returns
 * (CLAUDE.md rule 8).
 */
export function findLeaks(text: string): readonly string[] {
  return LEAK_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

/* -------------------------------------------------------------------- composition -- */

/**
 * Removes a greeting the model emitted despite being told not to.
 *
 * Narrow on purpose. It fires only on a recognised greeting word, an optional single
 * name-shaped word, and a terminator — so "Hi Sarah, the leak..." loses its greeting and
 * "Hi - I'm looking into it" does not lose its sentence. A loose version of this regex
 * would silently eat real content, which is a worse bug than a doubled greeting.
 */
const LEADING_GREETING =
  /^\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))(?:\s+[A-Za-z'-]{1,30})?\s*[,!.]\s*/i;

export function stripLeadingGreeting(body: string): string {
  return body.replace(LEADING_GREETING, '').trim();
}

/** Name-shaped: a letter, then letters, marks, apostrophes or hyphens. No digits. */
const NAME_SHAPE = /^\p{L}[\p{L}\p{M}'-]*$/u;

/**
 * The tenant's own first name, or `null` when there is nothing safe to use.
 *
 * Their own name, from a trusted row, addressed to them. That is not "another person's
 * name" — and because it is attached here rather than passed to the model, no fenced text
 * can cause a different one to be used.
 *
 * Rejected rather than cleaned when it does not look like a name: a placeholder row
 * reading "UNKNOWN 0041" should produce no greeting at all, not "Hi UNKNOWN,".
 */
export function firstNameOf(tenantName: string | null | undefined): string | null {
  if (!tenantName) return null;
  const first = tenantName.trim().split(/\s+/)[0] ?? '';
  if (first.length < 2 || first.length > 24) return null;
  return NAME_SHAPE.test(first) ? first : null;
}

/**
 * The ticket reference, or `null` when it is not reference-shaped.
 *
 * Validated rather than escaped, because the set of legitimate shapes is small and known.
 * Anything else is dropped silently: a malformed reference in a message a tenant will
 * quote back is worse than no reference.
 */
export function sanitiseReference(reference: string | null | undefined): string | null {
  if (!reference) return null;
  const cleaned = reference.trim().replace(/^#/, '');
  return /^[A-Za-z0-9][A-Za-z0-9/_-]{1,39}$/.test(cleaned) ? cleaned : null;
}

/**
 * Builds the final body.
 *
 * Order matters and is load-bearing: the leak guard has already run on the model's text
 * by the time this is called, so the digits in a reference line cannot trip it. Running
 * the guard after composition would discard every draft that carried a reference.
 */
export function composeBody(
  modelBody: string,
  firstName: string | null,
  reference: string | null,
): string {
  const lines: string[] = [];
  if (firstName) lines.push(`Hi ${firstName},`);
  lines.push(modelBody.trim());
  if (reference) lines.push(`Ref: ${reference}`);
  return lines.join('\n');
}

/* --------------------------------------------------------------------- confidence -- */

const CONFIDENCE_ORDER: Record<ReplyConfidence, number> = { low: 0, medium: 1, high: 2 };

/** The more cautious of two signals. */
export function lowerConfidence(a: ReplyConfidence, b: ReplyConfidence): ReplyConfidence {
  return CONFIDENCE_ORDER[a] <= CONFIDENCE_ORDER[b] ? a : b;
}

/**
 * The highest confidence the inbound message can justify, whatever the model claims.
 *
 * A three-word message is `low`, because three words cannot support a confident reply no
 * matter how fluently the model answers them. This is the honesty control: a manager who
 * learns the signal is always `high` stops reading it, and at that point the field is
 * worse than absent because it looks like information.
 *
 * Word count is a crude proxy and is meant to be. It is not trying to judge the message —
 * it is refusing to let the model mark its own homework on a message that was never there.
 */
export function substanceCeiling(messageBody: string): ReplyConfidence {
  const text = messageBody.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (text.length < 12 || words < 4) return 'low';
  if (words < 10) return 'medium';
  return 'high';
}

/* ----------------------------------------------------------------------- fallback -- */

/**
 * The draft returned when there is no usable model output.
 *
 * `low` always, and never any clarifying questions: the application has nothing to ask,
 * and inventing a question here would be putting words in the manager's mouth about a
 * message the application failed to read.
 */
export function fallbackDraft(): ReplyDraft {
  return { body: FALLBACK_BODY, clarifyingQuestions: [], confidence: 'low' };
}
