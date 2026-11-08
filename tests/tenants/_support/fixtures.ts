/**
 * Fixtures for lane w1-l3's unit tests: two organizations, two tenants, one provider,
 * one owner, and a recording logger.
 *
 * TWO ORGANIZATIONS AND TWO TENANTS, ALWAYS
 * The whole point of this project is that organization A cannot reach organization B and
 * that tenant one cannot reach tenant two. A fixture set containing one of each cannot
 * express either claim, so every seed below carries both — including rows that *should*
 * never be returned. A test that passes because the forbidden row was absent from the
 * fixture has proven nothing.
 *
 * The identifiers are deliberately similar between the two organizations (same unit
 * numbers, adjacent UUID prefixes), mirroring the "deliberately similar-looking data"
 * the Sprint 9 seed script calls for: a filter that drops `organization_id` produces
 * plausible-looking wrong answers rather than obviously wrong ones.
 */

import type { Membership } from '@/lib/auth/roles';
import type { LogFields, Logger } from '@/lib/observability/logger';
import type { MemberRole } from '@shared/index';

import type { Row } from './fake-postgrest';

/* ----------------------------------------------------------------- ids ----- */

export const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
export const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000001';

export const PROFILE_MANAGER = '11111111-0000-4000-8000-000000000001';
export const PROFILE_TENANT_ONE = '11111111-0000-4000-8000-000000000002';
export const PROFILE_TENANT_TWO = '11111111-0000-4000-8000-000000000003';
export const PROFILE_PROVIDER = '11111111-0000-4000-8000-000000000004';
export const PROFILE_OWNER = '11111111-0000-4000-8000-000000000005';
export const PROFILE_UNLINKED = '11111111-0000-4000-8000-000000000009';

export const MEMBER_MANAGER = '22222222-0000-4000-8000-000000000001';
export const MEMBER_OWNER = '22222222-0000-4000-8000-000000000002';
export const MEMBER_OTHER_OWNER = '22222222-0000-4000-8000-000000000003';

export const TENANT_ONE = '33333333-0000-4000-8000-000000000001';
export const TENANT_TWO = '33333333-0000-4000-8000-000000000002';
/** Organization B's tenant. Must never appear in an organization A response. */
export const TENANT_FOREIGN = '33333333-0000-4000-8000-0000000000ff';

export const PROVIDER_ONE = '44444444-0000-4000-8000-000000000001';

export const PROPERTY_OWNED = '55555555-0000-4000-8000-000000000001';
export const PROPERTY_OTHER = '55555555-0000-4000-8000-000000000002';

export const UNIT_ONE = '66666666-0000-4000-8000-000000000001';
export const UNIT_TWO = '66666666-0000-4000-8000-000000000002';
export const UNIT_FOREIGN = '66666666-0000-4000-8000-0000000000ff';

export const TENANCY_ACTIVE = '77777777-0000-4000-8000-000000000001';
export const TENANCY_DRAFT = '77777777-0000-4000-8000-000000000002';
export const TENANCY_OTHER_TENANT = '77777777-0000-4000-8000-000000000003';
export const TENANCY_FOREIGN = '77777777-0000-4000-8000-0000000000ff';

export const TICKET_ASSIGNED = '88888888-0000-4000-8000-000000000001';

/* -------------------------------------------------------- memberships ----- */

/**
 * A membership as `resolveMembership()` would have produced it — every field from a
 * trusted row. Tests construct these directly because the lane's services take a
 * `Membership`, never an organization id: there is no parameter through which a test
 * (or a caller) could assert an organization it is not a member of.
 */
