/**
 * `/dashboard` — the authenticated landing page. Lane w1-l1.
 *
 * It composes, it does not contain. Widgets come from `widgetsForRole()` in
 * `config/dashboard.slots.ts`, which each feature lane populates by replacing exactly one
 * `features/<feature>/widget.tsx`. This page therefore needs no edit when the other five
 * lanes land, and this lane edits none of their files — mechanism 3 of
 * `docs/parallel-execution-plan.md` §0, working as designed.
 *
 * `widgetsForRole` filters on `enabled` as well as on role, so a widget whose feature has
 * not shipped yet contributes nothing rather than linking to a 404. Early in Wave 1 that
 * means this page renders one widget; by the end of it, five or six. W2-L5 later takes
 * ownership of the composition and builds the five role-specific dashboards on top.
 *
 * **Role comes from `resolveMembership()`**, through the shared server context, and is
 * passed *down* to each widget — the widget contract in `config/types.ts` gives a widget
 * `role` and nothing else, so no widget can receive a client or an organization id from
 * this page and be handed the wrong one. A widget that needs data resolves its own
 * context through the same trusted path.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { widgetsForRole } from '@/config/dashboard.slots';
import { OnboardingPanel } from '@/features/organizations/components/onboarding-panel';
import { requireContext } from '@/features/organizations/server-context';
import { MEMBER_ROLE_LABELS } from '@shared/index';

export const metadata = { title: 'Dashboard' };

/** Tailwind cannot see a computed class name, so the three spans are spelled out. */
const SPAN_CLASS: Record<1 | 2 | 3, string> = {
  1: 'lg:col-span-1',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
};

export default async function DashboardPage() {
  const { membership } = await requireContext();

  // Authenticated, member of nothing. A legitimate state — see OnboardingPanel.
  if (!membership) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome</h1>
          <p className="text-sm text-muted-foreground">
            Your account exists but does not belong to an organization yet.
          </p>
        </header>
        <OnboardingPanel />
      </div>
    );
  }

  // A disabled member keeps a session but has no access to anything. `authorize()`
  // refuses every action for a non-active membership, so every page below would be an
  // empty shell; saying so plainly is better than rendering six empty widgets.
  if (membership.status !== 'active') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your access is suspended</CardTitle>
          <CardDescription>
            Your membership of {membership.organization.name} is not active. An organization
            administrator can restore it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const widgets = widgetsForRole(membership.role);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{membership.organization.name}</h1>
        <p className="text-sm text-muted-foreground">
          Signed in as {MEMBER_ROLE_LABELS[membership.role]}. You see only what this role is
          authorized for — enforced server-side and again by row-level security.
        </p>
      </header>

      {widgets.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing to show yet</CardTitle>
            <CardDescription>
              No dashboard section is available for this role yet. Sections appear as each feature
              ships.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {widgets.map(({ key, title, span, Component }) => (
            <section key={key} className={SPAN_CLASS[span]} aria-label={title}>
              <Component role={membership.role} />
            </section>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="pt-6">
          <p className="text-xs text-muted-foreground">
            Sections are filtered by role for clarity, not for security. Every API route re-checks
            authorization from trusted rows, and PostgreSQL row-level security denies independently
            — hiding a link is never the control that protects data.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
