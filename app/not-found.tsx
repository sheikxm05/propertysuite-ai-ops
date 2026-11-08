import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * A resource the caller may not access returns 404, never 403 with detail — telling an
 * unauthorized user that a record exists is itself a disclosure. See
 * docs/api-contracts.md: "404 absent or inaccessible resource".
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This page does not exist, or you do not have access to it.
      </p>
      <Button asChild variant="outline">
        <Link href="/">Back to start</Link>
      </Button>
    </main>
  );
}
