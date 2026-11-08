/**
 * Shell for the `(auth)` route group. Lane w1-l1.
 *
 * The four pages under it are at the slugs frozen by amendment A17 — `/sign-in`,
 * `/sign-up`, `/forgot-password`, `/accept-invitation` — because `middleware.ts` names
 * them literally in a `config.matcher`, which has to be statically analysable. A fifth
 * slug would be invisible to the gate; a renamed one would redirect every
 * unauthenticated visitor to a 404 while the gate still reported success.
 *
 * `(auth)` is a route group, so it contributes nothing to the URL. This file provides
 * only the frame: there is no session check here, because the middleware already sends a
 * signed-in visitor onward and each page states its own requirement.
 */

import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <header className="flex h-14 items-center gap-2 border-b bg-background px-4">
        <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
        <Link href="/" className="text-sm font-semibold">
          PropertySuite AI Ops
        </Link>
      </header>

      <main className="flex flex-1 items-start justify-center p-6">
        <div className="w-full max-w-md">{children}</div>
      </main>

      <footer className="border-t bg-background px-4 py-3">
        <p className="text-xs text-muted-foreground">
          Multi-tenant by construction: your organization is derived from trusted database rows
          after you sign in, never from anything your browser sends.
        </p>
      </footer>
    </div>
  );
}
