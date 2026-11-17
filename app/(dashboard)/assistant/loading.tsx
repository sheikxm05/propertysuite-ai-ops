import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading state for `/assistant`.
 *
 * The page awaits a membership round trip before it can decide whether to draw an
 * Approve button, so without this the segment renders nothing until that returns.
 *
 * Shape only, never content — the rule `app/(dashboard)/_states/route-states.tsx`
 * encodes. The generic `ListSkeleton` is not used here because this screen is not a
 * list: a header, an explanatory card and a composer is a different silhouette, and a
 * skeleton that settles into a different layout than it promised is worse than none.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the assistant…</span>

      <div className="space-y-2 border-b pb-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-3">
          {[0, 1, 2].map((column) => (
            <Skeleton key={column} className="h-28 w-full" />
          ))}
        </CardContent>
      </Card>

      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
