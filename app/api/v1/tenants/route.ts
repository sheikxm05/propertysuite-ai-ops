/**
 * `/api/v1/tenants` — list and create tenant records. Lane w1-l3.
 *
 * Both methods are staff-only. The `roles` gate below is the coarse first refusal;
 * `features/tenants/server/tenant-service.ts` asserts the §4 matrix again with
 * `assertAuthorized`, and `0002`'s `tenants_select_staff` / `tenants_insert_staff`
 * policies refuse a third time inside Postgres. A `property_owner` has no cell on this
 * table, a `tenant` reads only their own row (so has no list), and a
 * `service_provider` reaches a single tenant by name through
 * `/api/v1/tenants/{tenantId}` and never through a list.
 *
 * There is no DELETE export here or in any route in this lane. A tenant record is
 * referenced by tenancies, tickets and audit rows, and `0002` revokes the DELETE
 * privilege from `authenticated` outright (CLAUDE.md rule 6).
 */

import {
  CreateTenantSchema,
  ListTenantsQuerySchema,
  TenantListResponseSchema,
} from '@shared/index';

import { created, jsonResponse } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { pageBody } from '@/features/tenants/server/context';
import { createTenant, listTenants } from '@/features/tenants/server/tenant-service';

/** Staff. Transcribed from the §4 matrix row for `tenants`: admin RW, manager RW. */
const STAFF_ROLES = ['organization_admin', 'property_manager'] as const;

export const GET = withApiHandler(
  { roles: STAFF_ROLES, querySchema: ListTenantsQuerySchema },
  async (ctx) => {
    const page = await listTenants(
      { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
      ctx.query,
    );

    // Amendment A18: the list envelope is `{ data, page_info }` from
    // `packages/shared`, not `paginated()`'s `{ data, next_cursor }`. Emitted through
    // `jsonResponse` until w0-l5 updates `paginated()`, so the `cache-control: no-store`
    // and `X-Request-Id` discipline still applies — this route never builds a `Response`.
    // `TenantListResponseSchema` is `.strict()` at both levels, so it is also the last
    // guard that no unexpected column reaches the wire from this table.
    return jsonResponse(TenantListResponseSchema.parse(pageBody(page)), ctx.requestId);
  },
);

export const POST = withApiHandler(
  {
    roles: STAFF_ROLES,
    bodySchema: CreateTenantSchema,
    audit: { action: 'tenant_created', entityType: 'tenant' },
  },
  async (ctx) => {
    const tenant = await createTenant(
      { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger },
      ctx.body,
    );

    // Identifiers only. `full_name`, `email` and `phone` are not on the logger's
    // allowlist and must never reach an audit row — the trail would become a second,
    // less guarded copy of the personal data it describes (CLAUDE.md rule 8).
    ctx.audit({
      entityId: tenant.id,
      metadata: { tenant_id: tenant.id, profile_id: tenant.profile_id },
    });

    return created(tenant, ctx.requestId, { location: `/api/v1/tenants/${tenant.id}` });
  },
);
