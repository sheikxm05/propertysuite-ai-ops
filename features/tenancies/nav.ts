import { ScrollText } from 'lucide-react';
import type { NavEntry } from '@/config/types';

/**
 * Sidebar registration for tenancies. Replaces the w0-l1 pre-stub.
 *
 * `key`, `label`, `href`, `icon`, `order` and `roles` are unchanged from the stub, so
 * `config/nav.registry.ts` (owned by w0-l1) needs no edit — which is the whole point of
 * the pre-stub mechanism in §0.3. `enabled` flips to `true` because
 * `app/(dashboard)/tenancies` now exists and no longer links to a 404.
 *
 * `tenant` is in `roles` deliberately. The link is presentation: a tenant following it
 * reaches the self-service view, which exposes their own tenancy and nothing else
 * because `tenancyReadScope()` pins `tenant_id` to their membership and `0002`'s
 * `tenancies_select_own` pins it again in Postgres. The sidebar filter is not
 * authorization and must never be the only thing standing between a tenant and another
 * tenant's lease.
 *
 * `service_provider` is absent: the §4 matrix gives a provider no access to `tenancies`
 * in any operation, so the route would correctly refuse them and the link would be a
 * dead end.
 */
export const navEntry: NavEntry = {
  key: 'tenancies',
  label: 'Tenancies',
  href: '/tenancies',
  icon: ScrollText,
  roles: ['organization_admin', 'property_manager', 'property_owner', 'tenant'],
  order: 30,
  enabled: true,
};
