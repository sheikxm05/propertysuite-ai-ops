import type { DashboardWidget, RoleKey } from './types';

// One import per feature, same discipline as nav.registry.ts. Feature lanes replace
// only their own widget.tsx; W2-L5 composes these into the five role dashboards.
import { widget as organizations } from '@/features/organizations/widget';
import { widget as properties } from '@/features/properties/widget';
import { widget as tenancies } from '@/features/tenancies/widget';
import { widget as maintenance } from '@/features/maintenance/widget';
import { widget as aiIntake } from '@/features/ai-intake/widget';
import { widget as documents } from '@/features/documents/widget';

export const DASHBOARD_SLOTS: readonly DashboardWidget[] = [
  organizations,
  properties,
  tenancies,
  maintenance,
  aiIntake,
  documents,
];

/** Widgets a given role should see, in display order. Presentation only, as per nav. */
export function widgetsForRole(role: RoleKey): readonly DashboardWidget[] {
  return DASHBOARD_SLOTS.filter((w) => w.enabled && w.roles.includes(role)).sort(
    (a, b) => a.order - b.order,
  );
}
