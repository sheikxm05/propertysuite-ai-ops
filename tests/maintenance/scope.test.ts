/**
 * Role filtering on the ticket list — acceptance criteria 2 and 7, server-side.
 *
 * `ticketListScope()` is pure, so these are the strongest tests in the lane: they
 * enumerate what every role's query carries without a database, a session or a network
 * round trip. The equivalent RLS claims are proven against a real Postgres by
 * `tests/rls/role-scoping.test.ts`; this file proves the second layer, which must hold
 * on the assumption that the first one has a bug.
 *
 * The invariant asserted for every role, first: `organization_id` is always pinned, and
 * always to the value from trusted membership. That is the single predicate standing
 * between organization A and organization B in application space.
 */

import { describe, expect, it } from 'vitest';
import { MEMBER_ROLES, TICKET_STATUSES } from '@shared/index';

import { PROVIDER_JOB_STATUSES, ticketListScope } from '@/features/maintenance/domain';

import {
  ORG_A,
  ORG_B,
  OTHER_PROVIDER_ID,
  PROPERTY_ID,
  PROVIDER_ID,
  TENANT_ID,
  membershipFor,
} from './_support/fixtures';

describe('organization scoping holds for every role', () => {
  for (const role of MEMBER_ROLES) {
    it(`${role} is pinned to their own organization`, () => {
      const scope = ticketListScope(membershipFor(role), {});
      expect(scope.equals.organization_id).toBe(ORG_A);
    });

    it(`${role} cannot reach another organization by asking`, () => {
      // There is no parameter through which a caller could supply an organization: the
      // query schema has no such field and the function's only other input is the
      // membership. This asserts the consequence — the pinned value follows the
      // MEMBERSHIP, not anything a request could contain.
      const scope = ticketListScope(membershipFor(role, { organizationId: ORG_B }), {});
      expect(scope.equals.organization_id).toBe(ORG_B);
    });
  }
});

describe('a service_provider sees only assigned work', () => {
  it('pins assigned_provider_id to their own provider record', () => {
    const scope = ticketListScope(membershipFor('service_provider'), {});
    expect(scope.equals.assigned_provider_id).toBe(PROVIDER_ID);
  });

  it('pins it from membership even when the query agrees', () => {
    // Asking for your own id must not be the reason the filter is right. The value comes
    // from membership either way, so a future widening of the query schema cannot
    // become a widening of the scope.
    const scope = ticketListScope(membershipFor('service_provider'), {
      assigned_provider_id: PROVIDER_ID,
    });
    expect(scope.equals.assigned_provider_id).toBe(PROVIDER_ID);
    expect(scope.impossible).toBe(false);
  });

  it('returns an empty page — not an error — for another provider’s queue', () => {
    const scope = ticketListScope(membershipFor('service_provider'), {
      assigned_provider_id: OTHER_PROVIDER_ID,
    });
    expect(scope.impossible).toBe(true);
    expect(scope.reason).toBe('provider_requested_another_queue');
    // An error would confirm the other provider exists. An empty page discloses nothing.
    expect(scope.statusIn).toEqual([]);
  });

  it('restricts the status set to the three statuses its edges touch', () => {
    const scope = ticketListScope(membershipFor('service_provider'), {});
    expect(scope.statusIn).toEqual(PROVIDER_JOB_STATUSES);
  });

  it('serves an empty page for a status outside that subset', () => {
    for (const status of TICKET_STATUSES.filter((s) => !PROVIDER_JOB_STATUSES.includes(s))) {
      const scope = ticketListScope(membershipFor('service_provider'), { status });
      expect(scope.impossible).toBe(true);
      expect(scope.reason).toBe('provider_requested_unpermitted_status');
    }
  });

  it('honours a status inside the subset', () => {
    const scope = ticketListScope(membershipFor('service_provider'), { status: 'in_progress' });
    expect(scope.impossible).toBe(false);
    expect(scope.statusIn).toEqual(['in_progress']);
  });

  it('serves an empty page when they hold no provider record in this organization', () => {
    const scope = ticketListScope(membershipFor('service_provider', { providerId: null }), {});
    expect(scope.impossible).toBe(true);
    expect(scope.reason).toBe('provider_without_provider_record');
    // Crucially, no `assigned_provider_id` filter was set to `undefined` or `null`,
    // which in PostgREST would have matched rows rather than none.
    expect(scope.equals.assigned_provider_id).toBeUndefined();
  });
});

describe('a tenant sees only their own reports', () => {
  it('pins tenant_id from membership', () => {
    const scope = ticketListScope(membershipFor('tenant'), {});
    expect(scope.equals.tenant_id).toBe(TENANT_ID);
  });

  it('serves an empty page when they hold no tenant record', () => {
    const scope = ticketListScope(membershipFor('tenant', { tenantId: null }), {});
    expect(scope.impossible).toBe(true);
    expect(scope.reason).toBe('tenant_without_tenant_record');
    expect(scope.equals.tenant_id).toBeUndefined();
  });

  it('cannot widen to another tenant, because no such filter exists', () => {
    const scope = ticketListScope(membershipFor('tenant'), { property_id: PROPERTY_ID });
    expect(scope.equals.tenant_id).toBe(TENANT_ID);
    expect(scope.equals.property_id).toBe(PROPERTY_ID);
  });
});

describe('staff and owners', () => {
  for (const role of ['organization_admin', 'property_manager'] as const) {
    it(`${role} is scoped to the organization and nothing narrower`, () => {
      const scope = ticketListScope(membershipFor(role), {});
      expect(Object.keys(scope.equals)).toEqual(['organization_id']);
      expect(scope.statusIn).toBeNull();
    });
  }

  it('a property_owner gets no extra equality predicate — ownership is a join in RLS', () => {
    const scope = ticketListScope(membershipFor('property_owner'), {});
    expect(Object.keys(scope.equals)).toEqual(['organization_id']);
    expect(scope.reason).toBe('owner_scope_via_rls');
  });
});

describe('facets pass through for the roles entitled to them', () => {
  it('applies status, priority, category, property and unit filters', () => {
    const scope = ticketListScope(membershipFor('property_manager'), {
      status: 'awaiting_approval',
      priority: 'urgent',
      category: 'hvac',
      property_id: PROPERTY_ID,
      property_unit_id: '44444444-4444-4444-8444-444444444444',
    });
    expect(scope.statusIn).toEqual(['awaiting_approval']);
    expect(scope.equals.priority).toBe('urgent');
    expect(scope.equals.category).toBe('hvac');
    expect(scope.equals.property_id).toBe(PROPERTY_ID);
    expect(scope.equals.property_unit_id).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('never puts an undefined value into a filter', () => {
    // A filter whose value is `undefined` serialises to an empty string in PostgREST and
    // matches the wrong thing. No absent facet may become a predicate.
    for (const role of MEMBER_ROLES) {
      const scope = ticketListScope(membershipFor(role), {});
      for (const value of Object.values(scope.equals)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('a suspended or disabled membership is still scoped', () => {
  it('does not widen for a disabled member', () => {
    // `authorize()` refuses a non-active membership outright before the matrix, so this
    // asserts the scope does not accidentally become permissive on the way there.
    const scope = ticketListScope(membershipFor('tenant', { status: 'disabled' }), {});
    expect(scope.equals.organization_id).toBe(ORG_A);
    expect(scope.equals.tenant_id).toBe(TENANT_ID);
  });
});
