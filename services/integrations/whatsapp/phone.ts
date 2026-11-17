/**
 * Phone-number normalisation, for one purpose only: deciding whether an inbound
 * WhatsApp number is *provably* a tenant we already know about.
 *
 * This is the isolation-critical half of the lane. A maintenance request arriving from
 * `971501234567` means nothing until it is attached to an organization, and attaching
 * it to the wrong one publishes one tenant's words inside another company's inbox. So
 * the rule this module exists to support is:
 *
 *     match exactly one tenant, in exactly one organization, or match nothing.
 *
 * Normalisation is where that goes wrong in practice, because `tenants.phone` is free
 * text typed by staff: `+971 50 123 4567`, `0501234567`, `00971501234567` and
 * `971-50-123-4567` are the same person and four different strings. Normalising both
 * sides to a canonical digit string is what makes the comparison meaningful — and is
 * also exactly where an over-eager implementation starts matching numbers that are not
 * the same person at all.
 *
 * Two deliberate restraints:
 *
 *  - **No fuzzy matching, no suffix matching.** Comparing the last nine digits would
 *    match a UAE number against a UK one that happens to end the same way. Only full
 *    canonical equality counts.
 *  - **One default country, and only for a form that cannot mean anything else.** A
 *    bare `0501234567` is expanded to `971501234567` because the national trunk prefix
 *    `0` plus a `5x` mobile prefix is unambiguous in the UAE, which is this
 *    application's market. A bare `501234567` is *not* expanded, because without a
 *    trunk prefix it could be a subscriber number anywhere.
 *
 * Pure; no I/O, no configuration, no logging. A phone number is personal data and never
 * reaches a log line (CLAUDE.md rule 8 — it is also absent from the logger's allowlist
 * and masked by `scrubText`, but nothing here relies on that).
 */

/** UAE country calling code. The market this build serves. */
const DEFAULT_COUNTRY_CODE = '971';

/** UAE mobile subscriber numbers are nine digits beginning `5`. */
const UAE_MOBILE = /^5\d{8}$/;

/** A plausible E.164 subscriber string: 8–15 digits, no leading zero. */
const E164_DIGITS = /^[1-9]\d{7,14}$/;

/**
 * Reduces a written number to canonical digits, or returns `null`.
 *
 * `null` means "this cannot be compared", and every caller must treat it as a non-match
 * rather than as a wildcard. Returning a lenient best guess here would push the
 * ambiguity down into the SQL query, where it would silently become a match.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  // `+`, spaces, hyphens, brackets and dots are formatting. Anything else that is not a
  // digit — a letter, an extension marker — makes the value unusable rather than
  // strippable: `0501234567 ext 12` is not a number we are entitled to guess at.
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/[^0-9+()\s.\-]/.test(trimmed)) return null;

  let digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;

  // International access prefix. `00971…` is `+971…`.
  if (digits.startsWith('00')) digits = digits.slice(2);

  // National trunk prefix followed by a UAE mobile prefix. `0501234567` → `971501234567`.
  if (digits.startsWith('0')) {
    const national = digits.slice(1);
    if (!UAE_MOBILE.test(national)) return null;
    digits = `${DEFAULT_COUNTRY_CODE}${national}`;
  }

  return E164_DIGITS.test(digits) ? digits : null;
}

/**
 * The literal strings that, once normalised, would equal this canonical number.
 *
 * `tenants.phone` is unindexed free text and PostgREST cannot apply a normalising
 * function inside a filter, so the match is done the other way round: canonicalise the
 * *inbound* number, enumerate the handful of ways a human plausibly typed it, and ask
 * the database for an exact `in (…)` match on that small set. The list is intentionally
 * short and closed — every entry is a formatting variant of the same digits, never a
 * different number.
 *
 * Rows the database returns are re-checked with `normalisePhone` before they are
 * accepted, so this list is a *prefilter*, not the decision. An entry that somehow
 * matched a different number would still be rejected by the re-check.
 */
export function phoneMatchCandidates(canonical: string): readonly string[] {
  const variants = new Set<string>([canonical, `+${canonical}`, `00${canonical}`]);

  if (canonical.startsWith(DEFAULT_COUNTRY_CODE)) {
    const national = canonical.slice(DEFAULT_COUNTRY_CODE.length);
    if (UAE_MOBILE.test(national)) {
      variants.add(`0${national}`);
      variants.add(`+${DEFAULT_COUNTRY_CODE} ${national}`);
      variants.add(`+${DEFAULT_COUNTRY_CODE}-${national}`);
      // `+971 50 123 4567` and `0 50 123 4567`, the two spaced forms staff actually type.
      const spaced = `${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`;
      variants.add(`+${DEFAULT_COUNTRY_CODE} ${spaced}`);
      variants.add(`0${spaced}`);
    }
  }

  return [...variants];
}

/** True when two written numbers denote the same subscriber. `null` never matches. */
export function samePhoneNumber(a: string | null | undefined, b: string | null | undefined) {
  const left = normalisePhone(a);
  const right = normalisePhone(b);
  return left !== null && right !== null && left === right;
}
