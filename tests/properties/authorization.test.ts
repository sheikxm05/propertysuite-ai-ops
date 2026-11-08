/**
 * Application-space authorization for properties and units.
 *
 * `authorize()` from `lib/auth/authorize.ts` is the real implementation throughout — this
 * suite exercises the §4 matrix as written, through the reference builders this lane adds
 * on top of it. Nothing is mocked.
 *
 * The central claim is the one in the header of `features/properties/authorization.ts`:
 * a tenant or a provider is granted a property **only** when the scope proves a path to
 * that specific row. A builder that unconditionally copied `membership.tenantId` into the
 * reference would make every matrix check trivially true and leave RLS as the only
 * enforcement — so the first `describe` below exists to catch exactly that regression.
 */

import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError, authorize } from '@/lib/auth/authorize';
import {
  OWNER_ASSOCIABLE_ROLES,
  assertOwnerAssociable,
  assertVisible,
  assertWritable,
  isVisible,
  propertyRef,
  scopedPropertyIds,
  scopedUnitIds,
  unitRef,
  type VisibilityScope,
} from '@/features/properties/authorization';
import { MEMBER_ROLES } from '@shared/index';

import {
  ADMIN_A,
  IDS,
  MANAGER_A,
  ORG_B,
  OWNER_A,
  PROVIDER_A,
  TENANT_A,
  memberRow,
  membership,
  propertyRow,
  unitRow,
} from './support/world';

const ALL: VisibilityScope = { kind: 'all' };
const OWNED: VisibilityScope = { kind: 'owned', ownerMemberId: IDS.a.owner.member };
const LEASED: VisibilityScope = {
  kind: 'tenancy',
  propertyIds: [IDS.a.p1],
  unitIds: [IDS.a.p1u1],
};
const ASSIGNED: VisibilityScope = {
  kind: 'assignment',
  propertyIds: [IDS.a.p1],
  unitIds: [IDS.a.p1u1],
};
const NOTHING: VisibilityScope = { kind: 'none', reason: 'caller_has_no_tenant_record' };

describe('a reference only claims a path the scope proved', () => {
  it('fills tenantId for a property inside the tenancy scope', () => {
    const ref = propertyRef(propertyRow({ id: IDS.a.p1 }), TENANT_A, LEASED);
    expect(ref.tenantId).toBe(TENANT_A.tenantId);
    expect(ref.providerId).toBeNull();
  });

  it('leaves tenantId null for a property OUTSIDE the tenancy scope', () => {
    // P2 is in the same organization and the caller is a legitimate tenant of P1. This is
    // the regression that matters: if the builder copied `membership.tenantId` in
    // unconditionally, `authorize()` would allow this and only RLS would stop it.
    const ref = propertyRef(propertyRow({ id: IDS.a.p2 }), TENANT_A, LEASED);
    expect(ref.tenantId).toBeNull();
    expect(authorize(TENANT_A, 'read', ref).allowed).toBe(false);
  });

  it('fills providerId only for a property behind an assigned ticket', () => {
    expect(propertyRef(propertyRow({ id: IDS.a.p1 }), PROVIDER_A, ASSIGNED).providerId).toBe(
      PROVIDER_A.providerId,
    );
    expect(propertyRef(propertyRow({ id: IDS.a.p2 }), PROVIDER_A, ASSIGNED).providerId).toBeNull();
  });

  it('never cross-wires a tenant scope into a provider claim, or the reverse', () => {
    // A tenancy scope must not populate `providerId` even for a reachable row, because the
    // matrix cells are different grants with different justifications.
    expect(propertyRef(propertyRow(), TENANT_A, LEASED).providerId).toBeNull();
    expect(propertyRef(propertyRow(), PROVIDER_A, ASSIGNED).tenantId).toBeNull();
  });

  it('grants nothing under the `none` scope', () => {
    const ref = propertyRef(propertyRow(), TENANT_A, NOTHING);
    expect(ref.tenantId).toBeNull();
    expect(isVisible(TENANT_A, ref)).toBe(false);
  });

  it('takes a unit owner from the parent property, since a unit row has no owner column', () => {
    const ref = unitRef(unitRow(), IDS.a.owner.member, OWNER_A, OWNED);
    expect(ref.ownerMemberId).toBe(IDS.a.owner.member);
    expect(isVisible(OWNER_A, ref)).toBe(true);

    const unowned = unitRef(unitRow(), null, OWNER_A, OWNED);
    expect(isVisible(OWNER_A, unowned)).toBe(false);
  });

  it('exposes the id restriction only for the two scoped roles', () => {
    expect(scopedPropertyIds(ALL)).toBeNull();
    expect(scopedPropertyIds(OWNED)).toBeNull();
    expect(scopedPropertyIds(LEASED)).toEqual([IDS.a.p1]);
    expect(scopedUnitIds(ASSIGNED)).toEqual([IDS.a.p1u1]);
  });
});

