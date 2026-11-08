import { z } from 'zod';

import { DEFAULT_CITY, DEFAULT_EMIRATE, PROPERTY_TYPES } from '../constants/locale';
import { PROPERTY_STATUSES } from '../constants/statuses';
import {
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
 * Properties.
 *
 * Routes: `/api/v1/properties` (lane w1-l2).
 *
 * `organization_id` is never an input — it comes from the resolved membership.
 * There is no delete route: `status: 'archived'` is the only removal path.
 */

export const PropertyTypeSchema = z.enum(PROPERTY_TYPES);
export const PropertyStatusSchema = z.enum(PROPERTY_STATUSES);

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/properties`
 *
 * Matches the create-property example in `docs/api-contracts.md` field for
 * field:
 *
 * ```json
 * {
 *   "name": "Marina Residence",
 *   "property_type": "apartment_building",
 *   "address_line": "Example Street",
 *   "city": "Dubai",
 *   "emirate": "Dubai"
 * }
 * ```
 *
 * `city` and `emirate` carry the database defaults, so the two fields the
 * example shows as present may be omitted by a Dubai-only client.
 *
 * `owner_member_id` is the optional owner association from
 * `docs/requirements.md` §3 ("Associate owners and authorized managers"). It is
 * a membership id in the caller's own organization; `0002`'s composite foreign
 * key makes a cross-organization value structurally impossible, and the handler
 * must reject it before that — two layers, as always.
 */
export const CreatePropertySchema = z
  .object({
    name: boundedText(2, 160),
    property_type: PropertyTypeSchema,
    address_line: boundedText(3, 300),
    city: boundedText(2, 80).default(DEFAULT_CITY),
    emirate: boundedText(2, 80).default(DEFAULT_EMIRATE),
    owner_member_id: UuidSchema.optional(),
  })
  .strict();

export type CreatePropertyInput = z.infer<typeof CreatePropertySchema>;

/**
 * `PATCH /api/v1/properties/{propertyId}`
 *
 * `status` is included because archiving is a status change, not a deletion.
 * `PROPERTY_STATUSES` contains no destructive value, so there is nothing here
 * that can remove a row.
 */
export const UpdatePropertySchema = z
  .object({
    name: boundedText(2, 160).optional(),
    property_type: PropertyTypeSchema.optional(),
    address_line: boundedText(3, 300).optional(),
    city: boundedText(2, 80).optional(),
    emirate: boundedText(2, 80).optional(),
    /** `null` clears the owner association. */
    owner_member_id: UuidSchema.nullable().optional(),
    status: PropertyStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdatePropertyInput = z.infer<typeof UpdatePropertySchema>;

/**
 * `GET /api/v1/properties?cursor=&limit=&status=&q=`
 *
 * The visible set is whatever RLS returns for the caller: staff see all of the
 * organization's properties, an owner sees only owned ones, a tenant sees only
 * those reached through a tenancy. The query narrows that set; it never widens
 * it.
 */
export const ListPropertiesQuerySchema = PaginationQuerySchema.extend({
  status: optionalQueryParam(PropertyStatusSchema),
  /** Free-text filter on name and address. */
  q: optionalQueryParam(boundedText(1, 120)),
}).strict();

export type ListPropertiesQuery = z.infer<typeof ListPropertiesQuerySchema>;

export const PropertyPathParamsSchema = z.object({ propertyId: UuidSchema }).strict();

export type PropertyPathParams = z.infer<typeof PropertyPathParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export const PropertySchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    name: ShortTextSchema,
    property_type: PropertyTypeSchema,
    address_line: boundedText(1, 300),
    city: ShortTextSchema,
    emirate: ShortTextSchema,
    owner_member_id: UuidSchema.nullable(),
    status: PropertyStatusSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export type Property = z.infer<typeof PropertySchema>;

/** A property with denormalized counts, for the manager and owner list views. */
export const PropertySummarySchema = PropertySchema.extend({
  unit_count: z.number().int().min(0).optional(),
  occupied_unit_count: z.number().int().min(0).optional(),
  open_ticket_count: z.number().int().min(0).optional(),
}).strict();

export type PropertySummary = z.infer<typeof PropertySummarySchema>;

export const PropertyResponseSchema = resourceResponseSchema(PropertySchema);
export const PropertyListResponseSchema = listResponseSchema(PropertySummarySchema);
