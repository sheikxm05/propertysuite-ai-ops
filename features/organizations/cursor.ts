/**
 * Opaque keyset cursors. Lane w1-l1.
 *
 * `packages/shared/constants/pagination.ts` froze cursor pagination and said why:
 * with Row Level Security the visible row set differs per caller, so an offset is not
 * stable across requests. A cursor therefore has to name a *position* — the
 * `(created_at, id)` pair of the last row returned — rather than a count of rows
 * skipped.
 *
 * The encoding is base64url of `createdAt|id`. It is deliberately **opaque, not
 * secret**: it carries only values the caller was just shown, so there is nothing in it
 * to protect. Opacity is an API-stability property. A client that parsed it would couple
 * itself to the sort key, and `PageInfoSchema` in `packages/shared` says as much:
 * "Pass it back as `?cursor=`; never parse or construct it client-side."
 *
 * Decoding is total and never throws: an unparseable cursor yields `null`, which means
 * "start from the beginning". A tampered cursor can therefore only ever cost the caller
 * a page of their own data — it can never widen a query, because the organization filter
 * and the RLS predicate are applied independently of it.
 */

/** A decoded cursor: the sort key of the last row of the previous page. */
export interface PageCursor {
  /** `created_at` of the last row, as the ISO string Postgres returned. */
  createdAt: string;
  /** `id` of the last row, breaking ties when two rows share a timestamp. */
  id: string;
}

const SEPARATOR = '|';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes a position. The result is safe in a query string without escaping. */
export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(`${cursor.createdAt}${SEPARATOR}${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or returns `null` for anything that is not one.
 *
 * Both halves are validated before use. The id must be a UUID and the timestamp must
 * parse as a date, because both are interpolated into a PostgREST filter expression: an
 * unvalidated value there is a filter-injection surface, not merely a bad page.
 */
export function decodeCursor(encoded: string | null | undefined): PageCursor | null {
  if (!encoded) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.lastIndexOf(SEPARATOR);
  if (separator <= 0) return null;

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!UUID_PATTERN.test(id)) return null;
  if (!isSafeTimestamp(createdAt)) return null;

  return { createdAt, id };
}

/**
 * Is this a timestamp that is safe to interpolate into a PostgREST filter?
 *
 * Two separate questions, both of which must be yes: it parses as a real instant, and it
 * contains no character that could terminate or extend a filter expression. The
 * character allowlist is the load-bearing half — `Date.parse` is far more permissive
 * than the format Postgres emits, so parsing alone would not keep a comma or a
 * parenthesis out of the predicate.
 */
function isSafeTimestamp(value: string): boolean {
  if (value.length === 0 || value.length > 40) return false;
  if (!/^[0-9T:.+\-Z ]+$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}
