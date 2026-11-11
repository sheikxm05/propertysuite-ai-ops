/**
 * Dashboard shell. Lane w1-l1 — this file replaces the `SEAM FOR LANE w1-l1` block
 * w0-l1 left here.
 *
 * Three facts about this layout, in the order they matter:
 *
 *  1. **Membership is resolved from trusted rows.** `requireContext()` →
 *     `resolveMembership()` reads `organization_members` through the caller-scoped
 *     client, so RLS applies to membership resolution itself. The role is never read
 *     from a cookie, a header, a query string or a client component (CLAUDE.md rule 5).
 *
 *  2. **A missing membership is not an error.** An authenticated user who belongs to
 *     nothing yet — signed up, invitation not yet redeemed — renders the shell in its
 *     signed-out state and lands on the dashboard's onboarding panel. Redirecting them
 *     out of the group instead would loop, because the pages that *fix* the state
 *     (`/organization`, `/organization/accept`) are inside the group and need a session
 *     to work.
 *
 *  3. **This is a convenience boundary, not a security one.** `middleware.ts` gates the
 *     route group, every API route re-authorizes through `withApiHandler`, and Postgres
 *     RLS denies independently. If this layout were deleted, no data would become
 *     reachable — which is the property that makes it safe for the sidebar to filter
 *     links by role at all.
 */

import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { Toaster } from '@/components/ui/toaster';
import { requireContext } from '@/features/organizations/server-context';
import { SignOutButton } from '@/features/organizations/components/sign-out-button';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { session, membership } = await requireContext();

  const role = membership?.role ?? null;
  const organizationName = membership?.organization.name ?? null;
  // The profile's own name, which the caller may always read. Falls back to the verified
  // session email when the profile row has not been populated yet.
  const displayName = membership?.profile.fullName ?? session.email ?? null;

  return (
    <div className="flex min-h-screen">
      <Sidebar role={role} organizationName={organizationName} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          Sign-out is passed in rather than owned by the shell: signing out is a server
          action in this feature's lane, and the top bar must not import from `features/`.
          `accountActions` is the slot that resolves that — the stray sign-out strip that
          used to sit under the top bar is gone.
        */}
        <Topbar
          role={role}
          displayName={displayName}
          email={session.email}
          organizationName={organizationName}
          accountActions={<SignOutButton />}
        />
        <main className="page-gutter flex-1 py-6">{children}</main>
      </div>
      <Toaster />
    </div>
  );
}
