/**
 * Opaque keyset cursors for the property and unit list routes.
 *
 * `docs/parallel-execution-plan.md` §5.7 freezes cursor pagination with a default limit
 * of 25 and a maximum of 100, and `components/ui/pagination.tsx` is already built around
 * it. There is deliberately no total count and no page index: an offset over an
 * RLS-filtered result set leaks the existence of rows the caller cannot read, because
 * `?offset=50` returning nothing tells the caller there are fewer than fifty rows *for
 * them* while the manager next to them sees two hundred.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SORT KEY IS ALWAYS `(created_at, id)` AND NEVER `unit_number`
 * ---------------------------------------------------------------------------
 * A keyset predicate has to be sent to PostgREST as a filter *string*:
 *
 *     or=(created_at.lt.<value>,and(created_at.eq.<value>,id.lt.<value>))
 *
 * Commas and parentheses are structural in that grammar, so interpolating a value that
 * may contain either means writing a quoting layer and hoping it is right. `created_at`
 * is a timestamp and `id` is a UUID: both are validated on the way in by
 * `IsoDateTimeSchema` and `UuidSchema` below, and neither can contain a comma, a
 * parenthesis, a quote or a backslash. The predicate therefore cannot be broken out of,
 * by construction rather than by escaping.
 *
 * `property_units.unit_number` is free text with a `unique (property_id, unit_number)`
 * constraint, so it would be the natural sort key for a human. It is not used as the
 * keyset key, and units are listed in creation order instead. That is a deliberate,
 * documented trade: a wrong quoting layer is a filter-injection defect, and this lane
 * has no live anon key with which to prove a quoting layer correct.
 *
 * The encoded form is opaque on purpose — `components/ui/pagination.tsx` documents
 * `next_cursor` as "opaque; never parse or construct it client-side". It is base64url of
 * a tiny JSON object, not a signed token: a cursor is a *position*, not a capability.
 * Forging one cannot widen the visible set, because every query is still scoped by
 * `organization_id`, by the role scope in `features/properties/scope.ts`, by
 * `authorize()` per row, and by Row Level Security.
 */

import { ApiRouteError } from '@/lib/api/errors';
import {
  DEFAULT_PAGE_SIZE,
  IsoDateTimeSchema,
  MAX_CURSOR_LENGTH,
  UuidSchema,
  type PageInfo,
} from '@shared/index';
import { z } from 'zod';

/** The sort direction of a list route. `desc` is newest-first. */
export type SortDirection = 'asc' | 'desc';

/** A decoded cursor: the `(created_at, id)` pair of the last row of the previous page. */
export interface Cursor {
  /** `created_at` of the last row returned, as an ISO 8601 instant with an offset. */
  createdAt: string;
  /** `id` of the last row returned. Breaks ties when two rows share a timestamp. */
  id: string;
}

/**
 * The wire form. `v` is a version tag so a future change of sort key can reject old
 * cursors explicitly instead of silently paginating from the wrong place.
 */
const CursorPayloadSchema = z
  .object({
    v: z.literal(1),
    t: IsoDateTimeSchema,
    i: UuidSchema,
  })
  .strict();

/** Encodes a position. Base64url, so it is safe in a query string without escaping. */
export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({ v: 1, t: cursor.createdAt, i: cursor.id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes a cursor, or raises `VALIDATION_ERROR` (400).
 *
 * A malformed cursor is a client defect, not a server one, so it must not become a 500.
 * Nothing from the cursor reaches the log — only the stable reason token does.
 */
export function decodeCursor(raw: string): Cursor {
  if (raw.length > MAX_CURSOR_LENGTH) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      message: 'The pagination cursor is invalid.',
      logFields: { reason: 'cursor_too_long' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new ApiRouteError('VALIDATION_ERROR', {
      message: 'The pagination cursor is invalid.',
      logFields: { reason: 'cursor_not_decodable' },
    });
  }

  const result = CursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      message: 'The pagination cursor is invalid.',
      logFields: { reason: 'cursor_schema_rejected' },
    });
  }

  return { createdAt: result.data.t, id: result.data.i };
}

/**
 * The PostgREST `or=` body for "strictly after this position in the sort order".
 *
 * Both interpolated values have already passed `IsoDateTimeSchema` and `UuidSchema` in
 * `decodeCursor`, which is what makes the string safe — see the file header. Callers
 * must pass a cursor that came from `decodeCursor`, never a raw query parameter.
 */
export function keysetFilter(cursor: Cursor, direction: SortDirection): string {
  const operator = direction === 'desc' ? 'lt' : 'gt';
  return [
    `created_at.${operator}.${cursor.createdAt}`,
    `and(created_at.eq.${cursor.createdAt},id.${operator}.${cursor.id})`,
  ].join(',');
}

/**
 * A page of rows and everything the response envelope needs.
 *
 * The three fields map one-to-one onto `PageInfoSchema` in `packages/shared`, which is what
 * `PropertyListResponseSchema` and `UnitListResponseSchema` validate, per ruling A18.
 * `camelCase` in the domain, `snake_case` on the wire — `pageInfo()` below is the single
 * place that conversion happens.
 */
export interface Page<T> {
  rows: T[];
  nextCursor: string | null;
  hasMore: boolean;
  /** The page size the caller asked for, echoed back. Not the number of rows returned. */
  limit: number;
}

/**
 * Splits an over-fetched result into a page and its next cursor.
 *
 * The caller asks the database for `limit + 1` rows. If the extra row came back there
 * is more to read, and the cursor is built from the *last row of the page*, not from the
 * extra one. Asking for one more row is how `has_more` is answered without a `count`,
 * which would be both slower and a disclosure.
 */
export function toPage<T extends { id: string; created_at: string }>(
  overFetched: readonly T[],
  limit: number,
): Page<T> {
  const rows = overFetched.slice(0, limit);
  const hasMore = overFetched.length > limit;
  const last = rows[rows.length - 1];

  return {
    rows,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
    hasMore,
    limit,
  };
}

/**
 * `page_info`, as orchestrator ruling A18 requires it.
 *
 * A18 settled the two incompatible list envelopes Wave 0 shipped: `packages/shared` wins,
 * so every list route emits
 * `{ data, page_info: { next_cursor, has_more, limit } }`.
 *
 * The return type is the frozen `PageInfo` — `z.infer<typeof PageInfoSchema>` from
 * `packages/shared` — rather than a structural type written out here. That is the binding
 * A18 asks for: rename or add a field in `PageInfoSchema` and this function stops
 * compiling, instead of silently emitting an envelope the per-domain
 * `PropertyListResponseSchema` and `UnitListResponseSchema` no longer accept.
 *
 * `has_more` is carried separately from `next_cursor` even though the two are currently
 * equivalent. A18's reasoning: on an RLS-filtered list a short page is normal, so a client
 * given only a cursor cannot tell "there is no next page" from "the server failed to
 * issue one".
 */
export function pageInfo<T>(page: Page<T>): PageInfo {
  return { next_cursor: page.nextCursor, has_more: page.hasMore, limit: page.limit };
}

/** The limit to request from the database: one more than the page the client asked for. */
export function overFetchLimit(limit: number | undefined): number {
  return (limit ?? DEFAULT_PAGE_SIZE) + 1;
}
