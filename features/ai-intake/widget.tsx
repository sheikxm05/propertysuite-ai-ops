import type { DashboardWidget } from '@/config/types';

/** PRE-STUB — owned by w0-l1, REPLACED by w1-l5 ("report an issue" entry point). */
export const widget: DashboardWidget = {
  key: 'ai-intake',
  title: 'Report an issue',
  roles: ['tenant'],
  span: 1,
  order: 50,
  enabled: false,
  Component: () => null,
};
