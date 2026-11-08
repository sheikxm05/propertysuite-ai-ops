/**
 * Document text normalisation — the first thing that happens to bytes out of a PDF.
 *
 * A PDF's text layer is attacker-controlled. Anybody who can upload a tenancy contract
 * chooses every character in it, and that string then travels into a database column,
 * into a model prompt, and onto a verification screen. Three distinct hazards, handled
 * here in one place so no caller can forget one:
 *
 *  1. **Control characters.** A NUL byte breaks a Postgres `text` write, a carriage
 *     return duplicates lines, and an ANSI escape sequence can rewrite the terminal of
 *     whoever is reading the logs. All of them are stripped except tab and newline.
 *  2. **Invisible characters.** Zero-width joiners and bidirectional overrides let a
 *     document display one value to a human verifier and carry a different one into the
 *     model — a verification gate defeated without a single line of code being wrong.
 *  3. **Unbounded length.** An unbounded string is a cheap denial of service against
 *     both the database row and the model's context window.
 *
 * The cap here is the **storage** cap only. The prompt has its own, much smaller one,
 * and it is `MAX_SECTION_CHARS` in `services/ai/fence.ts` — the lane that owns the fence
 * owns what reaches the model. Defining a second prompt cap here would mean two numbers
 * governing one budget, with the smaller silently winning and the larger misleading
 * whoever read it.
 *
 * Nothing in this file logs. Document text must never reach a log line (CLAUDE.md
 * rule 8).
 */

/** Characters retained in `documents.extracted_text`. Roughly 50–60 pages of prose. */
export const MAX_STORED_TEXT_CHARS = 200_000;

/** Appended when a cap is applied, so the truncation is visible rather than silent. */
export const TRUNCATION_MARKER = '\n[truncated]';

/**
 * Code points removed outright.
 *
 * - U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+007F–U+009F — C0 and C1 controls.
 *   U+0009 (tab) and U+000A (newline) deliberately survive: they are real structure.
 * - U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 — zero-width characters and
 *   bidirectional overrides, the ones that make a rendered string differ from its bytes.
 * - U+FEFF — byte-order mark, which turns up mid-string often enough to matter.
 *
 * Written as escape sequences rather than literal characters so that this source file
 * contains no invisible or control bytes of its own.
 */
const STRIPPED =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/** Unicode spaces folded to U+0020 so that whitespace collapsing can see them. */
const EXOTIC_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g;

/**
 * Normalises raw extracted text.
 *
 * Order matters. Unicode normalisation runs first, so a decomposed sequence cannot
 * sneak a stripped code point past the filter; then the strip; then space folding; then
 * run collapsing. Collapsing before stripping would leave a run of invisible characters
 * looking like a single ordinary space.
 *
 * `NFKC` rather than `NFC` on purpose: it folds full-width digits and ligatures to
 * their ASCII equivalents, so a contract number typed in full-width characters still
 * matches the excerpt search instead of mysteriously failing to.
 */
export function normaliseDocumentText(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  let text = raw;
  try {
    text = text.normalize('NFKC');
  } catch {
    // An unpaired surrogate makes `normalize` throw. Carry on with the raw string: the
    // strip below removes the dangerous ranges either way.
  }

  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(STRIPPED, '')
      .replace(EXOTIC_SPACE, ' ')
      // Collapse runs of spaces and tabs, but never across a newline: line structure is
      // what makes a source excerpt legible to the human verifier.
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Caps `text` at `maxChars`, cutting at the last newline inside the budget where one
 * exists so the tail is a whole line rather than half a word.
 */
export function truncateForStorage(text: string, maxChars = MAX_STORED_TEXT_CHARS): TruncatedText {
  if (text.length <= maxChars) return { text, truncated: false };

  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const slice = text.slice(0, budget);
  const lastBreak = slice.lastIndexOf('\n');
  const cut = lastBreak > budget * 0.5 ? slice.slice(0, lastBreak) : slice;

  return { text: `${cut}${TRUNCATION_MARKER}`, truncated: true };
}
