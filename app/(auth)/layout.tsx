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

/**
 * `export const dynamic = 'force-dynamic'` used to sit here. It is gone, deliberately.
 *
 * It was added to get past a build-time
 * `TypeError: Cannot read properties of undefined (reading 'name')` while prerendering
 * /sign-up, and its own comment said the cause was undiagnosed. It did not fix anything:
 * it moved a build failure to a runtime one, and /sign-up served a live HTTP 500.
 *
 * The cause is now diagnosed and fixed at the source — every form body under this group
 * is a Client Component, so no form element crosses the Flight boundary for
 * `FormControl` to clone. See `components/sign-up-form.tsx` for the full account.
 *
 * Nothing here is session-dependent: `middleware.ts` redirects a signed-in visitor away
 * before any of these pages render, so a prerendered copy is the correct artefact and
 * the gate still runs on every request. /sign-in opts itself into dynamic rendering by
 * awaiting `searchParams`; the other three prerender, which is what the build output
 * should show. Forcing the whole segment dynamic again would hide a regression of
 * exactly this bug rather than surface it.
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
