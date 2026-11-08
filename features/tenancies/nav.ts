import { ScrollText } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * PRE-STUB — owned by lane w0-l1 in Wave 0, REPLACED by lane w1-l3 in Wave 1.
 * Note `tenant` is included: a tenant sees this link but the route must expose ONLY
 * their own tenancy. The link is presentation; RLS and the handler are the boundary.
 */
export const navEntry: NavEntry = {
  key: 'tenancies',
  label: 'Tenancies',
  href: '/tenancies',
  icon: ScrollText,
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant'],
  order: 30,
  enabled: false,
};
