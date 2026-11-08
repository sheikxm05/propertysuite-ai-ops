import { Suspense } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import type { DashboardWidget } from '@/config/types';

import { OpenTicketsByPriority } from './components/open-by-priority';

/**
 * Dashboard widget: open tickets by priority. Replaces w0-l1's pre-stub.
 *
 * `Component` is a SYNCHRONOUS function that renders an async server component inside a
 * `Suspense` boundary, rather than being async itself. Two reasons:
 *
 *  - `DashboardWidget.Component` is typed `ComponentType<DashboardWidgetProps>` in
 *    `config/types.ts`, which is w0-l1's file and not this lane's to widen.
 *  - The boundary means a slow count renders a skeleton instead of delaying the whole
 *    dashboard. Five widgets each doing their own queries would otherwise serialize into
 *    the slowest one.
 *
 * `role` is not passed down. The widget resolves membership server-side for itself, from
 * trusted rows, and derives its scope from that — a count scoped by a prop would be a
 * count scoped by whatever the shell happened to pass (CLAUDE.md rule 5).
 *
 * All five roles are listed, and each sees their own slice: staff the organization, an
 * owner their properties, a tenant their reports, a provider their assigned jobs.
 */
function MaintenanceWidget() {
  return (
    <Suspense fallback={<Skeleton className="h-20 w-full" />}>
      <OpenTicketsByPriority />
    </Suspense>
  );
}

export const widget: DashboardWidget = {
  key: 'maintenance',
  title: 'Open tickets',
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant', 'service_provider'],
  span: 2,
  order: 40,
  enabled: true,
  Component: MaintenanceWidget,
};
