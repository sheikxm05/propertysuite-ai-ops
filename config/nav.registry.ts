import type { NavEntry, RoleKey } from './types';

// One import per feature. Each lane owns its own file; this registry is NEVER edited by
// a feature lane. Adding a seventh feature is a planning change, not a lane change.
import { navEntry as organizations } from '@/features/organizations/nav';
import { navEntry as properties } from '@/features/properties/nav';
import { navEntry as tenancies } from '@/features/tenancies/nav';
import { navEntry as maintenance } from '@/features/maintenance/nav';
import { navEntry as aiIntake } from '@/features/ai-intake/nav';
import { navEntry as documents } from '@/features/documents/nav';
import { navEntry as inbox } from '@/features/inbox/nav';
import { navEntry as aiAgent } from '@/features/ai-agent/nav';
import { navEntry as ask } from '@/features/ask/nav';

export const NAV_REGISTRY: readonly NavEntry[] = [
  organizations,
  properties,
  tenancies,
  maintenance,
  aiIntake,
  documents,
  inbox,
  aiAgent,
  ask,
];

/**
 * Sidebar items for one role. Filtering here is presentation only — it hides links the
 * role cannot use. It is NOT authorization: every route re-checks server-side via
 * withApiHandler, and Postgres RLS denies independently. A hidden link must never be
 * the only thing standing between a user and another organization's data.
 */
export function navForRole(role: RoleKey): readonly NavEntry[] {
  return NAV_REGISTRY.filter((entry) => entry.enabled && entry.roles.includes(role)).sort(
    (a, b) => a.order - b.order,
  );
}
