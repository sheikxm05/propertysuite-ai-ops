import { Wrench } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * PRE-STUB — owned by lane w0-l1 in Wave 0, REPLACED by lane w1-l4 in Wave 1.
 * All five roles see this link, but each sees a different slice: a tenant only their
 * own tickets, a service_provider ONLY assigned jobs (acceptance criterion 7). The
 * filtering is server-side and in RLS — never in this list.
 */
export const navEntry: NavEntry = {
  key: 'maintenance',
  label: 'Maintenance',
  href: '/maintenance',
  icon: Wrench,
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant', 'service_provider'],
  order: 40,
  enabled: false,
};
