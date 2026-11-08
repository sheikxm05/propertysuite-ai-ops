import type { DashboardWidget } from '@/config/types';

/** PRE-STUB — owned by w0-l1, REPLACED by w1-l6 (pending verifications). */
export const widget: DashboardWidget = {
  key: 'documents',
  title: 'Pending verification',
  roles: ['organization_admin', 'property_manager'],
  span: 1,
  order: 60,
  enabled: false,
  Component: () => null,
};
