/**
 * The three things every data function in lane w1-l3 needs, and nothing else.
 *
 * Shared by `features/tenants` and `features/tenancies` so that a service function has
 * one signature whether it is called from a route handler or from a dashboard server
 * component. See the placement note in `cursor.ts` for why a module used by both
 * features lives under the lower of the two.
 *
 * Note what is **absent**: there is no `organizationId` parameter anywhere in this lane.
 * The organization is read off `membership`, which `resolveMembership()` derived from
 * trusted database rows. A service function that accepted one would be a hole in
 * CLAUDE.md rule 5 wide enough to drive a cross-organization read through, so the type
 * system does not offer the option.
 *
 * `supabase` is always the caller-scoped client with Row Level Security in force. The
 * service-role client appears nowhere in this lane: there is no operation in tenants or
 * tenancies that a correctly authorized staff member cannot perform as themselves.
 */

import type { Membership } from '@/lib/auth/roles';
import type { Logger } from '@/lib/observability/logger';
import type { AppSupabaseClient } from '@/lib/supabase/types';

export interface DataContext {
  /** Caller-scoped. RLS applies. */
  supabase: AppSupabaseClient;
  /** From `resolveMembership()`. The only source of the caller's organization. */
  membership: Membership;
  logger: Logger;
}

/** A cursor page of serialised rows, mirroring `PageInfoSchema` from `packages/shared`. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/**
 * Turns an internal `Page<T>` into the frozen list-response body.
 *
 * Amendment **A18**: the list envelope is
 * `{ data, page_info: { next_cursor, has_more, limit } }`, built from
 * `listResponseSchema()` in `packages/shared`. `lib/api/responses.ts::paginated()`
 * emitted `{ data, next_cursor }` and lost; the contract package is the source and the
 * helper is an implementation of it.
 *
 * `has_more` is the reason the ruling went that way and the reason this function exists
 * rather than each route assembling the object inline: on a Row-Level-Security-filtered
 * list a short page is *normal*, because the row set differs per caller. Without
 * `has_more` a client cannot distinguish "there is no next page" from "the server failed
 * to issue a cursor", and in this application the first of those is the common case.
 *
 * The result is handed to the per-domain `*ListResponseSchema` by the route, which is
 * `.strict()` at both levels — so an extra key is a thrown error rather than an
 * undocumented field on the wire.
 */
export function pageBody<T>(page: Page<T>): {
  data: T[];
  page_info: { next_cursor: string | null; has_more: boolean; limit: number };
} {
  return {
    data: page.items,
    page_info: {
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
      limit: page.limit,
    },
  };
}

/**
 * Strips a free-text search term down to characters that are inert in both a SQL `LIKE`
 * pattern and a PostgREST filter expression.
 *
 * Two distinct risks, one answer. `%` and `_` are `LIKE` wildcards, so an unescaped
 * search term can turn an indexed prefix match into a full scan. `,`, `(`, `)` and `"`
 * are PostgREST filter syntax, so an unfiltered term is a filter-injection primitive in
 * the same way an unvalidated cursor is (see `cursor.ts`). An allowlist of letters,
 * digits, spaces and the three punctuation marks that occur in human names answers both
 * and cannot be out-thought by a cleverer escape.
 */
export function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} '\-.]/gu, '').trim();
}
