import { MessageSquarePlus } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * PRE-STUB — owned by lane w0-l1 in Wave 0, REPLACED by lane w1-l5 in Wave 1.
 * This route produces a DRAFT classification only. It must never create a ticket
 * without an explicit human confirmation (CLAUDE.md rule 7).
 */
export const navEntry: NavEntry = {
  key: 'ai-intake',
  label: 'Report an issue',
  href: '/maintenance/report',
  icon: MessageSquarePlus,
  roles: ['tenant', 'property_manager'],
  order: 50,
  enabled: false,
};
