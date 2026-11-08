import { Building2 } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * Sidebar entry for the organization surface. Lane w1-l1 — this file replaces w0-l1's
 * pre-stub.
 *
 * `key` and `order` are unchanged from the stub: `config/nav.registry.ts` already
 * imports this module and the slot order is the registry's contract, not this lane's to
 * renegotiate. `enabled` flips to `true` because `/organization` now exists — the stub
 * shipped `false` so the Wave 0 sidebar would not link to a 404.
 *
 * `roles` stays `['organization_admin']`, and that is a *presentation* decision about
 * where member management belongs in the navigation. It is not authorization:
 * `/organization` renders a summary for every role, and `navForRole` says in its own
 * comment that a hidden link must never be the only thing standing between a user and
 * another organization's data. Every route re-checks server-side and RLS denies
 * independently.
 */
export const navEntry: NavEntry = {
  key: 'organizations',
  label: 'Organization',
  href: '/organization',
  icon: Building2,
  roles: ['organization_admin'],
  order: 10,
  enabled: true,
};
