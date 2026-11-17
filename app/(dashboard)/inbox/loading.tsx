import { ListSkeleton } from '../_states/route-states';

/**
 * Route-level loading state for the whole `/inbox` segment.
 *
 * Every page under it is a server component that awaits a database round trip, so
 * without this the segment renders nothing until the rows arrive. The skeleton shows
 * shape only — never a guess at a row's contents, which would be rendering something the
 * caller may not be entitled to see.
 */
export default function Loading() {
  return <ListSkeleton label="Loading the inbound queue…" filters={true} />;
}
