/**
 * Opaque keyset cursors for the maintenance list routes.
 *
 * §5.7 freezes cursor pagination with a default of 25 and a maximum of 100; the bounds
 * are enforced by `PaginationQuerySchema` in `packages/shared` and are not restated
 * here. What is left to decide is the cursor's *contents*, and that decision is a
 * security one, which is why it is a module rather than three inline lines.
 *
 * Offset pagination is unusable under row-level security: the visible row set differs
 * per caller and changes between requests, so page 2 of an offset scan silently skips
 * and repeats rows. The cursor is therefore a keyset on `(created_at, id)` — the exact
 * pair the list query orders by, which makes the ordering total and the page boundary
 * stable.
 *
 * Two properties the implementation must preserve:
 *
 *  1. **It carries no authority.** A cursor is a position, never a filter and never an
 *     organization. Every scoping predicate is re-derived from the caller's trusted
 *     membership on each request (`scope.ts`), so replaying another user's cursor
 *     returns the replayer's own rows from that position and discloses nothing.
 *  2. **It is validated, not trusted.** A hostile cursor is request input: the decoded
 *     values are parsed with the shared `IsoDateTimeSchema` and `UuidSchema` before
 *     they reach a query, so a cursor cannot smuggle a PostgREST filter fragment into
 *     the `or(...)` expression the repository builds from it.
 *
 * Base64url, not base64: the value travels in a query string, and `+` would arrive as
 * a space.
 */

import { IsoDateTimeSchema, UuidSchema } from '@shared/index';

import { validationError } from '@/lib/api/errors';

/** A position in the `(created_at desc, id desc)` ordering. */
export interface TicketCursor {
  /** `maintenance_tickets.created_at` of the last row on the previous page. */
  createdAt: string;
  /** `maintenance_tickets.id` of that row, breaking ties on the timestamp. */
  id: string;
}

/** Separator. Neither an ISO timestamp nor a UUID can contain it, so the split is total. */
const SEPARATOR = '|';

export function encodeTicketCursor(cursor: TicketCursor): string {
  return toBase64Url(`${cursor.createdAt}${SEPARATOR}${cursor.id}`);
}

/**
 * Decodes and validates a cursor.
 *
 * Throws `VALIDATION_ERROR` (400) for anything that is not a cursor this application
 * produced. A malformed cursor is a bad request, not an empty page: silently returning
 * page one would make a paging bug invisible in the client and in the logs.
 */
export function decodeTicketCursor(raw: string): TicketCursor {
  const decoded = fromBase64Url(raw);
  if (decoded === null) throw cursorRejected('cursor_not_base64url');

  const separatorAt = decoded.indexOf(SEPARATOR);
  if (separatorAt <= 0) throw cursorRejected('cursor_shape_invalid');

  const createdAt = IsoDateTimeSchema.safeParse(decoded.slice(0, separatorAt));
  if (!createdAt.success) throw cursorRejected('cursor_timestamp_invalid');

  const id = UuidSchema.safeParse(decoded.slice(separatorAt + SEPARATOR.length));
  if (!id.success) throw cursorRejected('cursor_id_invalid');

  return { createdAt: createdAt.data, id: id.data };
}

/**
 * The cursor for the row after `items`, or `null` on the last page.
 *
 * `hasMore` comes from the repository fetching `limit + 1` rows, so "is there another
 * page" is answered by the database rather than guessed from a full page.
 */
export function nextCursorFor(
  items: readonly { created_at: string; id: string }[],
  hasMore: boolean,
): string | null {
  if (!hasMore) return null;
  const last = items[items.length - 1];
  if (!last) return null;
  return encodeTicketCursor({ createdAt: last.created_at, id: last.id });
}

/* ---------------------------------------------------------------- internals -- */

function cursorRejected(reason: string) {
  return validationError({
    message: 'The pagination cursor is not valid.',
    logFields: { reason },
  });
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** `null` rather than a throw, so the caller raises one consistent error shape. */
function fromBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const text = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