describe('read visibility per role', () => {
  it('lets staff read any property in their own organization', () => {
    for (const staff of [ADMIN_A, MANAGER_A]) {
      expect(isVisible(staff, propertyRef(propertyRow({ id: IDS.a.p2 }), staff, ALL))).toBe(true);
    }
  });

  it('lets an owner read only the property recorded against their membership', () => {
    expect(isVisible(OWNER_A, propertyRef(propertyRow(), OWNER_A, OWNED))).toBe(true);
    expect(
      isVisible(OWNER_A, propertyRef(propertyRow({ owner_member_id: null }), OWNER_A, OWNED)),
    ).toBe(false);
    expect(
      isVisible(
        OWNER_A,
        propertyRef(propertyRow({ owner_member_id: IDS.a.manager.member }), OWNER_A, OWNED),
      ),
    ).toBe(false);
  });

  it('refuses a cross-organization row for every role, before any per-role rule', () => {
    const foreign = propertyRow({ id: IDS.b.p1, organization_id: ORG_B });

    for (const role of MEMBER_ROLES) {
      const caller = membership({
        role,
        tenantId: IDS.a.tenant.tenant,
        providerId: IDS.a.provider.provider,
      });
      // Even with a scope that (wrongly) lists the foreign id as reachable.
      const generous: VisibilityScope = {
        kind: 'tenancy',
        propertyIds: [IDS.b.p1],
        unitIds: [IDS.b.p1u1],
      };
      const decision = authorize(caller, 'read', propertyRef(foreign, caller, generous));
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('cross_organization');
    }
  });

  it('refuses a disabled member and a suspended organization', () => {
    const disabled = membership({ role: 'property_manager', status: 'disabled' });
    expect(isVisible(disabled, propertyRef(propertyRow(), disabled, ALL))).toBe(false);

    const suspended = membership({ role: 'property_manager', organizationStatus: 'suspended' });
    expect(isVisible(suspended, propertyRef(propertyRow(), suspended, ALL))).toBe(false);
  });
});

