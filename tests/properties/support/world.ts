/**
 * Fixture identities for the property suites. Lane w1-l2.
 *
 * Deliberately modelled on `tests/_harness/fixtures.ts`: **organization A and
 * organization B are indistinguishable by content.** Both own a property called
 * "Marina Heights Tower" with a unit "1204", so a row that leaks from B into A's result
 * looks exactly like a row A is entitled to see. The only thing that can catch a leak is
 * an identifier comparison, which is what every assertion here does.
 *
 * These are plain objects, not database rows — no suite in this lane can reach the live
 * project (see the header of `support/fake-supabase.ts`). The ids are real UUIDs because
 * `UuidSchema` validates path parameters and `PropertyPathParamsSchema` would otherwise
 * reject the fixtures before the code under test ran.
 */

import type { Membership } from '@/lib/auth/roles';
import type { MemberRole, PropertyRow, PropertyUnitRow } from '@shared/index';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';

export const IDS = {
  a: {
    manager: {
      member: 'aaaa1111-1111-4111-8111-111111111111',
      profile: 'aaaa1111-1111-4111-8111-aaaaaaaaaaaa',
    },
    admin: {
      member: 'aaaa2222-2222-4222-8222-222222222222',
      profile: 'aaaa2222-2222-4222-8222-aaaaaaaaaaaa',
    },
    owner: {
      member: 'aaaa3333-3333-4333-8333-333333333333',
      profile: 'aaaa3333-3333-4333-8333-aaaaaaaaaaaa',
    },
    tenant: {
      member: 'aaaa4444-4444-4444-8444-444444444444',
      profile: 'aaaa4444-4444-4444-8444-aaaaaaaaaaaa',
      tenant: 'aaaa4444-4444-4444-8444-bbbbbbbbbbbb',
    },
    provider: {
      member: 'aaaa5555-5555-4555-8555-555555555555',
      profile: 'aaaa5555-5555-4555-8555-aaaaaaaaaaaa',
      provider: 'aaaa5555-5555-4555-8555-bbbbbbbbbbbb',
    },
    /** P1 is owned by the owner principal; P2 is owned by nobody. */
    p1: 'aaaa0001-0001-4001-8001-000000000001',
    p2: 'aaaa0002-0002-4002-8002-000000000002',
    /** P1/1204 is the tenant's leased unit and the provider's assigned unit. */
    p1u1: 'aaaa1204-1204-4204-8204-000000000001',
    p1u2: 'aaaa1808-1808-4808-8808-000000000002',
    p2u1: 'aaaa1204-1204-4204-8204-000000000003',
  },
  b: {
    manager: {
      member: 'bbbb1111-1111-4111-8111-111111111111',
      profile: 'bbbb1111-1111-4111-8111-bbbbbbbbbbbb',
    },
    p1: 'bbbb0001-0001-4001-8001-000000000001',
    p1u1: 'bbbb1204-1204-4204-8204-000000000001',
  },
} as const;

/* -------------------------------------------------------------- memberships -- */

interface MembershipOverrides {
  role: MemberRole;
  organizationId?: string;
  memberId?: string;
  profileId?: string;
  tenantId?: string | null;
  providerId?: string | null;
  status?: Membership['status'];
  organizationStatus?: Membership['organization']['status'];
}

/** A membership exactly as `resolveMembership` would return it from trusted rows. */
export function membership(overrides: MembershipOverrides): Membership {
  return {
    memberId: overrides.memberId ?? IDS.a.manager.member,
    role: overrides.role,
    status: overrides.status ?? 'active',
    profile: {
      id: overrides.profileId ?? IDS.a.manager.profile,
      authUserId: `auth-${overrides.profileId ?? IDS.a.manager.profile}`,
      fullName: 'Fixture Principal',
    },
    organization: {
      id: overrides.organizationId ?? ORG_A,
      name: 'Organization A',
      slug: 'organization-a',
      status: overrides.organizationStatus ?? 'active',
    },
    tenantId: overrides.tenantId ?? null,
    providerId: overrides.providerId ?? null,
  };
}

export const MANAGER_A = membership({
  role: 'property_manager',
  memberId: IDS.a.manager.member,
  profileId: IDS.a.manager.profile,
});

export const ADMIN_A = membership({
  role: 'organization_admin',
  memberId: IDS.a.admin.member,
  profileId: IDS.a.admin.profile,
});

/** Owns P1 and nothing else. Read-only on it, per the §4 matrix. */
export const OWNER_A = membership({
  role: 'property_owner',
  memberId: IDS.a.owner.member,
  profileId: IDS.a.owner.profile,
});

/** Holds one active tenancy, on P1/1204. */
export const TENANT_A = membership({
  role: 'tenant',
  memberId: IDS.a.tenant.member,
  profileId: IDS.a.tenant.profile,
  tenantId: IDS.a.tenant.tenant,
});

/** Assigned exactly one ticket, on P1/1204. */
export const PROVIDER_A = membership({
  role: 'service_provider',
  memberId: IDS.a.provider.member,
  profileId: IDS.a.provider.profile,
  providerId: IDS.a.provider.provider,
});

export const MANAGER_B = membership({
  role: 'property_manager',
  organizationId: ORG_B,
  memberId: IDS.b.manager.member,
  profileId: IDS.b.manager.profile,
});

/* ------------------------------------------------------------------- rows -- */

/** A `properties` row. Both organizations' fixtures use the same names on purpose. */
export function propertyRow(overrides: Partial<PropertyRow> = {}): PropertyRow {
  return {
    id: IDS.a.p1,
    organization_id: ORG_A,
    name: 'Marina Heights Tower',
    property_type: 'apartment_building',
    address_line: 'Example Street',
    city: 'Dubai',
    emirate: 'Dubai',
    owner_member_id: IDS.a.owner.member,
    status: 'active',
    created_at: '2026-01-10T08:00:00+00:00',
    updated_at: '2026-01-10T08:00:00+00:00',
    ...overrides,
  };
}

/** A `property_units` row. */
export function unitRow(overrides: Partial<PropertyUnitRow> = {}): PropertyUnitRow {
  return {
    id: IDS.a.p1u1,
    organization_id: ORG_A,
    property_id: IDS.a.p1,
    unit_number: '1204',
    bedrooms: 2,
    bathrooms: 2,
    area_sqft: 1450,
    status: 'available',
    created_at: '2026-01-10T08:05:00+00:00',
    ...overrides,
  };
}

/** The `organization_members` shape `fetchOwnerCandidate` and `listOwnerOptions` select. */
export function memberRow(
  overrides: Partial<{
    id: string;
    organization_id: string;
    role: string;
    status: string;
  }> = {},
) {
  return {
    id: IDS.a.owner.member,
    organization_id: ORG_A,
    role: 'property_owner',
    status: 'active',
    ...overrides,
  };
}
