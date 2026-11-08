import { z } from 'zod';

import { UNIT_STATUSES } from '../constants/statuses';
import {
  AreaSqftSchema,
  BathroomsSchema,
  BedroomsSchema,
  IsoDateTimeSchema,
  PaginationQuerySchema,
  ShortTextSchema,
  UuidSchema,
  boundedText,
  listResponseSchema,
  optionalQueryParam,
  resourceResponseSchema,
} from './primitives';

/**
 * Property units.
 *
 * Routes: `POST /api/v1/properties/{propertyId}/units`,
 * `GET /api/v1/properties/{propertyId}/units` (lane w1-l2).
 *
 * `property_id` is NOT part of the create body. The unit's property comes from
 * the path, so there is exactly one place the handler has to authorize, and no
 * possibility of a body that disagrees with the URL. `organization_id` likewise
 * comes from the resolved membership.
 */

export const UnitStatusSchema = z.enum(UNIT_STATUSES);

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/properties/{propertyId}/units`
 *
 * `bedrooms` 0 denotes a studio, which is why it is `min(0)` rather than
 * `positive()`. The numeric bounds mirror the `numeric(4,1)` and
 * `numeric(12,2)` column definitions and their `>= 0` check constraints.
 */
export const CreateUnitSchema = z
  .object({
    unit_number: boundedText(1, 40),
    bedrooms: BedroomsSchema.optional(),
    bathrooms: BathroomsSchema.optional(),
    area_sqft: AreaSqftSchema.optional(),
    status: UnitStatusSchema.optional(),
  })
  .strict();

export type CreateUnitInput = z.infer<typeof CreateUnitSchema>;

/**
 * `PATCH /api/v1/properties/{propertyId}/units/{unitId}`
 *
 * `null` on an optional measurement clears it. `status: 'inactive'` is the
 * archive equivalent for a unit — there is no delete path.
 */
export const UpdateUnitSchema = z
  .object({
    unit_number: boundedText(1, 40).optional(),
    bedrooms: BedroomsSchema.nullable().optional(),
    bathrooms: BathroomsSchema.nullable().optional(),
    area_sqft: AreaSqftSchema.nullable().optional(),
    status: UnitStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateUnitInput = z.infer<typeof UpdateUnitSchema>;

/** `GET /api/v1/properties/{propertyId}/units?cursor=&limit=&status=` */
export const ListUnitsQuerySchema = PaginationQuerySchema.extend({
  status: optionalQueryParam(UnitStatusSchema),
}).strict();

export type ListUnitsQuery = z.infer<typeof ListUnitsQuerySchema>;

export const UnitPathParamsSchema = z
  .object({
    propertyId: UuidSchema,
    unitId: UuidSchema,
  })
  .strict();

export type UnitPathParams = z.infer<typeof UnitPathParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export const UnitSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    property_id: UuidSchema,
    unit_number: ShortTextSchema,
    bedrooms: BedroomsSchema.nullable(),
    bathrooms: BathroomsSchema.nullable(),
    area_sqft: AreaSqftSchema.nullable(),
    status: UnitStatusSchema,
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Unit = z.infer<typeof UnitSchema>;

export const UnitResponseSchema = resourceResponseSchema(UnitSchema);
export const UnitListResponseSchema = listResponseSchema(UnitSchema);
