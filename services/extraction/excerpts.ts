/**
 * Source excerpts — what makes human verification a review rather than a rubber stamp.
 *
 * A verification screen that shows only a proposed value asks the reviewer to trust the
 * model. A screen that shows the proposed value *beside the line of the document it
 * came from* asks them to read. That is the difference between a gate and a formality,
 * and it is why `docs/requirements.md` §3 says "display extracted values for human
 * verification" rather than "display extracted values".
 *
 * The second thing this module does is quieter and more useful: it reports when a
 * proposed value **cannot be found in the document at all**. A `found: false` field is
 * either a hallucination or a value the model inferred rather than read, and both are
 * things the reviewer should see before accepting. No extraction is rejected for it —
 * a date written "1 January 2026" legitimately will not match `2026-01-01` — but the
 * absence is surfaced instead of hidden.
 *
 * An excerpt is document text. It is returned to an authorized verifier, who may
 * already read the whole document, and it is **never logged** (CLAUDE.md rule 8).
 */

import type { DocumentExtraction } from '@shared/index';

/** Characters of context around a match. Enough for a contract line, not a page. */
export const EXCERPT_WINDOW_CHARS = 110;

/** Longest excerpt returned, after clipping to line boundaries. */
export const MAX_EXCERPT_CHARS = 300;

/** The fields an excerpt is computed for: the document values a human confirms. */
export const EXCERPTABLE_FIELDS = [
  'tenant_name',
  'contract_number',
  'property_address',
  'start_date',
  'end_date',
  'rent_amount',
  'currency',
] as const;

export type ExcerptableField = (typeof EXCERPTABLE_FIELDS)[number];

export interface FieldExcerpt {
  /** The surrounding document text, or `null` when the value was not located. */
  readonly excerpt: string | null;
  /** False when the proposed value does not appear in the document text. */
  readonly found: boolean;
  /** 1-based line number of the match, for "page 2, line 14"-style display. */
  readonly line: number | null;
}

export type FieldExcerpts = Partial<Record<ExcerptableField, FieldExcerpt>>;

const NOT_FOUND: FieldExcerpt = { excerpt: null, found: false, line: null };

/* ---------------------------------------------------------------- matching -- */

/**
 * Lowercases and collapses whitespace so that a value spanning a line break in the PDF
 * still matches. Punctuation is kept: dropping it would make `2026-01-01` match
 * `20260101`, which is a different number as often as it is the same one.
 */
function fold(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The strings worth looking for, in decreasing order of confidence.
 *
 * Only the *first* match wins, so a weak candidate can never override a strong one.
 * Every candidate is derived from the proposed value — none is invented — so a match
 * always means the document contains something the model plausibly read.
 */
export function candidateNeedles(field: ExcerptableField, value: string): string[] {
  const candidates = [value];

  if (field === 'rent_amount') {
    // "120000.00" is the canonical stored form; a contract says "120,000" or "120000".
    const [whole = ''] = value.split('.');
    if (whole.length > 0) {
      candidates.push(whole);
      candidates.push(whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
    }
  }

  if (field === 'start_date' || field === 'end_date') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      const [, year = '', month = '', day = ''] = match;
      for (const separator of ['/', '-', '.']) {
        candidates.push([day, month, year].join(separator));
        candidates.push([year, month, day].join(separator));
      }
      // Unpadded, which is how a human types a date into a contract template.
      candidates.push(`${Number(day)}/${Number(month)}/${year}`);
    }
  }

  if (field === 'contract_number') {
    // Contract numbers are routinely reformatted between systems.
    const compact = value.replace(/[\s/-]/g, '');
    if (compact.length >= 4 && compact !== value) candidates.push(compact);
  }

  return Array.from(new Set(candidates.filter((candidate) => candidate.trim().length >= 2)));
}

/**
 * Finds `value` in `text` and returns the line around it.
 *
 * The match runs on folded text but the excerpt is sliced from the original, so the
 * reviewer sees the document's own capitalisation and spacing rather than a normalised
 * rendering of it.
 */
export function findExcerpt(text: string, field: ExcerptableField, value: string): FieldExcerpt {
  if (text.length === 0) return NOT_FOUND;

  // A fold that changes length (collapsed whitespace) would make offsets drift, so the
  // haystack keeps its original length: every character maps to exactly one character.
  const haystack = text.toLowerCase();

  for (const needle of candidateNeedles(field, value)) {
    const folded = fold(needle);
    if (folded.length === 0) continue;

    const index = haystack.indexOf(folded);
    if (index < 0) continue;

    return {
      excerpt: sliceAround(text, index, folded.length),
      found: true,
      line: lineNumberAt(text, index),
    };
  }

  return NOT_FOUND;
}

/** Expands to a readable window, preferring line boundaries over a hard character cut. */
function sliceAround(text: string, index: number, length: number): string {
  const from = Math.max(0, index - EXCERPT_WINDOW_CHARS);
  const to = Math.min(text.length, index + length + EXCERPT_WINDOW_CHARS);

  const lineStart = text.lastIndexOf('\n', index);
  const lineEnd = text.indexOf('\n', index + length);

  const start = lineStart >= from ? lineStart + 1 : from;
  const end = lineEnd >= 0 && lineEnd <= to ? lineEnd : to;

  const slice = text.slice(start, end).trim();
  const clipped =
    slice.length > MAX_EXCERPT_CHARS ? `${slice.slice(0, MAX_EXCERPT_CHARS)}…` : slice;

  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${clipped}${suffix}`;
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index && position < text.length; position += 1) {
    if (text[position] === '\n') line += 1;
  }
  return line;
}

/* ----------------------------------------------------------------- public -- */

/**
 * Excerpts for every non-null proposed field.
 *
 * `currency` is excerpted like the rest even though a three-letter code matches almost
 * anything: `found: false` on a currency is a genuinely useful signal that the model
 * supplied AED by convention rather than by reading it.
 */
export function buildFieldExcerpts(text: string, proposed: DocumentExtraction): FieldExcerpts {
  const excerpts: FieldExcerpts = {};

  for (const field of EXCERPTABLE_FIELDS) {
    const value = proposed[field];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    excerpts[field] = findExcerpt(text, field, value);
  }

  return excerpts;
}

/** Fields whose proposed value could not be located. The reviewer's "look twice" list. */
export function unlocatedFields(excerpts: FieldExcerpts): ExcerptableField[] {
  return EXCERPTABLE_FIELDS.filter((field) => excerpts[field]?.found === false);
}