export function membership(role: MemberRole, overrides: Partial<Membership> = {}): Membership {
  const base: Membership = {
    memberId: MEMBER_MANAGER,
    role,
    status: 'active',
    profile: { id: PROFILE_MANAGER, authUserId: 'auth-manager', fullName: 'Mariam Manager' },
    organization: { id: ORG_A, name: 'Organization A', slug: 'org-a', status: 'active' },
    tenantId: null,
    providerId: null,
  };

  switch (role) {
    case 'tenant':
      return {
        ...base,
        profile: { id: PROFILE_TENANT_ONE, authUserId: 'auth-tenant-1', fullName: 'Tariq Tenant' },
        tenantId: TENANT_ONE,
        ...overrides,
      };
    case 'service_provider':
      return {
        ...base,
        profile: { id: PROFILE_PROVIDER, authUserId: 'auth-provider', fullName: 'Pat Provider' },
        providerId: PROVIDER_ONE,
        ...overrides,
      };
    case 'property_owner':
      return {
        ...base,
        memberId: MEMBER_OWNER,
        profile: { id: PROFILE_OWNER, authUserId: 'auth-owner', fullName: 'Omar Owner' },
        ...overrides,
      };
    default:
      return { ...base, ...overrides };
  }
}

/** The same person's membership, in organization B. For the cross-organization tests. */
export function foreignMembership(role: MemberRole): Membership {
  return membership(role, {
    organization: { id: ORG_B, name: 'Organization B', slug: 'org-b', status: 'active' },
  });
}

/* --------------------------------------------------------------- tables ---- */

/**
 * The tables this lane's fixtures seed.
 *
 * The six names are declared rather than left to the index signature so that
 * `tables.tenancies` is a `Row[]` and not a `Row[] | undefined` under
 * `noUncheckedIndexedAccess` — a test asserting on a fixture table should read as the
 * assertion it is, not as a chain of optional accesses. The index signature stays for
 * the fake client, which creates a table on first write.
 */
export interface SeedTables extends Record<string, Row[]> {
  tenants: Row[];
  organization_members: Row[];
  properties: Row[];
  property_units: Row[];
  tenancies: Row[];
  maintenance_tickets: Row[];
}

/**
 * A fresh table set per test. Returned by value because the fake client mutates it —
 * sharing one between tests would let an insert in one leak into the next.
 */
