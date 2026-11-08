import { Building2 } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * PRE-STUB — owned by lane w0-l1 in Wave 0, REPLACED by lane w1-l1 in Wave 1.
 * w1-l1: set `enabled: true` once /organization exists. Keep `key` and `order`.
 * Do not edit config/nav.registry.ts — it already imports this file.
 */
export const navEntry: NavEntry = {
  key: 'organizations',
  label: 'Organization',
  href: '/organization',
  icon: Building2,
  roles: ['organization_admin'],
  order: 10,
  enabled: false,
};
