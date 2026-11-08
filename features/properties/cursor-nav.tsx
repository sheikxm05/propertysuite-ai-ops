'use client';

/**
 * Cursor navigation for the property and unit lists.
 *
 * Wraps `components/ui/pagination.tsx`, which is already cursor-based and already refuses
 * to render a page index — §5.7 freezes cursor pagination and `docs/api-contracts.md`
 * specifies `?cursor=&limit=` with no total count, because an offset over an RLS-filtered
 * result set leaks the existence of rows the caller cannot read.
 *
 * "Previous" needs somewhere to come from, since a forward-only cursor has no inverse.
 * The visited cursors are kept in component state and popped on the way back. Two
 * consequences, both deliberate:
 *
 *  - a full page reload starts the trail again, so "Previous" is disabled on a
 *    deep-linked page. The alternative — encoding the trail in the URL — would make a
 *    shareable link grow without bound and would put a list of positions in the browser
 *    history for no benefit.
 *  - the cursor is a *position*, not a capability. Replaying or forging one cannot widen
 *    the visible set: the server still scopes every statement by `organization_id` and by
 *    role, and still puts every row through `authorize()`.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Pagination } from '@/components/ui/pagination';

/**
 * Stands in for "the first page" inside the trail. `Pagination` enables "Previous" on any
 * truthy cursor, and the first page's cursor genuinely is "no cursor at all", so `null`
 * cannot be stored in the trail without disabling the control that pops it.
 */
const FIRST_PAGE = '__first__';

export interface CursorNavProps {
  /** The query parameter this list paginates on. `cursor` for properties. */
  param: string;
  /** From the API's `next_cursor`. `null` on the last page. */
  nextCursor: string | null;
  /** Rows currently shown, for the "showing N records" hint. */
  count: number;
}

export function CursorNav({ param, nextCursor, count }: CursorNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current = searchParams.get(param);

  const [trail, setTrail] = React.useState<string[]>([]);

  const previous = trail.length > 0 ? (trail[trail.length - 1] ?? FIRST_PAGE) : null;

  function go(cursor: string | null) {
    const next = new URLSearchParams(searchParams.toString());

    if (cursor === null || cursor === FIRST_PAGE) next.delete(param);
    else next.set(param, cursor);

    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <Pagination
      count={count}
      nextCursor={nextCursor}
      prevCursor={previous}
      onNavigate={(cursor) => {
        if (cursor === nextCursor && cursor !== null) {
          // Forward: remember where we were so "Previous" can return to it.
          setTrail((t) => [...t, current ?? FIRST_PAGE]);
          go(cursor);
          return;
        }
        // Backward.
        setTrail((t) => t.slice(0, -1));
        go(cursor);
      }}
    />
  );
}
