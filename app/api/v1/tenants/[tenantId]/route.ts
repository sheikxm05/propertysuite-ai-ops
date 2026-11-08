/**
 * `/api/v1/tenants/{tenantId}` — read and update one tenant record. Lane w1-l3.
 *
 * THE COLUMN PROJECTION LIVES HERE, NOT IN RLS.
 * `GET` is reachable by four roles and returns two different shapes. The §4 matrix gives
 * a `service_provider` "tenant name only, via assignment", and `0002`'s
 * `tenants_select_provider_assigned` correctly grants the *row* to a provider holding an
 * assigned ticket — a row-level policy cannot withhold a column. So the response shape is
 * decided by `projectionFor()` inside the service: a provider's query selects
 * `PROVIDER_TENANT_FIELDS` and serialises through `TenantNameSchema`, and the email and
 * phone columns are never fetched at all. Widen that `select` and the acceptance
 * criterion "a tenant's personal data is not exposed" fails while every RLS test still
 * passes.
 *
 * `PATCH` is staff-only and has no `status`, `organization_id` or `id` field to write —
 * `UpdateTenantSchema` is `.strict()`, so posting one is a 400 rather than a silently
 * ignored key.
 */

import { TenantPathParamsSchema, UpdateTenantSchema } from '@shared/index';

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { getTenantById, updateTenant } from '@/features/tenants/server/tenant-service';

/**
 * Every role with a cell on `tenants`. `property_owner` is absent: the matrix gives them
 * a dash on this table, so they are refused before the handler runs.
 */
const READ_ROLES = [
  'organization_admin',
  'property_manager',
  'tenant',
  'service_provider',
] as const;

const STAFF_ROLES = ['organization_admin', 'property_manager'] as const;

export const GET = withApiHandler({ roles: READ_ROLES }, async (ctx) => {
  const { tenantId } = TenantPathParamsSchema.parse(ctx.params);

  const view = await getTenantById(
    { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
    tenantId,
  );

  ctx.logger.info('tenant read', {
    entity_type: 'tenant',
    entity_id: tenantId,
    // Which of the two shapes was served. An enum-valued fact, so it is safe to log and
    // makes a projection regression visible in the logs rather than only in a test.
    operation: view.kind === 'name_only' ? 'tenant_read_name_only' : 'tenant_read_full',
  });

  return ok(view.tenant, ctx.requestId);
});

export const PATCH = withApiHandler(
  {
    roles: STAFF_ROLES,
    bodySchema: UpdateTenantSchema,
    audit: { action: 'tenant_updated', entityType: 'tenant' },
  },
  async (ctx) => {
    const { tenantId } = TenantPathParamsSchema.parse(ctx.params);

    const tenant = await updateTenant(
      { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
      tenantId,
      ctx.body,
    );

    // The *names* of the changed fields, never their values. `count` and `tenant_id` are
    // allowlisted; a bag of before/after values would not be, and would be the wrong
    // thing to keep forever even if it were.
    ctx.audit({
      entityId: tenant.id,
      metadata: { tenant_id: tenant.id, count: Object.keys(ctx.body).length },
    });

    return ok(tenant, ctx.requestId);
  },
);
