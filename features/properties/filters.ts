/**
 * The free-text filter on `GET /api/v1/properties?q=`.
 *
 * `ListPropertiesQuerySchema` (frozen, `@shared/index`) accepts `q` as bounded text and
 * describes it as "a free-text filter on name and address". Implementing it means
 * putting caller-supplied text into a PostgREST filter expression:
 *
 *     or=(name.ilike.*term*,address_line.ilike.*term*)
 *
 * In that grammar `,` and `(` `)` are structural, `*` and `%` are `ILIKE` wildcards, and
 * `_` is the single-character wildcard. A term carrying any of them either breaks the
 * expression or quietly changes which rows match. Neither is a cross-organization leak —
 * the query is still `.eq('organization_id', …)`, still scoped by role, still filtered by
 * RLS, and every returned row is still put through `authorize()` — but a filter a caller
 * can restructure is a filter whose behaviour is not the behaviour under test.
 *
 * So the term is reduced to a conservative allowlist rather than escaped. A search box
 * over Dubai property names and street addresses needs letters, digits, spaces, hyphens,
 * apostrophes and ampersands; it does not need parentheses or wildcards. Reducing rather
 * than escaping means there is no escaping layer to get wrong, and the worst outcome of a
 * hostile term is a search that matches nothing.
 */

/** Longest term forwarded to the database. `ListPropertiesQuerySchema` bounds `q` at 120. */
export const MAX_SEARCH_TERM_LENGTH = 120;

/**
 * Characters kept. Everything else — including `%`, `_`, `*`, `,`, `(`, `)`, `"`, `\`
 * and `.` — is dropped, so the term cannot carry a wildcard or restructure the filter.
 *
 * `\p{L}` and `\p{N}` rather than `a-z0-9`: "Burj Khalifa" and an Arabic building name
 * are both legitimate searches, and an allowlist that silently excluded non-Latin script
 * would be a correctness bug dressed up as a security control.
 */
const ALLOWED_SEARCH_CHARACTERS = /[^\p{L}\p{N} \-'&]/gu;

/**
 * Normalises a search term, or returns `null` when nothing usable survives.
 *
 * `null` means "apply no filter", which is the same behaviour as an absent `q`. It
 * deliberately does not mean "match nothing": a caller who typed only punctuation gets
 * the unfiltered list they would have got by typing nothing, which is less surprising
 * than an empty result they cannot explain.
 */
export function sanitizeSearchTerm(raw: string | undefined | null): string | null {
  if (!raw) return null;

  const cleaned = raw
    .replace(ALLOWED_SEARCH_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_TERM_LENGTH);

  return cleaned.length === 0 ? null : cleaned;
}

/**
 * The PostgREST `or=` body for "name or address contains this term".
 *
 * `term` must already have passed `sanitizeSearchTerm`, which is what guarantees it
 * contains no structural character. `*` is PostgREST's `ILIKE` wildcard.
 */
export function searchFilter(term: string): string {
  return [`name.ilike.*${term}*`, `address_line.ilike.*${term}*`].join(',');
}
