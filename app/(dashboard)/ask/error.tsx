'use client';

import { RouteError } from '../_states/route-error';

/**
 * Route-level error boundary for the `/ask` segment.
 *
 * `error` is accepted because Next requires the prop, and never read — which is the
 * point: a message or a digest on screen would be an internals leak (CLAUDE.md rule 8).
 * `RouteError`'s signature has nowhere to put one even if this file wanted to.
 *
 * This boundary covers the server render of the page shell. A failure of the *question*
 * is not an error boundary case at all: it is handled inside `AskConsole`, which shows
 * the frozen envelope's message and request id in place, because a failed question must
 * not discard the question the reader just typed.
 */
export default function SegmentError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteError
      title="The question box could not be loaded"
      description="Something failed while reading the documents your role is allowed to search. Nothing was changed — this screen only reads."
      reset={reset}
    />
  );
}
