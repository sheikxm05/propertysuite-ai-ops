'use client';

import { RouteError } from '../_states/route-error';

/**
 * Route-level error boundary for the `/members` segment.
 *
 * `error` is accepted because Next requires the prop and never read, which is the
 * point: a message or a digest on screen would be an internals leak (CLAUDE.md rule 8).
 */
export default function SegmentError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="The member roster could not be loaded" reset={reset} />;
}
