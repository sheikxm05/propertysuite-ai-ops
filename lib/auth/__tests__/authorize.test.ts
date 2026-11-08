/**
 * `authorize` across all five roles and all fifteen tables of the §4 matrix.
 *
 * These tests live under `lib/` rather than `tests/` because `tests/**` belongs to other
 * lanes (see `lanes.json`).
 *
 * The expectation table below is a transcription of the matrix in
 * `docs/implementation-plan.md` §4. It is written out longhand on purpose: a test that
 * derived its expectations from `POLICIES` would pass no matter what `POLICIES` said.
 * When the matrix and this table disagree, the matrix is the contract and the code is
 * wrong — including when the code is this file.
 */

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_TENANT_FIELDS,
  authorize,
  assertAuthorized,
  AuthorizationDeniedError,
  knownResourceTypes,
  knownRoles,
  projectionFor,
  type Action,
  type ResourceRef,
  type ResourceType,
} from '../authorize';
import type { Membership } from '../roles';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PROFILE = '22222222-2222-2222-2222-222222222222';
const MEMBER = '33333333-3333-3333-3333-333333333333';
const TENANT = '44444444-4444-4444-4444-444444444444';
const PROVIDER = '55555555-5555-5555-5555-555555555555';

const OTHER_PROFILE = '2222aaaa-2222-2222-2222-222222222222';
const OTHER_MEMBER = '3333aaaa-3333-3333-3333-333333333333';
const OTHER_TENANT = '4444aaaa-4444-4444-4444-444444444444';
const OTHER_PROVIDER = '5555aaaa-5555-5555-5555-555555555555';

type Role = (typeof ROLES)[number];
const ROLES = knownRoles();

function membershipFor(role: Role, overrides: Partial<Membership> = {}): Membership {
  return {
    memberId: MEMBER,
    role,
    status: 'active',
    profile: { id: PROFILE, authUserId: 'auth-user-1', fullName: 'Test Person' },
    organization: { id: ORG_A, name: 'Organization A', slug: 'org-a', status: 'active' },
    tenantId: role === 'tenant' ? TENANT : null,
    providerId: role === 'service_provider' ? PROVIDER : null,
    ...overrides,
  };
}

/** A row in the caller's organization whose every identity link points at the caller. */
function ownRow(type: ResourceType): ResourceRef {
  return {
    type,
    organizationId: ORG_A,
    ownerMemberId: MEMBER,
    tenantId: TENANT,
    providerId: PROVIDER,
    profileId: PROFILE,
  };
}

/** A row in the same organization belonging to somebody else. */
function foreignRow(type: ResourceType): ResourceRef {
  return {
    type,
    organizationId: ORG_A,
    ownerMemberId: OTHER_MEMBER,
    tenantId: OTHER_TENANT,
    providerId: OTHER_PROVIDER,
    profileId: OTHER_PROFILE,
  };
}

/**
 * `r` read, `c` create, `u` update, `a` archive — all against a row that belongs to the
 * caller. `fr` is read against a same-organization row that belongs to somebody else;
 * it is what separates "R" from "R own" in the matrix.
 */
interface Expectation {
  r: boolean;
  c: boolean;
  u: boolean;
  a: boolean;
  fr: boolean;
}

const T = true;
const F = false;

