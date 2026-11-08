/**
 * Fixtures for the maintenance suite.
 *
 * Two organizations, five roles, one ticket shape. The ids are readable strings rather
 * than UUIDs wherever a UUID is not required, because a failing assertion that reads
 * `expected 'provider-b' to be 'provider-a'` is worth more than one comparing two
 * hex blobs. Where a value is validated as a UUID — a path parameter, a cursor, an
 * evidence id — a real one is used.
 *
 * `membershipFor` builds the SAME `Membership` shape `resolveMembership()` returns, by
 * hand. That is the one honest option available to a unit test: a `Membership` is
 * derived from trusted database rows, so constructing one in a test is constructing the
 * output of a query, not bypassing a check. The query itself is `lib/auth/roles.ts`,
 * covered by its own suite and by `tests/rls/**`.
 */

import type { Membership } from '@/lib/auth/roles';
import type { Logger } from '@/lib/observability/logger';
import type { TicketRow } from '@/features/maintenance/domain';
import type { MemberRole, TicketPriority, TicketStatus } from '@shared/index';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';

export const TICKET_ID = '33333333-3333-4333-8333-333333333333';
export const UNIT_ID = '44444444-4444-4444-8444-444444444444';
export const PROPERTY_ID = '55555555-5555-4555-8555-555555555555';
export const OTHER_PROPERTY_ID = '66666666-6666-4666-8666-666666666666';
export const TENANCY_ID = '77777777-7777-4777-8777-777777777777';
export const DOCUMENT_ID = '88888888-8888-4888-8888-888888888888';
export const PROVIDER_ID = '99999999-9999-4999-8999-999999999999';
export const OTHER_PROVIDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const TENANT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const OTHER_TENANT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const PROFILE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const OWNER_MEMBER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const ACTIVITY_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export interface MembershipOverrides {
  organizationId?: string;
  tenantId?: string | null;
  providerId?: string | null;
  memberId?: string;
  status?: Membership['status'];
  organizationStatus?: 'active' | 'suspended';
}

/**
 * A membership for `role`.
 *
 * `tenantId` and `providerId` default to the fixture ids for the two roles that have
 * them and to `null` for the three that do not — which mirrors `resolveMembership()`,
 * where a profile that is not a tenant in this organization simply has no `tenants` row
 * to find. Passing `tenantId: null` for a tenant models the real and security-relevant
 * case of a tenant-role member with no tenant record.
 */
export function membershipFor(role: MemberRole, overrides: MembershipOverrides = {}): Membership {
  const organizationId = overrides.organizationId ?? ORG_A;

  return {
    memberId: overrides.memberId ?? 'member-1',
    role,
    status: overrides.status ?? 'active',
    profile: { id: PROFILE_ID, authUserId: 'auth-user-1', fullName: 'A Person' },
    organization: {
      id: organizationId,
      name: 'Org A',
      slug: 'org-a',
      status: overrides.organizationStatus ?? 'active',
    },
    tenantId:
      overrides.tenantId !== undefined ? overrides.tenantId : role === 'tenant' ? TENANT_ID : null,
    providerId:
      overrides.providerId !== undefined
        ? overrides.providerId
        : role === 'service_provider'
          ? PROVIDER_ID
          : null,
  };
}

export interface TicketOverrides {
  id?: string;
  organizationId?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  tenantId?: string;
  assignedProviderId?: string | null;
  propertyId?: string;
  propertyUnitId?: string;
  tenancyId?: string | null;
  category?: string;
}

export function ticketRow(overrides: TicketOverrides = {}): TicketRow {
  return {
    id: overrides.id ?? TICKET_ID,
    organization_id: overrides.organizationId ?? ORG_A,
    property_id: overrides.propertyId ?? PROPERTY_ID,
    property_unit_id: overrides.propertyUnitId ?? UNIT_ID,
    tenancy_id: overrides.tenancyId !== undefined ? overrides.tenancyId : TENANCY_ID,
    tenant_id: overrides.tenantId ?? TENANT_ID,
    assigned_provider_id:
      overrides.assignedProviderId !== undefined ? overrides.assignedProviderId : null,
    title: 'Air conditioning not cooling',
    description: 'The AC is running but not cooling the room.',
    category: overrides.category ?? 'hvac',
    priority: overrides.priority ?? 'normal',
    status: overrides.status ?? 'open',
    source: 'web',
    created_at: '2026-11-01T08:00:00.000+00:00',
    updated_at: '2026-11-01T08:00:00.000+00:00',
  };
}

/** A logger that records nothing. The redaction allowlist has its own suite. */
export function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    requestId: 'test',
  };
  return logger;
}

/** A Monday, 10:00 Gulf Standard Time — inside business hours, so no escalation. */
export const INSIDE_BUSINESS_HOURS = new Date('2026-11-02T06:00:00.000Z');

/** A Saturday — outside business hours whatever the time. */
export const OUTSIDE_BUSINESS_HOURS = new Date('2026-11-07T06:00:00.000Z');
