'use client';

import { RotateCw, TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export interface RouteErrorProps {
  /** What failed, in the reader's terms — "This ticket could not be loaded". */
  readonly title: string;
  /** One sentence of reassurance about what was and was not affected. */
  readonly description?: string;
  readonly reset: () => void;
}

/**
 * The error screen every feature segment shares.
 *
 * **Nothing from the `error` object reaches this component**, by signature: it takes a
 * `reset` callback and two strings and has no way to render a message or a digest even
 * if a caller passed one. That is deliberate — CLAUDE.md rule 8 keeps internals off the
 * screen, and a boundary that merely *chose* not to render `error.message` is one edit
 * away from doing it.
 *
 * The retry re-runs the server render rather than reloading the page, so a transient
 * database failure costs one round trip instead of the whole bundle.
 */
export function RouteError({ title, description, reset }: RouteErrorProps) {
  return (
    <Alert variant="destructive">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>
          {description ??
            'Something failed while reading the records your role is allowed to see. Nothing was changed — this screen only reads.'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={reset}>
          <RotateCw aria-hidden="true" />
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