export function seedTables(): SeedTables {
  return {
    tenants: [
      {
        id: TENANT_ONE,
        organization_id: ORG_A,
        profile_id: PROFILE_TENANT_ONE,
        full_name: 'Tariq Tenant',
        email: 'tariq@example.test',
        phone: '+971500000001',
        created_at: '2026-01-02T00:00:00+00:00',
      },
      {
        id: TENANT_TWO,
        organization_id: ORG_A,
        profile_id: PROFILE_TENANT_TWO,
        full_name: 'Noura Neighbour',
        email: 'noura@example.test',
        phone: '+971500000002',
        created_at: '2026-01-01T00:00:00+00:00',
      },
      {
        id: TENANT_FOREIGN,
        organization_id: ORG_B,
        profile_id: null,
        full_name: 'Tariq Tenant',
        email: 'other-org@example.test',
        phone: '+971500000099',
        created_at: '2026-01-03T00:00:00+00:00',
      },
    ],

    organization_members: [
      {
        id: MEMBER_MANAGER,
        organization_id: ORG_A,
        profile_id: PROFILE_MANAGER,
        role: 'property_manager',
        status: 'active',
      },
      {
        id: MEMBER_OWNER,
        organization_id: ORG_A,
        profile_id: PROFILE_OWNER,
        role: 'property_owner',
        status: 'active',
      },
      {
        id: '22222222-0000-4000-8000-00000000000a',
        organization_id: ORG_A,
        profile_id: PROFILE_TENANT_TWO,
        role: 'tenant',
        status: 'active',
      },
      // Organization B only. Linking this profile from organization A must be refused.
      {
        id: '22222222-0000-4000-8000-0000000000ff',
        organization_id: ORG_B,
        profile_id: PROFILE_UNLINKED,
        role: 'tenant',
        status: 'active',
      },
    ],

    properties: [
      { id: PROPERTY_OWNED, organization_id: ORG_A, owner_member_id: MEMBER_OWNER },
      { id: PROPERTY_OTHER, organization_id: ORG_A, owner_member_id: MEMBER_OTHER_OWNER },
    ],

    property_units: [
      {
        id: UNIT_ONE,
        organization_id: ORG_A,
        property_id: PROPERTY_OWNED,
        unit_number: '101',
        bedrooms: 2,
        bathrooms: 1.5,
        area_sqft: 980.5,
        status: 'occupied',
        created_at: '2026-01-01T00:00:00+00:00',
      },
      {
        id: UNIT_TWO,
        organization_id: ORG_A,
        property_id: PROPERTY_OTHER,
        unit_number: '102',
        bedrooms: 1,
        bathrooms: 1,
        area_sqft: 640,
        status: 'available',
        created_at: '2026-01-01T00:00:00+00:00',
      },
      {
        id: UNIT_FOREIGN,
        organization_id: ORG_B,
        property_id: '55555555-0000-4000-8000-0000000000ff',
        unit_number: '101',
        bedrooms: 2,
        bathrooms: 1.5,
        area_sqft: 980.5,
        status: 'available',
        created_at: '2026-01-01T00:00:00+00:00',
      },
    ],

    tenancies: [
      {
        id: TENANCY_ACTIVE,
        organization_id: ORG_A,
        property_unit_id: UNIT_ONE,
        tenant_id: TENANT_ONE,
        contract_number: 'EJARI-0001',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        rent_amount: 120000,
        currency: 'AED',
        status: 'active',
        created_at: '2026-01-02T00:00:00+00:00',
      },
      {
        id: TENANCY_DRAFT,
        organization_id: ORG_A,
        property_unit_id: UNIT_TWO,
        tenant_id: TENANT_ONE,
        contract_number: 'EJARI-0002',
        start_date: '2027-01-01',
        end_date: '2027-12-31',
        rent_amount: 95000.5,
        currency: 'AED',
        status: 'draft',
        created_at: '2026-01-03T00:00:00+00:00',
      },
      {
        id: TENANCY_OTHER_TENANT,
        organization_id: ORG_A,
        property_unit_id: UNIT_TWO,
        tenant_id: TENANT_TWO,
        contract_number: 'EJARI-0003',
        start_date: '2026-02-01',
        end_date: '2026-11-30',
        rent_amount: 88000,
        currency: 'AED',
        status: 'active',
        created_at: '2026-01-04T00:00:00+00:00',
      },
      {
        id: TENANCY_FOREIGN,
        organization_id: ORG_B,
        property_unit_id: UNIT_FOREIGN,
        tenant_id: TENANT_FOREIGN,
        contract_number: 'EJARI-9999',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
        rent_amount: 500000,
        currency: 'AED',
        status: 'active',
        created_at: '2026-01-05T00:00:00+00:00',
      },
    ],

    maintenance_tickets: [
      {
        id: TICKET_ASSIGNED,
        organization_id: ORG_A,
        property_unit_id: UNIT_ONE,
        tenant_id: TENANT_ONE,
        assigned_provider_id: PROVIDER_ONE,
        status: 'assigned',
      },
    ],
  };
}

/* --------------------------------------------------------------- logger ---- */

export interface RecordedLog {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  fields: LogFields;
}

export interface TestLogger extends Logger {
  records: RecordedLog[];
}

/**
 * A logger that records instead of writing.
 *
 * It does **not** apply the redaction allowlist, which is `lib/observability`'s own
 * tested behaviour. What it is for here is asserting that a code path logged at all —
 * that a withheld row produced an `authorization_layer_disagreement` line, for instance,
 * rather than being silently dropped.
 */
export function testLogger(): TestLogger {
  const records: RecordedLog[] = [];
  const make = (level: RecordedLog['level']) => (message: string, fields?: LogFields) => {
    records.push({ level, message, fields: fields ?? {} });
  };

  const logger: TestLogger = {
    records,
    requestId: 'test-request-id',
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    child: () => logger,
  };

  return logger;
}
