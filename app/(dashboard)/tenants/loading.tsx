import { ListSkeleton } from '../_states/route-states';

/**
 * Route-level loading state for the whole `/tenants` segment.
 *
 * Every page under it is a server component that awaits a database round trip, so
 * without this the segment renders nothing until the rows arrive. The skeleton shows
 * shape only — see `_states/route-states.tsx` for why it never shows content.
 */
export default function Loading() {
  return <ListSkeleton label="Loading tenants…" filters={true} />;
}
