/**
 * `/api/v1/tenancies` — list and create tenancies. Lane w1-l3, contract in
 * `docs/api-contracts.md`.
 *
 * `GET` is the tenant self-service read as well as the manager's register. A tenant
 * calling it sees exactly their own tenancies: `tenancyReadScope()` pins `tenant_id` to
 * the membership's `tenants.id` — which `resolveMembership()` derived from
 * `tenants.profile_id = <verified session>` — and `0002`'s `tenancies_select_own` pins it
 * again in Postgres. Passing another tenant's `?tenant_id=` narrows nothing and returns
 * their own rows rather than a 403, because a denial would confirm that the identifier
 * they guessed names a real tenant.
 *
 * `POST` is staff-only and enforces the rule no migration holds: a unit may not have two
 * overlapping ACTIVE tenancies.
 */

import {
  CreateTenancySchema,
  ListTenanciesQuerySchema,
  TenancyListResponseSchema,
} from '@shared/index';

import { created, jsonResponse } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { pageBody } from '@/features/tenants/server/context';
import { createTenancy, listTenancies } from '@/features/tenancies/server/tenancy-service';

/**
 * §4 matrix row for `tenancies`: admin RW, manager RW, owner R owned, tenant R own,
 * provider —. The provider's absence is the gate; the other four are narrowed per row.
 */
const READ_ROLES = ['organization_admin', 'property_manager', 'property_owner', 'tenant'] as const;

const STAFF_ROLES = ['organization_admin', 'property_manager'] as const;

export const GET = withApiHandler(
  { roles: READ_ROLES, querySchema: ListTenanciesQuerySchema },
  async (ctx) => {
    const page = await listTenancies(
      { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
      ctx.query,
    );

    // Amendment A18 — see the note on `GET /api/v1/tenants`. `has_more` matters most on
    // exactly this route: a tenant's page is one or two rows out of an organization's
    // hundreds, so "short page" says nothing about whether more follow.
    return jsonResponse(TenancyListResponseSchema.parse(pageBody(page)), ctx.requestId);
  },
);

export const POST = withApiHandler(
  {
    roles: STAFF_ROLES,
    bodySchema: CreateTenancySchema,
    audit: { action: 'tenancy_created', entityType: 'tenancy' },
  },
  async (ctx) => {
    const result = await createTenancy(
      { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
      ctx.body,
    );

    // `rent_amount` and `contract_number` are deliberately absent: personal financial
    // data does not belong in an append-only trail that an organization administrator
    // can read forever. The identifiers and the lifecycle status are enough to
    // reconstruct what happened from the tenancy row itself.
    ctx.audit({
      entityId: result.tenancy.id,
      metadata: {
        tenancy_id: result.tenancy.id,
        tenant_id: result.tenancy.tenant_id,
        unit_id: result.tenancy.property_unit_id,
        to_status: result.tenancy.status,
        status: result.unitStatus,
      },
    });

    return created(result.tenancy, ctx.requestId, {
      location: `/api/v1/tenancies/${result.tenancy.id}`,
    });
  },
);
