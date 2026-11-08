/**
 * The §4 matrix rows for `tenants` and `tenancies`, as adversarial assertions.
 *
 * `lib/auth/__tests__/authorize.test.ts` already covers the matrix table-by-table. These
 * tests are narrower and more pointed: they pose the specific questions this lane's
 * acceptance criteria are written in terms of, with the identifiers of a concrete
 * fixture, so that a regression reads as "tenant two can see tenant one's record" rather
 * than as a failing cell in a grid.
 *
 * No database is involved: this is the application-space layer alone, deciding on
 * trusted inputs. `tests/rls/**` proves the Postgres layer separately. Either layer
 * failing is a defect even if the other holds — that is the premise of enforcing twice.
 */

import { describe, expect, it } from 'vitest';

import { authorize, projectionFor, type ResourceRef } from '@/lib/auth/authorize';
import { MEMBER_ROLES } from '@shared/index';

import {
  MEMBER_OTHER_OWNER,
  MEMBER_OWNER,
  ORG_A,
  ORG_B,
  PROVIDER_ONE,
  TENANT_ONE,
  TENANT_TWO,
  foreignMembership,
  membership,
} from './_support/fixtures';

const ownTenantRow: ResourceRef = { type: 'tenant', organizationId: ORG_A, tenantId: TENANT_ONE };
const neighbourTenantRow: ResourceRef = {
  type: 'tenant',
  organizationId: ORG_A,
  tenantId: TENANT_TWO,
};

describe('a tenant and another tenant’s personal data', () => {
  it('may read their own tenant record', () => {
    expect(authorize(membership('tenant'), 'read', ownTenantRow).allowed).toBe(true);
  });

  it('may NOT read the tenant record of a neighbour in the same organization', () => {
    const decision = authorize(membership('tenant'), 'read', neighbourTenantRow);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('self_tenant_only');
  });

  it('may not read a tenant record with no identity link at all', () => {
    // A list query reaches the matrix with an organization-scoped reference and no
    // `tenantId`. That must deny, which is what makes `GET /tenants` staff-only.
    expect(
      authorize(membership('tenant'), 'read', { type: 'tenant', organizationId: ORG_A }).allowed,
    ).toBe(false);
  });

  it('may not update or create a tenant record', () => {
    for (const action of ['create', 'update', 'archive', 'delete'] as const) {
      expect(authorize(membership('tenant'), action, ownTenantRow).allowed).toBe(false);
    }
  });

  it('may read their own tenancy and not a neighbour’s', () => {
    const own: ResourceRef = { type: 'tenancy', organizationId: ORG_A, tenantId: TENANT_ONE };
    const neighbour: ResourceRef = { type: 'tenancy', organizationId: ORG_A, tenantId: TENANT_TWO };

    expect(authorize(membership('tenant'), 'read', own).allowed).toBe(true);
    expect(authorize(membership('tenant'), 'read', neighbour).allowed).toBe(false);
  });
});

describe('a service provider and tenant contact details', () => {
  const assigned: ResourceRef = {
    type: 'tenant',
    organizationId: ORG_A,
    providerId: PROVIDER_ONE,
  };

  it('reads an assigned ticket’s tenant, projected to the name', () => {
    const decision = authorize(membership('service_provider'), 'read', assigned);

    expect(decision.allowed).toBe(true);
    expect(decision.fields).toBeDefined();
    expect(decision.fields).not.toContain('email');
    expect(decision.fields).not.toContain('phone');
  });

  it('reads nothing when the ticket is not theirs', () => {
    const someoneElses: ResourceRef = {
      type: 'tenant',
      organizationId: ORG_A,
      providerId: '44444444-0000-4000-8000-0000000000ff',
    };

    expect(authorize(membership('service_provider'), 'read', someoneElses).allowed).toBe(false);
  });

  it('has no access to tenancies in any operation', () => {
    const tenancy: ResourceRef = {
      type: 'tenancy',
      organizationId: ORG_A,
      providerId: PROVIDER_ONE,
      tenantId: TENANT_ONE,
    };

    for (const action of ['read', 'create', 'update', 'archive', 'delete'] as const) {
      expect(authorize(membership('service_provider'), action, tenancy).allowed).toBe(false);
    }
  });
});

