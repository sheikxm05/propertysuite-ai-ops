'use client';

import { RotateCw, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

/**
 * The dashboard's route-level error state — the backstop behind the per-tile boundaries
 * in `WidgetFrame`. Reaching this means the composition itself failed (the membership
 * lookup, typically), not one widget's query.
 *
 * Nothing from `error` is rendered or logged. A digest is a server-side correlation id,
 * and the message can carry internals; CLAUDE.md rule 8 says neither belongs on screen.
 * The user gets the one thing that is actually useful: a retry that re-runs the server
 * render rather than a full page reload.
 */
export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="space-y-6">
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>This dashboard could not be loaded</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>
            Something failed while resolving what your role is allowed to see. Your data was not
            changed — the dashboard only reads.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={reset}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}
