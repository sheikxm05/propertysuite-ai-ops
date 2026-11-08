import { Sidebar } from '@/components/shell/sidebar';
import { Topbar } from '@/components/shell/topbar';
import { Toaster } from '@/components/ui/toaster';

/**
 * Dashboard shell.
 *
 * ============================ SEAM FOR LANE w1-l1 ============================
 * Wave 0 cannot resolve a session: lib/auth is owned by w0-l5 and does not exist yet,
 * and this lane must compile with zero dependency on another lane's output. So the
 * shell renders in its signed-out state and every nav entry is disabled.
 *
 * w1-l1 replaces the three constants below with:
 *
 *   const membership = await resolveMembership();     // lib/auth/roles
 *   if (!membership) redirect('/sign-in');
 *
 * and passes membership.role / organization.name / profile.full_name through.
 *
 * Do NOT read the role from a cookie, header, query string or client component. It is
 * derived from trusted database rows only (CLAUDE.md rule 5). This layout is also a
 * convenience boundary, not a security one — middleware.ts (w0-l5) gates the route
 * group, every handler re-authorizes, and RLS denies independently.
 * =============================================================================
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const role: string | null = null;
  const organizationName: string | null = null;
  const displayName: string | null = null;

  return (
    <div className="flex min-h-screen">
      <Sidebar role={role} organizationName={organizationName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar role={role} displayName={displayName} />
        <main className="flex-1 p-6">{children}</main>
      </div>
      <Toaster />
    </div>
  );
}