describe('assertVisible answers a denied read with 404, never 403', () => {
  it('raises NOT_FOUND for a cross-organization property', () => {
    const foreign = propertyRow({ id: IDS.b.p1, organization_id: ORG_B });
    try {
      assertVisible(MANAGER_A, propertyRef(foreign, MANAGER_A, ALL));
      throw new Error('expected assertVisible to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      const api = error as ApiRouteError;
      // A 403 would confirm the row exists. "Absent or inaccessible" must be one answer.
      expect(api.code).toBe('NOT_FOUND');
      expect(api.status).toBe(404);
      expect(api.publicMessage).not.toContain('organization');
      // The distinguishing reason goes to the log only.
      expect(api.logFields.reason).toBe('cross_organization');
    }
  });

  it('raises NOT_FOUND for a same-organization property the caller cannot reach', () => {
    try {
      assertVisible(TENANT_A, propertyRef(propertyRow({ id: IDS.a.p2 }), TENANT_A, LEASED));
      throw new Error('expected assertVisible to throw');
    } catch (error) {
      expect((error as ApiRouteError).code).toBe('NOT_FOUND');
    }
  });
});

describe('write permission per role', () => {
  const actions = ['create', 'update', 'archive'] as const;

  it.each(actions)('lets a manager %s a property', (action) => {
    expect(() =>
      assertWritable(MANAGER_A, action, propertyRef(propertyRow(), MANAGER_A, ALL)),
    ).not.toThrow();
  });

  it.each(actions)('lets an admin %s a property', (action) => {
    expect(() =>
      assertWritable(ADMIN_A, action, propertyRef(propertyRow(), ADMIN_A, ALL)),
    ).not.toThrow();
  });

  it.each(actions)('refuses a property owner %s — the owner is read-only', (action) => {
    expect(() =>
      assertWritable(OWNER_A, action, propertyRef(propertyRow(), OWNER_A, OWNED)),
    ).toThrow(AuthorizationDeniedError);
  });

  it.each(actions)('refuses a tenant %s', (action) => {
    expect(() =>
      assertWritable(TENANT_A, action, propertyRef(propertyRow(), TENANT_A, LEASED)),
    ).toThrow(AuthorizationDeniedError);
  });

  it.each(actions)('refuses a provider %s', (action) => {
    expect(() =>
      assertWritable(PROVIDER_A, action, propertyRef(propertyRow(), PROVIDER_A, ASSIGNED)),
    ).toThrow(AuthorizationDeniedError);
  });

  it('refuses the same writes on a unit, including for the owner of its property', () => {
    for (const action of actions) {
      expect(() =>
        assertWritable(MANAGER_A, action, unitRef(unitRow(), IDS.a.owner.member, MANAGER_A, ALL)),
      ).not.toThrow();

      expect(() =>
        assertWritable(OWNER_A, action, unitRef(unitRow(), IDS.a.owner.member, OWNER_A, OWNED)),
      ).toThrow(AuthorizationDeniedError);
    }
  });
});

describe('delete is refused for every role on both tables — archive is the only removal', () => {
  it.each(MEMBER_ROLES)('refuses delete for %s', (role) => {
    const caller = membership({ role });
    for (const type of ['property', 'property_unit'] as const) {
      const decision = authorize(caller, 'delete', {
        type,
        organizationId: caller.organization.id,
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('delete_never_permitted');
    }
  });
});

describe('owner association', () => {
  it('excludes tenant and service_provider, and includes the other three', () => {
    // `owns_property()` grants property-wide SELECT to whoever holds the named membership
    // and checks only that it is active — so a tenant named here would inherit
    // owner-scoped visibility of every unit and tenancy in their own building.
    expect([...OWNER_ASSOCIABLE_ROLES].sort()).toEqual(
      ['organization_admin', 'property_manager', 'property_owner'].sort(),
    );
    expect(OWNER_ASSOCIABLE_ROLES).not.toContain('tenant');
    expect(OWNER_ASSOCIABLE_ROLES).not.toContain('service_provider');
  });

  it('is a projection of MEMBER_ROLES, not a second copy of it', () => {
    for (const role of OWNER_ASSOCIABLE_ROLES) {
      expect(MEMBER_ROLES).toContain(role);
    }
  });

  it('accepts an active associable member of the caller’s own organization', () => {
    expect(() => assertOwnerAssociable(MANAGER_A, memberRow())).not.toThrow();
  });

  it.each([
    ['an absent membership', null, 'owner_member_not_found'],
    [
      'a membership in another organization',
      memberRow({ organization_id: ORG_B }),
      'owner_member_cross_organization',
    ],
    ['an inactive membership', memberRow({ status: 'invited' }), 'owner_member_not_active'],
    ['a tenant', memberRow({ role: 'tenant' }), 'owner_member_role_not_associable'],
    [
      'a service provider',
      memberRow({ role: 'service_provider' }),
      'owner_member_role_not_associable',
    ],
  ])('refuses %s with UNPROCESSABLE 422', (_label, candidate, reason) => {
    try {
      assertOwnerAssociable(MANAGER_A, candidate);
      throw new Error('expected assertOwnerAssociable to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      const api = error as ApiRouteError;
      expect(api.code).toBe('UNPROCESSABLE');
      expect(api.status).toBe(422);
      expect(api.logFields.reason).toBe(reason);
    }
  });
});
