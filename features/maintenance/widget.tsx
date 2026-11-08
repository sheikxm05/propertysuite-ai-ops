import type { DashboardWidget } from '@/config/types';

/** PRE-STUB — owned by w0-l1, REPLACED by w1-l4 (open tickets by priority). */
export const widget: DashboardWidget = {
  key: 'maintenance',
  title: 'Open tickets',
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant', 'service_provider'],
  span: 2,
  order: 40,
  enabled: false,
  Component: () => null,
};
