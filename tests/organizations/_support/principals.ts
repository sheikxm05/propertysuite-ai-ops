/**
 * Membership fixtures for this lane's unit tests. Lane w1-l1 test support.
 *
 * One membership per role in each of two organizations, so a test can ask "what does
 * this role see?" and "what happens across the boundary?" without constructing the
 * object inline each time.
 *
 * These are plain objects, not sessions: they stand in for what `resolveMembership()`
 * returns after it has read trusted rows. The *resolution* is w0-l5's code and is
 * covered by its own suite and by `tests/rls/**`; what this lane's tests exercise is
 * what its routes and queries do once a membership exists.
 */

import type { Membership } from '@/lib/auth/roles';
import { MEMBER_ROLES, type MemberRole } from '@shared/index';

/** Stable ids, so a failing assertion names a recognisable row. */
export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';

export const ORGANIZATIONS = {
  A: { id: ORG_A, name: 'Marina Properties', slug: 'marina-properties' },
  B: { id: ORG_B, name: 'Downtown Holdings', slug: 'downtown-holdings' },
} as const;

export type OrgKey = keyof typeof ORGANIZATIONS;

const KIND_DIGIT: Record<string, string> = {
  member: '1',
  profile: '2',
  tenant: '3',
  provider: '4',
};
const ORG_DIGIT: Record<OrgKey, string> = { A: 'a', B: 'b' };

/**
 * A deterministic, well-formed UUID encoding `(kind, organization, role)`.
 *
 * Well-formed matters: `MemberSchema` and `InvitationSchema` validate ids with
 * `UuidSchema`, and every response in this lane is parsed on the way out. A fixture id
 * that merely looked like an id would fail those parses and the failure would read as a
 * bug in the route rather than in the fixture.
 */
function idFor(org: OrgKey, role: MemberRole, kind: keyof typeof KIND_DIGIT): string {
  const k = KIND_DIGIT[kind] ?? '9';
  const o = ORG_DIGIT[org];
  const r = (MEMBER_ROLES.indexOf(role) + 1).toString(16);
  // 8-4-4-4-12, with the version nibble `4` and the variant nibble `8`.
  return `${k.repeat(8)}-${o.repeat(4)}-4${r.repeat(3)}-8${o.repeat(3)}-${(k + o + r).repeat(4)}`;
}

/**
 * A membership for one role in one organization.
 *
 * `tenantId` and `providerId` are populated only for the roles that have them, exactly
 * as `resolveMembership()` does — a tenant's membership carries a `tenants.id`, a
 * manager's does not. Several matrix cells turn on precisely that.
 */
export function membershipFor(
  org: OrgKey,
  role: MemberRole,
  overrides: Partial<Membership> = {},
): Membership {
  const organization = ORGANIZATIONS[org];
  return {
    memberId: idFor(org, role, 'member'),
    role,
    status: 'active',
    profile: {
      id: idFor(org, role, 'profile'),
      authUserId: `auth-${org}-${role}`,
      fullName: `${role} in ${organization.name}`,
    },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: 'active',
    },
    tenantId: role === 'tenant' ? idFor(org, role, 'tenant') : null,
    providerId: role === 'service_provider' ? idFor(org, role, 'provider') : null,
    ...overrides,
  };
}

/** Every role except `organization_admin`. The population that may not invite. */
export const NON_ADMIN_ROLES: readonly MemberRole[] = MEMBER_ROLES.filter(
  (role) => role !== 'organization_admin',
);
