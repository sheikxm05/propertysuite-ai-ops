import { FileCheck2 } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * Sidebar entry for document intelligence. Lane w1-l6 — replaces the w0-l1 pre-stub.
 *
 * `enabled: true` because `/documents` and `/documents/{documentId}` now exist. The
 * `order` and `key` are unchanged from the stub: the registry in `config/nav.registry.ts`
 * is not this lane's to edit, and the slot was reserved for exactly this value.
 *
 * `service_provider` is added to the stub's role list. Amendment A7 gives a provider
 * INSERT and SELECT on `documents` scoped to tickets assigned to them, so a provider has
 * a real, non-empty document list — their own completion evidence — and hiding the link
 * would leave that evidence reachable only by URL.
 *
 * This list is presentation, never authorization. `navForRole` filters links a role
 * cannot use; every route re-authorizes server-side and RLS denies independently. If
 * this array were wrong in the permissive direction the only consequence would be a link
 * that returns an empty list.
 */
export const navEntry: NavEntry = {
  key: 'documents',
  label: 'Documents',
  href: '/documents',
  icon: FileCheck2,
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant', 'service_provider'],
  order: 60,
  enabled: true,
};
