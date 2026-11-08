/**
 * Keyset cursor pagination for this lane's two list routes.
 *
 * §5.7 freezes "cursor pagination, default limit 25, maximum 100" and
 * `PaginationQuerySchema` already bounds the limit and the cursor length. What neither
 * freezes is the cursor's *contents*, because they are per-table. This module defines
 * them once for `tenants` and `tenancies`, both of which order by
 * `(created_at desc, id desc)`.
 *
 * WHY IT LIVES UNDER `features/tenants`
 * Lane w1-l3 owns exactly `features/tenants/**` and `features/tenancies/**`; there is no
 * third, neutral directory inside the lane. `features/tenancies` already depends on
 * `features/tenants` (a tenancy references a tenant, and `TenancyDetailSchema` embeds
 * `TenantSchema`), so placing a shared helper in the lower of the two keeps the
 * dependency pointing one way. Duplicating it into both would be two codecs to drift.
 *
 * WHY THE CURSOR IS VALIDATED AND NOT MERELY DECODED
 * A cursor is attacker-controlled input that ends up inside a PostgREST filter
 * expression. `created_at.lt."<value>"` with an unvalidated value is a filter-injection
 * primitive: a crafted value could close the quote and append `,or=(...)`, which would
 * widen the row set the query asks for. Row Level Security would still deny another
 * organization's rows, but a lane must not lean on the other layer — so both components
 * are matched against strict patterns and anything else is a 400 before it reaches a
 * query string.
 *
 * Offset pagination is not an option here: with RLS the visible row set differs per
 * caller, so an offset is not stable between requests.
 */

import { ApiRouteError } from '@/lib/api/errors';

/** The sort key. Both columns are needed: `created_at` alone is not unique. */
export interface PageCursor {
  /** `created_at`, exactly as PostgREST rendered it. */
  createdAt: string;
  /** The row's `id`, breaking ties within one timestamp. */
  id: string;
}

/**
 * `2026-11-09T08:30:00.123456+00:00`, and the handful of shapes PostgREST also emits
 * (`Z` suffix, no fractional seconds). Deliberately narrow: no quotes, no commas, no
 * parentheses, nothing that is syntax inside a PostgREST filter.
 */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest cursor payload accepted before decoding. `MAX_CURSOR_LENGTH` bounds the raw value. */
const MAX_DECODED_BYTES = 256;

/** `created_at desc, id desc` — the order both list routes use. */
export const PAGE_ORDER = [
  { column: 'created_at', ascending: false },
  { column: 'id', ascending: false },
] as const;

/** Encodes a cursor as opaque base64url. Clients must never parse it (`PageInfoSchema`). */
export function encodePageCursor(cursor: PageCursor): string {
  const payload = `${cursor.createdAt}|${cursor.id}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes and validates a client-supplied cursor.
 *
 * Throws `VALIDATION_ERROR` (400) on anything unexpected. A malformed cursor is a client
 * bug or a probe, never something to recover from by silently returning page one — that
 * would make a broken paginator look like a working one.
 */
export function decodePageCursor(raw: string): PageCursor {
  const reject = (reason: string): never => {
    throw new ApiRouteError('VALIDATION_ERROR', {
      message: 'The pagination cursor is not valid.',
      logFields: { reason },
    });
  };

  let decoded: string;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DECODED_BYTES) {
      return reject('cursor_length_rejected');
    }
    decoded = bytes.toString('utf8');
  } catch {
    return reject('cursor_not_base64');
  }

  const separator = decoded.indexOf('|');
  if (separator <= 0) return reject('cursor_shape_rejected');

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!TIMESTAMP_PATTERN.test(createdAt)) return reject('cursor_timestamp_rejected');
  if (!UUID_PATTERN.test(id)) return reject('cursor_id_rejected');

  return { createdAt, id };
}

/**
 * The PostgREST `or=` expression that resumes a descending keyset scan after `cursor`.
 *
 * `created_at.lt.X` alone would skip every row sharing the boundary timestamp;
 * `and(created_at.eq.X,id.lt.Y)` picks those up. Values are double-quoted because a
 * timestamp contains `:` and `+`, both of which are PostgREST filter syntax — and both
 * components have already been pattern-matched by `decodePageCursor`, so no quote can be
 * closed from inside a value.
 */
export function descendingKeysetFilter(cursor: PageCursor): string {
  const ts = `"${cursor.createdAt}"`;
  return `created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${cursor.id})`;
}

/** A row carrying the sort key. Both list queries select these two columns. */
export interface PageableRow {
  id: string;
  created_at: string;
}

/**
 * Splits an over-fetched result into one page plus the cursor for the next.
 *
 * The caller requests `limit + 1` rows; the extra row is the existence proof for
 * `has_more` and is not returned. The cursor is taken from the last row **of the page**,
 * so it is a position in the ordering rather than a count of rows seen.
 */
export function takePage<T extends PageableRow>(
  rows: readonly T[],
  limit: number,
): { items: T[]; nextCursor: string | null; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last ? encodePageCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}
