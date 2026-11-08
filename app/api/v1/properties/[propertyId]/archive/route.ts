/**
 * `POST /api/v1/properties/{propertyId}/archive`
 *
 * The explicit archive path. CLAUDE.md rule 6 forbids a DELETE on any tenant-scoped
 * table, and this database enforces it below the policy layer: `authenticated` holds the
 * DELETE privilege on no table at all, so a `DELETE` handler would fail with `42501`
 * rather than quietly matching zero rows.
 *
 * It is a `POST` rather than a `PATCH` with `{"status":"archived"}` — which also works,
 * and is what `UpdatePropertySchema` is for — so that "removal" has a named route, its own
 * audit verb (`property_archived`) and its own test. A destructive-looking action buried
 * in a conditional inside a general-purpose `PATCH` is harder to audit than one with a URL.
 *
 * Idempotent: archiving an archived property returns 200 with the row unchanged. A second
 * click must not be a 409.
 */

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { archiveProperty } from '@/features/properties/service';
import { PropertyPathParamsSchema, STAFF_ROLES } from '@shared/index';

export const POST = withApiHandler(
  {
    roles: STAFF_ROLES,
    audit: { action: 'property_archived', entityType: 'property' },
  },
  async (ctx) => {
    const { propertyId } = PropertyPathParamsSchema.parse(ctx.params);
    const property = await archiveProperty(ctx.supabase, ctx.membership, propertyId);

    ctx.audit({
      entityId: property.id,
      metadata: { property_id: property.id, status: property.status },
    });

    return ok(property, ctx.requestId);
  },
);
