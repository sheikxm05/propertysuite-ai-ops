/**
 * Dashboard widget registration — expiring tenancies. Replaces the w0-l1 pre-stub.
 *
 * `key`, `roles`, `span` and `order` are kept exactly as the stub reserved them, so the
 * slot this lane fills is the slot the plan allocated and `config/dashboard.slots.ts`
 * (owned by w0-l1, never edited here) needs no change. `enabled` flips to `true` because
 * `/tenancies` now exists.
 *
 * `DashboardWidget.Component` is typed `ComponentType<DashboardWidgetProps>`, which an
 * `async` function does not satisfy. So this is a synchronous component that renders the
 * async server component holding the query — the data stays on the server and the type
 * contract is met without widening it.
 *
 * `role` is intentionally unused. The shell already filtered on `roles` for display, and
 * the panel scopes its own query from trusted membership rather than from a prop: a role
 * arriving as a prop is presentation, and using it to decide what data to read would
 * make a client-reachable value load-bearing.
 */

import type { DashboardWidget } from '@/config/types';

import { ExpiringTenanciesPanel } from './components/expiring-tenancies';

export const widget: DashboardWidget = {
  key: 'tenancies',
  title: 'Expiring tenancies',
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant'],
  span: 2,
  order: 30,
  enabled: true,
  Component: () => <ExpiringTenanciesPanel />,
};