describe('a property owner', () => {
  it('has no access to tenant records — the matrix cell is a dash', () => {
    for (const action of ['read', 'create', 'update', 'archive'] as const) {
      expect(authorize(membership('property_owner'), action, ownTenantRow).allowed).toBe(false);
    }
  });

  it('reads a tenancy on a property they own', () => {
    const decision = authorize(membership('property_owner'), 'read', {
      type: 'tenancy',
      organizationId: ORG_A,
      ownerMemberId: MEMBER_OWNER,
    });

    expect(decision.allowed).toBe(true);
  });

  it('does not read a tenancy on a property owned by somebody else', () => {
    const decision = authorize(membership('property_owner'), 'read', {
      type: 'tenancy',
      organizationId: ORG_A,
      ownerMemberId: MEMBER_OTHER_OWNER,
    });

    expect(decision.allowed).toBe(false);
  });

  it('cannot be handed the embedded tenant, so a lease read leaks no contact details', () => {
    // This is what `loadEmbeddedTenant` keys off: a projection that is not `null` means
    // the full record is not available, and the embed is omitted.
    const projection = projectionFor(membership('property_owner'), ownTenantRow);

    expect(projection).toEqual([]);
  });

  it('may not write a tenancy', () => {
    for (const action of ['create', 'update', 'archive'] as const) {
      expect(
        authorize(membership('property_owner'), action, {
          type: 'tenancy',
          organizationId: ORG_A,
          ownerMemberId: MEMBER_OWNER,
        }).allowed,
      ).toBe(false);
    }
  });
});

describe('the cross-organization boundary', () => {
  it('denies every role a tenant record in another organization', () => {
    for (const role of MEMBER_ROLES) {
      const decision = authorize(membership(role), 'read', {
        type: 'tenant',
        organizationId: ORG_B,
        tenantId: TENANT_ONE,
        providerId: PROVIDER_ONE,
        ownerMemberId: MEMBER_OWNER,
      });

      expect(decision.allowed, `role ${role}`).toBe(false);
      expect(decision.reason, `role ${role}`).toBe('cross_organization');
    }
  });

  it('denies every role a tenancy in another organization', () => {
    for (const role of MEMBER_ROLES) {
      const decision = authorize(membership(role), 'read', {
        type: 'tenancy',
        organizationId: ORG_B,
        tenantId: TENANT_ONE,
        ownerMemberId: MEMBER_OWNER,
      });

      expect(decision.allowed, `role ${role}`).toBe(false);
    }
  });

  it('denies a staff write across the boundary', () => {
    for (const action of ['create', 'update'] as const) {
      expect(
        authorize(membership('organization_admin'), action, {
          type: 'tenancy',
          organizationId: ORG_B,
        }).allowed,
      ).toBe(false);
    }
  });

  it('denies the identical membership in the other direction', () => {
    // The same person, seen as a member of organization B, reading organization A's row.
    const decision = authorize(foreignMembership('property_manager'), 'read', {
      type: 'tenant',
      organizationId: ORG_A,
      tenantId: TENANT_ONE,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('cross_organization');
  });
});

describe('membership and organization status', () => {
  it('refuses a disabled member who still holds the right role', () => {
    const disabled = membership('property_manager', { status: 'disabled' });

    expect(authorize(disabled, 'read', ownTenantRow).reason).toBe('membership_not_active');
  });

  it('refuses an invited-but-not-accepted member', () => {
    const invited = membership('property_manager', { status: 'invited' });

    expect(authorize(invited, 'read', ownTenantRow).allowed).toBe(false);
  });

  it('refuses a member of a suspended organization', () => {
    const suspended = membership('property_manager', {
      organization: { id: ORG_A, name: 'Organization A', slug: 'org-a', status: 'suspended' },
    });

    expect(authorize(suspended, 'read', ownTenantRow).reason).toBe('organization_not_active');
  });
});

describe('deletion', () => {
  it('is refused for every role on both of this lane’s tables', () => {
    for (const role of MEMBER_ROLES) {
      for (const type of ['tenant', 'tenancy'] as const) {
        const decision = authorize(membership(role), 'delete', {
          type,
          organizationId: ORG_A,
          tenantId: TENANT_ONE,
          ownerMemberId: MEMBER_OWNER,
          providerId: PROVIDER_ONE,
        });

        expect(decision.allowed, `${role}/${type}`).toBe(false);
        expect(decision.reason).toBe('delete_never_permitted');
      }
    }
  });
});
