/**
 * `/api/v1/tenancies/{tenancyId}` — read and update one tenancy. Lane w1-l3.
 *
 * `GET` returns `TenancyDetailSchema`, whose `unit` and `tenant` embeds are **authorized
 * separately from the tenancy**. The §4 matrix gives a `property_owner` `R owned` on
 * `tenancies` and a dash on `tenants`, so an owner reading a lease on their own building
 * receives the dates and the rent and no contact details. Embedding unconditionally
 * would have leaked every tenant's email and phone through a route that looks like it is
 * only about leases.
 *
 * `PATCH` carries the lifecycle. `draft → active → expired | terminated` is checked by
 * `assertTenancyTransition` — an illegal edge is a 409, per `docs/api-contracts.md` — and
 * every edge taken writes its own `tenancy_status_changed` audit row with `from_status`
 * and `to_status`, in addition to the wrapper's `tenancy_updated`. Unlike the ticket
 * machine there is no database trigger behind this edge set, which is exactly why the
 * server-side check is not optional.
 *
 * The unit and the tenant are not patchable: re-letting a unit or substituting a tenant
 * is a new tenancy, not an edit, and the maintenance history already references the old
 * one. `UpdateTenancySchema` omits both and is `.strict()`.
 */

import { TenancyPathParamsSchema, UpdateTenancySchema } from '@shared/index';

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { getTenancyById, updateTenancy } from '@/features/tenancies/server/tenancy-service';

const READ_ROLES = ['organization_admin', 'property_manager', 'property_owner', 'tenant'] as const;

const STAFF_ROLES = ['organization_admin', 'property_manager'] as const;

export const GET = withApiHandler({ roles: READ_ROLES }, async (ctx) => {
  const { tenancyId } = TenancyPathParamsSchema.parse(ctx.params);

  const tenancy = await getTenancyById(
    { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
    tenancyId,
  );

  return ok(tenancy, ctx.requestId);
});

export const PATCH = withApiHandler(
  {
    roles: STAFF_ROLES,
    bodySchema: UpdateTenancySchema,
    audit: { action: 'tenancy_updated', entityType: 'tenancy' },
  },
  async (ctx) => {
    const { tenancyId } = TenancyPathParamsSchema.parse(ctx.params);

    const result = await updateTenancy(
      { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
      tenancyId,
      ctx.body,
    );

    ctx.audit({
      entityId: result.tenancy.id,
      metadata: {
        tenancy_id: result.tenancy.id,
        tenant_id: result.tenancy.tenant_id,
        unit_id: result.tenancy.property_unit_id,
        from_status: result.transition?.from ?? null,
        to_status: result.transition?.to ?? null,
        count: Object.keys(ctx.body).length,
      },
    });

    return ok(result.tenancy, ctx.requestId);
  },
);
