import { Building } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * PRE-STUB — owned by lane w0-l1 in Wave 0, REPLACED by lane w1-l2 in Wave 1.
 * w1-l2: set `enabled: true` once /properties exists. Keep `key` and `order`.
 */
export const navEntry: NavEntry = {
  key: 'properties',
  label: 'Properties',
  href: '/properties',
  icon: Building,
  roles: ['organization_admin', 'property_manager', 'property_owner'],
  order: 20,
  enabled: false,
};
