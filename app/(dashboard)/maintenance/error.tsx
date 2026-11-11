'use client';

import { RouteError } from '../_states/route-error';

/**
 * Route-level error boundary for the `/maintenance` segment.
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
  return <RouteError title="The maintenance queue could not be loaded" reset={reset} />;
}
