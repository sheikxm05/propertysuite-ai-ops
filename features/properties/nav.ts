import { Building } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * Sidebar entry for the properties section. Lane w1-l2 — this file replaces the w0-l1
 * stub, which shipped `enabled: false` so the shell would not link to a 404.
 *
 * `key` and `order` are unchanged, as the briefing requires: `config/nav.registry.ts`
 * imports this module by path and sorts on `order`, and that registry is never edited by
 * a feature lane (§0 mechanism 3). `enabled` is now `true` because `/properties`,
 * `/properties/new` and `/properties/{propertyId}` all exist.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROLE LIST IS UNCHANGED, AND WHY IT IS NOT AUTHORIZATION
 * ---------------------------------------------------------------------------
 * All five roles have *some* property read in the §4 matrix, so the list below is
 * narrower than the matrix. That is a navigation decision, not a permission one: a
 * tenant's single leased property is surfaced in their tenancy and maintenance views
 * (lanes w1-l3 and w1-l4), and a provider's in their assigned job, so a "Properties"
 * section listing exactly one row would be a worse entry point than the one they already
 * have. Both can still reach `/properties` directly and will see precisely their
 * permitted set.
 *
 * `navForRole` filters links for display. It is not a security boundary and must never be
 * the only thing between a user and another organization's data — every route
 * re-authorizes through `withApiHandler` and `authorize()`, and Postgres RLS denies
 * independently of both.
 */
export const navEntry: NavEntry = {
  key: 'properties',
  label: 'Properties',
  href: '/properties',
  icon: Building,
  roles: ['organization_admin', 'property_manager', 'property_owner'],
  order: 20,
  enabled: true,
};
