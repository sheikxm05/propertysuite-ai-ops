'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Root error boundary. Shows the correlation id so a user can quote it in a report,
 * and nothing else — never a stack trace, a query, a document excerpt or any personal
 * data (CLAUDE.md rule 8).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Structured server-side logging lands in lib/observability (w0-l5 / w2-l4). Here
    // we deliberately record only the digest.
    console.error('unhandled_client_error', { digest: error.digest });
  }, [error.digest]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The request could not be completed. Nothing was changed.
      </p>
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p>
      ) : null}
      <Button onClick={reset} variant="outline">
        Try again
      </Button>
    </main>
  );
}
