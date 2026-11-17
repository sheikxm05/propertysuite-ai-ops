'use client';

import { RouteError } from '../_states/route-error';

/**
 * Route-level error boundary for `/assistant`.
 *
 * `error` is accepted because Next requires the prop, and never read, which is the
 * point: a message or a digest on screen would be an internals leak (CLAUDE.md rule 8).
 *
 * The reassurance is worth saying explicitly on this screen in particular. The only
 * thing that renders here before a user types is a membership lookup; a failure means a
 * read failed, and no proposal was approved, rejected or executed as a side effect of it.
 */
export default function SegmentError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      title="The assistant could not be loaded"
      description="Your membership could not be read, so this screen does not yet know what you are allowed to approve. Nothing was proposed, approved or changed."
      reset={reset}
    />
  );
}
