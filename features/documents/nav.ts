import { FileCheck2 } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * PRE-STUB — owned by lane w0-l1 in Wave 0, REPLACED by lane w1-l6 in Wave 1.
 * Extracted fields stay `pending` until a human verifies them. AI extraction is never
 * treated as legal or financial truth.
 */
export const navEntry: NavEntry = {
  key: 'documents',
  label: 'Documents',
  href: '/documents',
  icon: FileCheck2,
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant'],
  order: 60,
  enabled: false,
};
