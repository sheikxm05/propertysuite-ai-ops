'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';
import { cn } from './utils';

/**
 * CURSOR pagination, not page numbers — every list endpoint in api-contracts.md takes
 * `?cursor=&limit=` (default 25, max 100) and returns an opaque next cursor. There is
 * deliberately no total count and no page index: offset pagination over RLS-filtered
 * rows would leak the existence of rows the caller cannot read.
 */
export interface PaginationProps extends React.ComponentProps<'nav'> {
  /** Cursor for the next page, or null when this is the last page. */
  nextCursor?: string | null;
  /** Cursor for the previous page, or null when this is the first page. */
  prevCursor?: string | null;
  onNavigate: (cursor: string | null) => void;
  /** Number of rows currently shown, for the "showing N" hint. */
  count?: number;
  disabled?: boolean;
}

function Pagination({
  nextCursor,
  prevCursor,
  onNavigate,
  count,
  disabled,
  className,
  ...props
}: PaginationProps) {
  const hasPrev = Boolean(prevCursor) && !disabled;
  const hasNext = Boolean(nextCursor) && !disabled;

  if (!hasPrev && !hasNext && !count) return null;

  return (
    <nav
      role="navigation"
      aria-label="Pagination"
      className={cn('flex items-center justify-between gap-4 pt-4', className)}
      {...props}
    >
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {typeof count === 'number'
          ? `Showing ${count} ${count === 1 ? 'record' : 'records'}`
          : null}
      </p>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasPrev}
          onClick={() => onNavigate(prevCursor ?? null)}
          aria-label="Previous page"
        >
          <ChevronLeft />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => onNavigate(nextCursor ?? null)}
          aria-label="Next page"
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}

export { Pagination };
