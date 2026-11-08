/**
 * `GET /api/v1/properties/{propertyId}` and `PATCH /api/v1/properties/{propertyId}`
 *
 * Per `docs/api-contracts.md`. The path parameter is validated with
 * `PropertyPathParamsSchema` from `@shared/index` rather than trusted as a string: a
 * non-UUID segment must be a 400 from the schema, not a `22P02` from Postgres surfaced as
 * a 500. `ctx.params` is the awaited, flattened route segments added to the frozen §5.2
 * context by amendment A13.
 *
 * `PATCH` carries archiving, because `UpdatePropertySchema` includes `status` and
 * `PROPERTY_STATUSES` contains no destructive value. `status: 'archived'` is authorized as
 * the `archive` action rather than as `update`; `POST .../archive` is the explicit
 * equivalent for the UI.
 */

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { getProperty, updateProperty } from '@/features/properties/service';
import {
  PropertyPathParamsSchema,
  STAFF_ROLES,
  UpdatePropertySchema,
  type UpdatePropertyInput,
} from '@shared/index';

/**
 * Retrieve one property.
 *
 * A property that does not exist, one in another organization, and one this caller has no
 * path to all return the same 404 with the same body. Distinguishing them would confirm
 * which ids exist — see the note in `lib/api/errors.ts` on why a denied read is never a
 * 403.
 */
export const GET = withApiHandler({}, async (ctx) => {
  const { propertyId } = PropertyPathParamsSchema.parse(ctx.params);
  const property = await getProperty(ctx.supabase, ctx.membership, propertyId);
  return ok(property, ctx.requestId);
});

/**
 * Update one property.
 *
 * Staff only, gated three times: `roles` here, `authorize()` in the service, and
 * `properties_update_staff` in `0002`. A `property_owner` who owns the row can read it
 * and gets a 403 on this route, which is the "owner is read-only" half of this lane's
 * exit gate.
 */
export const PATCH = withApiHandler<UpdatePropertyInput, undefined>(
  {
    roles: STAFF_ROLES,
    bodySchema: UpdatePropertySchema,
    audit: { action: 'property_updated', entityType: 'property' },
  },
  async (ctx) => {
    const { propertyId } = PropertyPathParamsSchema.parse(ctx.params);
    const property = await updateProperty(ctx.supabase, ctx.membership, propertyId, ctx.body);

    // Only ids and enum-valued state. The redaction allowlist would drop `name` and
    // `address_line` anyway; not sending them is the first line of the same rule.
    ctx.audit({
      entityId: property.id,
      metadata: { property_id: property.id, status: property.status },
    });

    return ok(property, ctx.requestId);
  },
);