const MATRIX: Record<ResourceType, Record<string, Expectation>> = {
  // organizations | R own × 5
  organization: {
    organization_admin: { r: T, c: F, u: F, a: F, fr: T },
    property_manager: { r: T, c: F, u: F, a: F, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: T },
    tenant: { r: T, c: F, u: F, a: F, fr: T },
    service_provider: { r: T, c: F, u: F, a: F, fr: T },
  },

  // profiles | R self + same-org (staff and owner) | R self only (tenant, provider)
  profile: {
    organization_admin: { r: T, c: F, u: F, a: F, fr: T },
    property_manager: { r: T, c: F, u: F, a: F, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: T },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: T, c: F, u: F, a: F, fr: F },
  },

  // organization_members | RW admin | R staff/owner | R self tenant/provider
  organization_member: {
    organization_admin: { r: T, c: T, u: T, a: T, fr: T },
    property_manager: { r: T, c: F, u: F, a: F, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: T },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: T, c: F, u: F, a: F, fr: F },
  },

  // properties | RWA staff | R owned | R via tenancy | R via assigned ticket
  property: {
    organization_admin: { r: T, c: T, u: T, a: T, fr: T },
    property_manager: { r: T, c: T, u: T, a: T, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: T, c: F, u: F, a: F, fr: F },
  },

  property_unit: {
    organization_admin: { r: T, c: T, u: T, a: T, fr: T },
    property_manager: { r: T, c: T, u: T, a: T, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: T, c: F, u: F, a: F, fr: F },
  },

  // tenants | RW staff | — owner | R self | R name only via assignment
  tenant: {
    organization_admin: { r: T, c: T, u: T, a: F, fr: T },
    property_manager: { r: T, c: T, u: T, a: F, fr: T },
    property_owner: { r: F, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: T, c: F, u: F, a: F, fr: F },
  },

  // tenancies | RW staff | R owned | R own | — provider
  tenancy: {
    organization_admin: { r: T, c: T, u: T, a: F, fr: T },
    property_manager: { r: T, c: T, u: T, a: F, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: F, c: F, u: F, a: F, fr: F },
  },

  // service_providers | RW staff | — | — | R self
  service_provider: {
    organization_admin: { r: T, c: T, u: T, a: F, fr: T },
    property_manager: { r: T, c: T, u: T, a: F, fr: T },
    property_owner: { r: F, c: F, u: F, a: F, fr: F },
    tenant: { r: F, c: F, u: F, a: F, fr: F },
    service_provider: { r: T, c: F, u: F, a: F, fr: F },
  },

  // maintenance_tickets | RW staff | R owned | CR own + confirm | R+U assigned only
  maintenance_ticket: {
    organization_admin: { r: T, c: T, u: T, a: F, fr: T },
    property_manager: { r: T, c: T, u: T, a: F, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: T, u: T, a: F, fr: F },
    service_provider: { r: T, c: F, u: T, a: F, fr: F },
  },

  // maintenance_activities | R admin | CR manager | R owned | CR own | CR assigned
  maintenance_activity: {
    organization_admin: { r: T, c: F, u: F, a: F, fr: T },
    property_manager: { r: T, c: T, u: F, a: F, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: T, u: F, a: F, fr: F },
    service_provider: { r: T, c: T, u: F, a: F, fr: F },
  },

  // documents | RW staff | R owned | R own tenancy | —
  document: {
    organization_admin: { r: T, c: T, u: T, a: F, fr: T },
    property_manager: { r: T, c: T, u: T, a: F, fr: T },
    property_owner: { r: T, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: F, c: F, u: F, a: F, fr: F },
  },

  // ai_conversations | R staff | — | CR own | —
  ai_conversation: {
    organization_admin: { r: T, c: F, u: F, a: F, fr: T },
    property_manager: { r: T, c: F, u: F, a: F, fr: T },
    property_owner: { r: F, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: T, u: F, a: F, fr: F },
    service_provider: { r: F, c: F, u: F, a: F, fr: F },
  },

  ai_message: {
    organization_admin: { r: T, c: F, u: F, a: F, fr: T },
    property_manager: { r: T, c: F, u: F, a: F, fr: T },
    property_owner: { r: F, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: T, u: F, a: F, fr: F },
    service_provider: { r: F, c: F, u: F, a: F, fr: F },
  },

  // notifications | R own × 5; no INSERT policy exists, so create is denied everywhere
  notification: {
    organization_admin: { r: T, c: F, u: F, a: F, fr: F },
    property_manager: { r: T, c: F, u: F, a: F, fr: F },
    property_owner: { r: T, c: F, u: F, a: F, fr: F },
    tenant: { r: T, c: F, u: F, a: F, fr: F },
    service_provider: { r: T, c: F, u: F, a: F, fr: F },
  },

  // audit_logs | R admin | — | — | — | —
  audit_log: {
    organization_admin: { r: T, c: F, u: F, a: F, fr: T },
    property_manager: { r: F, c: F, u: F, a: F, fr: F },
    property_owner: { r: F, c: F, u: F, a: F, fr: F },
    tenant: { r: F, c: F, u: F, a: F, fr: F },
    service_provider: { r: F, c: F, u: F, a: F, fr: F },
  },
};

