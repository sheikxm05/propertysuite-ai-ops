/**
 * Keyset cursor for the documents list.
 *
 * §5.7 freezes cursor pagination with a default of 25 and a maximum of 100, and
 * `PaginationQuerySchema` in `packages/shared` already enforces both. What it does not
 * define is the cursor's contents, because that is per-resource: the cursor has to name
 * the sort key, and this resource is ordered by `(created_at desc, id desc)` to match
 * `idx_documents_org on documents(organization_id, created_at desc)`.
 *
 * Keyset rather than `OFFSET`. An offset page re-reads and discards every preceding row
 * — so page 40 costs forty times page 1 — and it silently skips a row when something is
 * inserted between two requests, which on a documents list means an uploaded contract
 * that never appears. A keyset cursor is stable under insertion and costs the same on
 * every page.
 *
 * The cursor is opaque to the client and is treated as hostile on the way back in. It
 * carries no organization id and no filter: everything that decides *which* rows a
 * caller may see comes from the resolved membership and from RLS, so a forged cursor can
 * reorder a caller's own page and nothing else. Decoding is total — a malformed cursor
 * yields `null` and the caller gets the first page rather than a 500.
 */

/** `(created_at, id)` of the last row on the previous page. */
export interface DocumentCursor {
  readonly createdAt: string;
  readonly id: string;
}

const SEPARATOR = '|';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeDocumentCursor(cursor: DocumentCursor): string {
  return toBase64Url(`${cursor.createdAt}${SEPARATOR}${cursor.id}`);
}

/**
 * Decodes a cursor, or returns `null`.
 *
 * Both halves are validated: the timestamp has to parse as a date and the id has to
 * look like a UUID. Without the second check a cursor could smuggle arbitrary text into
 * a PostgREST filter value.
 */
export function decodeDocumentCursor(raw: string | undefined | null): DocumentCursor | null {
  if (!raw) return null;

  let decoded: string;
  try {
    decoded = fromBase64Url(raw);
  } catch {
    return null;
  }

  const separator = decoded.lastIndexOf(SEPARATOR);
  if (separator <= 0) return null;

  const createdAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);

  if (!UUID.test(id)) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;

  return { createdAt, id };
}

/* ----------------------------------------------------------------- base64 -- */

function toBase64Url(value: string): string {
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  // Reject anything outside the base64url alphabet before decoding. `Buffer.from` is
  // lenient and would happily ignore stray characters, producing a cursor that decodes
  // to something the caller did not send.
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid cursor encoding');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}
