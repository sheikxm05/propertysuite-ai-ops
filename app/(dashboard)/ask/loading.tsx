import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Route-level loading state for `/ask`.
 *
 * The page is a server component that awaits one database round trip for the scope
 * picker, so without this the segment renders nothing until it returns. It is a local
 * skeleton rather than `_states/route-states.tsx`'s `ListSkeleton` because this segment
 * is not a list: a table skeleton followed by a question box is a layout shift, and the
 * point of a skeleton is to not have one.
 *
 * Shape only, never content — the same rule the shared skeletons follow.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the question box…</span>

      <div className="space-y-2 border-b pb-5">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <Card>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-24" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