describe('coverage', () => {
  it('names exactly the five roles from the shared contract', () => {
    expect([...ROLES].sort()).toEqual([
      'organization_admin',
      'property_manager',
      'property_owner',
      'service_provider',
      'tenant',
    ]);
  });

  it('covers every table in the matrix, and no extras', () => {
    expect([...knownResourceTypes()].sort()).toEqual(Object.keys(MATRIX).sort());
  });

  it('has an expectation for every role on every table', () => {
    for (const type of knownResourceTypes()) {
      expect(Object.keys(MATRIX[type]).sort(), type).toEqual([...ROLES].sort());
    }
  });
});

describe('the §4 matrix, cell by cell', () => {
  const actions: { action: Action; key: keyof Expectation }[] = [
    { action: 'read', key: 'r' },
    { action: 'create', key: 'c' },
    { action: 'update', key: 'u' },
    { action: 'archive', key: 'a' },
  ];

  for (const type of knownResourceTypes()) {
    for (const role of ROLES) {
      const expected = MATRIX[type][role] as Expectation;
      const membership = membershipFor(role);

      for (const { action, key } of actions) {
        it(`${role} ${action} own ${type} → ${expected[key] ? 'allow' : 'deny'}`, () => {
          const decision = authorize(membership, action, ownRow(type));
          expect(decision.allowed).toBe(expected[key]);
          expect(decision.reason).toMatch(/^[a-z][a-z0-9_]*$/);
        });
      }

      it(`${role} read another's ${type} → ${expected.fr ? 'allow' : 'deny'}`, () => {
        expect(authorize(membership, 'read', foreignRow(type)).allowed).toBe(expected.fr);
      });
    }
  }
});

describe('cross-organization isolation', () => {
  it('denies every role every action on a row from another organization', () => {
    for (const type of knownResourceTypes()) {
      for (const role of ROLES) {
        for (const action of ['read', 'create', 'update', 'archive'] as Action[]) {
          const decision = authorize(membershipFor(role), action, {
            ...ownRow(type),
            organizationId: ORG_B,
          });
          expect(decision.allowed, `${role}/${action}/${type}`).toBe(false);
        }
      }
    }
  });

  it('reports cross-organization as its own reason, before any role rule', () => {
    const decision = authorize(membershipFor('organization_admin'), 'read', {
      type: 'property',
      organizationId: ORG_B,
    });
    expect(decision).toEqual({ allowed: false, reason: 'cross_organization' });
  });
});

describe('global preconditions', () => {
  it('refuses delete on every table for every role (CLAUDE.md rule 6)', () => {
    for (const type of knownResourceTypes()) {
      for (const role of ROLES) {
        expect(authorize(membershipFor(role), 'delete', ownRow(type))).toEqual({
          allowed: false,
          reason: 'delete_never_permitted',
        });
      }
    }
  });

  it('refuses an invited-but-not-active member', () => {
    const membership = membershipFor('organization_admin', { status: 'invited' });
    expect(authorize(membership, 'read', ownRow('property'))).toEqual({
      allowed: false,
      reason: 'membership_not_active',
    });
  });

  it('refuses a disabled member even with an administrator role', () => {
    const membership = membershipFor('organization_admin', { status: 'disabled' });
    expect(authorize(membership, 'update', ownRow('property')).allowed).toBe(false);
  });

  it('refuses every action when the organization is suspended', () => {
    const membership = membershipFor('property_manager', {
      organization: { id: ORG_A, name: 'A', slug: 'a', status: 'suspended' },
    });
    expect(authorize(membership, 'read', ownRow('property'))).toEqual({
      allowed: false,
      reason: 'organization_not_active',
    });
  });

  it('refuses an unknown resource type rather than falling through', () => {
    const decision = authorize(membershipFor('organization_admin'), 'read', {
      type: 'not_a_table' as ResourceType,
      organizationId: ORG_A,
    });
    expect(decision).toEqual({ allowed: false, reason: 'unknown_resource_type' });
  });
});

