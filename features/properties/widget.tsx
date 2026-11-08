import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DashboardWidget, DashboardWidgetProps } from '@/config/types';
import { getSession } from '@/lib/auth/session';
import { resolveMembership } from '@/lib/auth/roles';
import { createServerClient } from '@/lib/supabase/server';
import { DEFAULT_LOCALE } from '@shared/index';

import { portfolioCounts } from './service';

/**
 * The portfolio-count dashboard widget. Lane w1-l2 — this file replaces the w0-l1 stub,
 * which rendered `null` with `enabled: false`.
 *
 * It is an **async server component**. `ComponentType<DashboardWidgetProps>` accepts one:
 * React 19's `ReactNode` includes `Promise<AwaitedReactNode>`, so an async function
 * component satisfies `FunctionComponent`. The alternative — a client component fetching
 * `/api/v1/properties` and counting the first page — would be wrong as well as slower: a
 * count taken from one page of at most 100 rows is not a portfolio count.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RESOLVES ITS OWN MEMBERSHIP AND IGNORES `props.role`
 * ---------------------------------------------------------------------------
 * `DashboardWidgetProps` carries `role` so a widget can vary its presentation. It is not
 * used as an input to any query here. Every number below is scoped by the membership this
 * component resolves for itself through `resolveMembership`, from `organization_members`
 * rows read with the caller's own client — so the counts are the caller's own visible set
 * whatever the shell passed down (CLAUDE.md rule 5). A widget that trusted a prop for
 * scope would be one prop away from counting another organization's portfolio.
 *
 * The counts are role-correct for free: `portfolioCounts` goes through
 * `resolveVisibilityScope`, so a manager sees the organization's portfolio, an owner sees
 * only properties recorded against their membership, and a tenant sees only what their
 * active tenancy reaches.
 */
async function PortfolioWidget(_props: DashboardWidgetProps) {
  const supabase = await createServerClient();
  const session = await getSession(supabase);
  if (!session) return null;

  const membership = await resolveMembership(session.userId, supabase);
  if (!membership) return null;

  const counts = await portfolioCounts(supabase, membership);
  const format = new Intl.NumberFormat(DEFAULT_LOCALE);
  const occupancy =
    counts.units > 0 ? Math.round((counts.occupiedUnits / counts.units) * 100) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portfolio</CardTitle>
        <CardDescription>
          {counts.archivedProperties > 0
            ? `${format.format(counts.archivedProperties)} archived, not counted below.`
            : 'Active properties and their units.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-4">
          <Metric label="Properties" value={format.format(counts.properties)} />
          <Metric label="Units" value={format.format(counts.units)} />
          <Metric label="Occupied" value={format.format(counts.occupiedUnits)} />
          <Metric label="Available" value={format.format(counts.availableUnits)} />
        </dl>

        {occupancy === null ? null : (
          <p className="text-sm text-muted-foreground">{occupancy}% of visible units occupied.</p>
        )}

        <Link href="/properties" className="text-sm underline underline-offset-4">
          View properties
        </Link>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * `key`, `span` and `order` are unchanged from the stub: `config/dashboard.slots.ts`
 * imports this module by path and sorts on `order`, and w2-l5 composes the slots into the
 * five role dashboards.
 */
export const widget: DashboardWidget = {
  key: 'properties',
  title: 'Portfolio',
  roles: ['organization_admin', 'property_manager', 'property_owner'],
  span: 1,
  order: 20,
  enabled: true,
  Component: PortfolioWidget,
};
