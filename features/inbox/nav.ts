import { MessageSquareText } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * Inbound tenant messages — WhatsApp and the simulator.
 *
 * Staff only: the inbox shows every message for the organization, including ones whose
 * sender could NOT be resolved to a tenant. An unattributed message has a null
 * `organization_id` and is visible through a staff-scoped path, so offering this link to
 * a tenant would promise a surface they cannot use.
 */
export const navEntry: NavEntry = {
  key: 'inbox',
  label: 'Inbox',
  href: '/inbox',
  icon: MessageSquareText,
  roles: ['organization_admin', 'property_manager'],
  order: 70,
  enabled: true,
};
