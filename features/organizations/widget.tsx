import type { DashboardWidget } from '@/config/types';

/**
 * PRE-STUB — owned by lane w0-l1 in Wave 0, REPLACED by lane w1-l1 in Wave 1.
 * Renders nothing while `enabled: false`, so the dashboard stays clean in Wave 0.
 */
export const widget: DashboardWidget = {
  key: 'organizations',
  title: 'Organization',
  roles: ['organization_admin'],
  span: 1,
  order: 10,
  enabled: false,
  Component: () => null,
};