describe('column projection — what RLS cannot do', () => {
  it('limits a service provider to the tenant name', () => {
    const decision = authorize(membershipFor('service_provider'), 'read', ownRow('tenant'));
    expect(decision.allowed).toBe(true);
    expect(decision.fields).toEqual(PROVIDER_TENANT_FIELDS);
    expect(decision.fields).not.toContain('email');
    expect(decision.fields).not.toContain('phone');
  });

  it('gives staff the full projection', () => {
    expect(projectionFor(membershipFor('property_manager'), ownRow('tenant'))).toBeNull();
  });

  it('gives a tenant the full projection of their own record', () => {
    expect(projectionFor(membershipFor('tenant'), ownRow('tenant'))).toBeNull();
  });

  it('returns an empty projection — not null — when the read is denied', () => {
    expect(projectionFor(membershipFor('property_owner'), ownRow('tenant'))).toEqual([]);
  });
});

describe('append-only resources', () => {
  it('refuses update and archive on an activity even for an administrator', () => {
    for (const action of ['update', 'archive'] as Action[]) {
      expect(
        authorize(membershipFor('organization_admin'), action, ownRow('maintenance_activity'))
          .allowed,
      ).toBe(false);
    }
  });

  it("refuses a provider appending to another provider's ticket", () => {
    expect(
      authorize(membershipFor('service_provider'), 'create', foreignRow('maintenance_activity'))
        .allowed,
    ).toBe(false);
  });

  it("refuses a tenant appending to another tenant's ticket", () => {
    expect(
      authorize(membershipFor('tenant'), 'create', foreignRow('maintenance_activity')).allowed,
    ).toBe(false);
  });
});

describe('identity links must be present, not merely equal', () => {
  it('denies a tenant whose membership carries no tenant id', () => {
    const membership = membershipFor('tenant', { tenantId: null });
    expect(authorize(membership, 'read', ownRow('tenancy')).allowed).toBe(false);
  });

  it('denies a provider whose membership carries no provider id', () => {
    const membership = membershipFor('service_provider', { providerId: null });
    expect(authorize(membership, 'read', ownRow('maintenance_ticket')).allowed).toBe(false);
  });

  it('denies when the row carries no identity link at all', () => {
    // A null link on both sides must not compare equal and grant access.
    const membership = membershipFor('tenant');
    expect(
      authorize(membership, 'read', { type: 'tenancy', organizationId: ORG_A, tenantId: null })
        .allowed,
    ).toBe(false);
  });

  it('denies an owner when the property has no owner recorded', () => {
    const membership = membershipFor('property_owner', { memberId: MEMBER });
    expect(
      authorize(membership, 'read', {
        type: 'property',
        organizationId: ORG_A,
        ownerMemberId: null,
      }).allowed,
    ).toBe(false);
  });
});

describe('assertAuthorized', () => {
  it('returns the decision when permitted', () => {
    const decision = assertAuthorized(
      membershipFor('property_manager'),
      'update',
      ownRow('property'),
    );
    expect(decision.allowed).toBe(true);
  });

  it('throws AuthorizationDeniedError carrying the reason, resource and action', () => {
    try {
      assertAuthorized(membershipFor('tenant'), 'update', ownRow('property'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthorizationDeniedError);
      const denied = error as AuthorizationDeniedError;
      expect(denied.resourceType).toBe('property');
      expect(denied.action).toBe('update');
      expect(denied.reason).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
