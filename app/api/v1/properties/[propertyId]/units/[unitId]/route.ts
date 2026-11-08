/**
 * `GET /api/v1/properties/{propertyId}/units/{unitId}` and
 * `PATCH /api/v1/properties/{propertyId}/units/{unitId}`
 *
 * The unit update path, including the `available` / `occupied` / `inactive` status machine
 * in `features/properties/unit-status.ts`. `UpdateUnitSchema` (frozen, `@shared/index`)
 * documents this exact URL, and `UnitPathParamsSchema` validates both segments — a unit id
 * that exists under a *different* property is a 404, not a successful read of someone
 * else's unit. That pair check is the defect Wave 0 found the hard way, and
 * `0002`'s `unit_belongs_to_property()` exists for the SQL half of it.
 *
 * `status: 'inactive'` is the archive edge for a unit. There is no DELETE route, and
 * `authenticated` has no DELETE privilege on `property_units` to give one.
 */

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { getUnit, updateUnit } from '@/features/properties/service';
import {
  STAFF_ROLES,
  UnitPathParamsSchema,
  UpdateUnitSchema,
  type UpdateUnitInput,
} from '@shared/index';

/** Retrieve one unit. 404 unless the `{propertyId, unitId}` pair is true and reachable. */
export const GET = withApiHandler({}, async (ctx) => {
  const { propertyId, unitId } = UnitPathParamsSchema.parse(ctx.params);
  const unit = await getUnit(ctx.supabase, ctx.membership, propertyId, unitId);
  return ok(unit, ctx.requestId);
});

/**
 * Update one unit, including a status transition.
 *
 * Two different refusals, deliberately distinguishable by the client:
 *  - an illegal edge (`occupied → inactive`) is `CONFLICT` 409;
 *  - a legal edge attempted by a role that may not write is `FORBIDDEN` 403.
 *
 * That is the rule `docs/implementation-plan.md` §4 states for the ticket machine, applied
 * to this one so the application answers consistently.
 */
export const PATCH = withApiHandler<UpdateUnitInput, undefined>(
  {
    roles: STAFF_ROLES,
    bodySchema: UpdateUnitSchema,
    audit: { action: 'unit_updated', entityType: 'property_unit' },
  },
  async (ctx) => {
    const { propertyId, unitId } = UnitPathParamsSchema.parse(ctx.params);
    const { unit, previousStatus } = await updateUnit(
      ctx.supabase,
      ctx.membership,
      propertyId,
      unitId,
      ctx.body,
    );

    ctx.audit({
      entityId: unit.id,
      metadata: {
        property_id: propertyId,
        unit_id: unit.id,
        from_status: previousStatus,
        to_status: unit.status,
      },
    });

    return ok(unit, ctx.requestId);
  },
);
