/**
 * `/dashboard` — five role dashboards from one composition. Lane w2-l5.
 *
 * It composes, it does not contain. Widgets come from `widgetsForRole()` in
 * `config/dashboard.slots.ts`, which each feature lane populates by replacing exactly one
 * `features/<feature>/widget.tsx`. This page therefore needs no edit when a feature
 * changes, and this lane edits none of their files — mechanism 3 of
 * `docs/parallel-execution-plan.md` §0, working as designed.
 *
 * WHY THERE IS ONE FILE AND NOT FIVE
 * ----------------------------------
 * The exit gate asks for five role-specific dashboards. Five route files would mean five
 * places to forget a state, and a sixth role later would mean a sixth file. Instead the
 * role selects the content: `widgetsForRole()` picks the tiles, `dashboardIntroFor()`
 * picks the framing, and the five dashboards are five different renderings of the same
 * composition. An admin sees members, portfolio, tenancies, maintenance and pending
 * verifications; a tenant sees their tenancy, their tickets and a box to report a new
 * issue; a provider sees their assigned queue and nothing else.
 *
 * **Role comes from `resolveMembership()`**, through the shared server context, and is
 * passed *down* to each widget — the widget contract in `config/types.ts` gives a widget
 * `role` and nothing else, so no widget can receive a client or an organization id from
 * this page and be handed the wrong one. A widget that needs data resolves its own
 * context through the same trusted path, and RLS denies independently of all of it.
 *
 * Filtering here is presentation. It is never the control that protects data.
 */

import { ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { dashboardIntroFor, widgetChrome, widgetsForRole } from '@/config/dashboard.slots';
import { OnboardingPanel } from '@/features/organizations/components/onboarding-panel';
import { requireContext } from '@/features/organizations/server-context';
import { MEMBER_ROLE_LABELS } from '@shared/index';

import { WidgetFrame } from './widget-frame';

export const metadata = { title: 'Dashboard' };

/**
 * Tailwind cannot see a computed class name, so the three spans are spelled out.
 * A two-column widget fills the row on tablets rather than sitting in half of it.
 */
const SPAN_CLASS: Record<1 | 2 | 3, string> = {
  1: 'lg:col-span-1',
  2: 'md:col-span-2 lg:col-span-2',
  3: 'md:col-span-2 lg:col-span-3',
};

export default async function DashboardPage() {
  const { membership } = await requireContext();

  // Authenticated, member of nothing. A legitimate state — see OnboardingPanel.
  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Welcome"
          description="Your account exists but does not belong to an organization yet. Create one, or redeem the invitation you were sent."
        />
        <OnboardingPanel />
      </div>
    );
  }

  // A disabled member keeps a session but has no access to anything. `authorize()`
  // refuses every action for a non-active membership, so every page below would be an
  // empty shell; saying so plainly is better than rendering six empty widgets.
  if (membership.status !== 'active') {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow={membership.organization.name}
          title="Your access is suspended"
          description="An organization administrator can restore it."
        />
        <Alert variant="warning">
          <AlertTitle>Membership is not active</AlertTitle>
          <AlertDescription>
            Your membership of {membership.organization.name} is {membership.status}. Every request
            you make is refused server-side and again by row-level security until it is restored —
            there is nothing to show here in the meantime.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const widgets = widgetsForRole(membership.role);
  const intro = dashboardIntroFor(membership.role);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={membership.organization.name}
        title={intro.headline}
        description={intro.summary}
        actions={
          <Badge variant="secondary" className="gap-1.5 py-1">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            {MEMBER_ROLE_LABELS[membership.role]}
          </Badge>
        }
      />

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
        <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {widgets.map((widget) => (
            <section key={widget.key} className={SPAN_CLASS[widget.span]} aria-label={widget.title}>
              <WidgetFrame
                title={widget.title}
                description={widget.description}
                chrome={widgetChrome(widget)}
              >
                <widget.Component role={membership.role} />
              </WidgetFrame>
            </section>
          ))}
        </div>
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Sections are filtered by role for clarity, not for security. Every API route re-checks
        authorization from trusted rows, and PostgreSQL row-level security denies independently —
        hiding a link is never the control that protects data.
      </p>
    </div>
  );
}
