import { Skeleton } from '@/components/ui/skeleton';

/**
 * The dashboard's route-level loading state.
 *
 * It mirrors the real grid — header block, then a 2/1/2/1 tile rhythm — so the page does
 * not visibly reflow when the content lands. Individual tiles have their own skeletons
 * inside `WidgetFrame`; this one covers the window before `requireContext()` has even
 * resolved which role is asking.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2 border-b pb-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {[2, 1, 2, 1, 3].map((span, index) => (
          <Skeleton
            key={index}
            className={
              span === 3
                ? 'h-40 md:col-span-2 lg:col-span-3'
                : span === 2
                  ? 'h-40 md:col-span-2 lg:col-span-2'
                  : 'h-40 lg:col-span-1'
            }
          />
        ))}
      </div>
    </div>
  );
}
