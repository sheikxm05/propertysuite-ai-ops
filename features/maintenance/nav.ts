import { Wrench } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * Sidebar entry for the maintenance feature. Replaces w0-l1's pre-stub; `enabled` is now
 * `true` because `/maintenance` exists.
 *
 * All five roles see the link, and each one lands on a different set of rows. A tenant
 * sees the tickets they reported; a `service_provider` sees ONLY jobs assigned to them;
 * a `property_owner` sees tickets on properties they own; staff see the organization.
 *
 * The filtering is NOT here. `config/nav.registry.ts` filters this list for
 * presentation only — "a hidden link must never be the only thing standing between a
 * user and another organization's data". The row scope is `ticketListScope()` in the
 * domain service plus the four `maintenance_tickets` SELECT policies, and a role
 * removed from the list below would still be able to call the API.
 *
 * `order` is unchanged from the stub: the slot was reserved in Wave 0 so the sidebar
 * does not reshuffle as lanes land.
 */
export const navEntry: NavEntry = {
  key: 'maintenance',
  label: 'Maintenance',
  href: '/maintenance',
  icon: Wrench,
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant', 'service_provider'],
  order: 40,
  enabled: true,
};
