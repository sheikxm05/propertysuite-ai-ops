/**
 * The loading and error shapes every feature segment shares.
 *
 * `_states` is an underscore folder, so it is private to the App Router and contributes
 * no route. It exists because seven segments each need a `loading.tsx` and an
 * `error.tsx`, and seven hand-written pairs is exactly how a product ends up with seven
 * slightly different spinners — one segment with a skeleton, one with nothing, one with
 * a raw error message on screen.
 *
 * Two rules are encoded here rather than left to each segment:
 *
 *  1. **A skeleton shows shape, never content.** It renders bars the size of the real
 *     header and rows, and no text from any record. A placeholder that guessed at row
 *     contents would be rendering something the caller may not be entitled to see.
 *  2. **An error screen says nothing about the error.** Not the message, not the digest.
 *     A digest is a server-side correlation id and a message can carry internals;
 *     CLAUDE.md rule 8 keeps both off the screen. What the reader gets instead is the
 *     one useful fact — a read failed, nothing was changed — and a retry that re-runs
 *     the server render.
 */

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export interface ListSkeletonProps {
  /** Announced to a screen reader while the segment is loading. */
  readonly label: string;
  /** Whether the real page carries a filter card above the table. */
  readonly filters?: boolean;
  readonly rows?: number;
}

/** The shape of a header plus a table of rows. */
export function ListSkeleton({ label, filters = false, rows = 5 }: ListSkeletonProps) {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>

      <div className="space-y-2 border-b pb-5">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      {filters ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-4 w-20" />
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Skeleton className="h-10 min-w-48 flex-1" />
            <Skeleton className="h-10 w-48" />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-3 pt-6">
          {Array.from({ length: rows }, (_, row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/** The shape of a detail record: a header, a summary block and two panels. */
export function DetailSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>

      <div className="space-y-2 border-b pb-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((tile) => (
          <Skeleton key={tile} className="h-24 w-full" />
        ))}
      </div>

      <Skeleton className="h-48 w-full" />
    </div>
  );
}
