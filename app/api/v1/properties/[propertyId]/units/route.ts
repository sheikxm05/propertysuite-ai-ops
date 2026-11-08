/**
 * `GET /api/v1/properties/{propertyId}/units` and
 * `POST /api/v1/properties/{propertyId}/units`
 *
 * Per `docs/api-contracts.md`. `property_id` is deliberately absent from
 * `CreateUnitSchema` (frozen, `@shared/index`): the unit's property comes from the path,
 * so there is exactly one place to authorize and no body that can disagree with the URL.
 *
 * A duplicate `unit_number` within the same property violates
 * `unique (property_id, unit_number)` from `0001` and reaches the client as `CONFLICT`
 * 409 through the wrapper's `23505` mapping (amendment A2). Nothing in this file catches
 * it: hand-rolling that translation is how two routes end up disagreeing about what a
 * duplicate means.
 */

import { created, jsonResponse } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { pageInfo } from '@/features/properties/cursor';
import { createUnit, listUnits } from '@/features/properties/service';
import {
  CreateUnitSchema,
  ListUnitsQuerySchema,
  PropertyPathParamsSchema,
  STAFF_ROLES,
  type CreateUnitInput,
  type ListUnitsQuery,
} from '@shared/index';

/**
 * List the units of one property, cursor-paginated.
 *
 * The parent property is read and authorized first, so an unreachable property is a 404
 * rather than an empty page — an empty page would be an answer about a property the caller
 * is not supposed to know exists. A tenant then sees only the unit they lease, and a
 * provider only the unit behind their assigned ticket, because the scope restricts the
 * statement by id and `authorize()` re-checks each row.
 */
export const GET = withApiHandler<undefined, ListUnitsQuery>(
  { querySchema: ListUnitsQuerySchema },
  async (ctx) => {
    const { propertyId } = PropertyPathParamsSchema.parse(ctx.params);
    const page = await listUnits(ctx.supabase, ctx.membership, propertyId, ctx.query);
    // `{ data, page_info }` per ruling A18, matching `UnitListResponseSchema` — see the
    // sibling list route for why this goes through `jsonResponse` and not `paginated()`.
    return jsonResponse({ data: page.rows, page_info: pageInfo(page) }, ctx.requestId);
  },
);

/** Create a unit inside a property. Staff only; an archived property rejects with 409. */
export const POST = withApiHandler<CreateUnitInput, undefined>(
  {
    roles: STAFF_ROLES,
    bodySchema: CreateUnitSchema,
    audit: { action: 'unit_created', entityType: 'property_unit' },
  },
  async (ctx) => {
    const { propertyId } = PropertyPathParamsSchema.parse(ctx.params);
    const unit = await createUnit(ctx.supabase, ctx.membership, propertyId, ctx.body);

    ctx.audit({
      entityId: unit.id,
      metadata: { property_id: propertyId, unit_id: unit.id, status: unit.status },
    });

    return created(unit, ctx.requestId, {
      location: `/api/v1/properties/${propertyId}/units/${unit.id}`,
    });
  },
);
