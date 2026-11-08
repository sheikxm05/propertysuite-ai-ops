import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state for the whole `/properties` segment.
 *
 * Every page here is a server component that awaits a database round trip, so without this
 * the route group renders nothing until the data arrives. The skeleton shows the *shape*
 * of the page and no data at all — a placeholder that guessed at row contents would be
 * showing something the caller may not be entitled to see.
 */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading properties…</span>

      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>

      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-20" />
        </CardHeader>
        <CardContent className="flex gap-3">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-48" />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-6">
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
