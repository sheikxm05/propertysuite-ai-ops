import type { DashboardWidget } from '@/config/types';

/** PRE-STUB — owned by w0-l1, REPLACED by w1-l2 (portfolio counts). */
export const widget: DashboardWidget = {
  key: 'properties',
  title: 'Portfolio',
  roles: ['organization_admin', 'property_manager', 'property_owner'],
  span: 1,
  order: 20,
  enabled: false,
  Component: () => null,
};
