'use client';

import { RouteError } from '../_states/route-error';

/**
 * Route-level error boundary for the `/inbox` segment.
 *
 * `error` is accepted because Next requires the prop, and never read — which is the
 * point. A message or a digest on screen would be an internals leak (CLAUDE.md rule 8),
 * and on this segment the internals in question are message bodies.
 */
export default function SegmentError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RouteError title="The inbox could not be loaded" reset={reset} />;
}
