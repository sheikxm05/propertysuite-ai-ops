import type { DashboardWidget } from '@/config/types';

/** PRE-STUB — owned by w0-l1, REPLACED by w1-l3 (expiring tenancies). */
export const widget: DashboardWidget = {
  key: 'tenancies',
  title: 'Expiring tenancies',
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant'],
  span: 2,
  order: 30,
  enabled: false,
  Component: () => null,
};
