import { z } from 'zod';

import {
  EmailSchema,
  IsoDateTimeSchema,
  PaginationQuerySchema,
  PhoneSchema,
  ShortTextSchema,
  UuidSchema,
  boundedText,
  listResponseSchema,
  optionalQueryParam,
  resourceResponseSchema,
} from './primitives';

/**
 * Tenant records.
 *
 * Routes: `/api/v1/tenants` (lane w1-l3).
 *
 * A `tenants` row is the organization's record OF a person; a `profiles` row is
 * that person's own account. They are separate because a tenancy can exist
 * before the tenant ever signs in — `profile_id` is nullable and is the link
 * between the two once it does.
 *
 * This is the most personal-data-dense table in the application. Per the §4
 * matrix a tenant reads only their own row, and a service provider sees "name
 * only, via assignment" — which is why `TenantNameSchema` exists as a separate,
 * narrower response shape. Handlers serving a provider must use it. Returning
 * the full `TenantSchema` to a provider would leak a tenant's email and phone
 * and break acceptance criterion 7's spirit even though the ticket itself is
 * legitimately visible.
 */

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/tenants`
 *
 * `profile_id` optionally links the record to an existing application user. It
 * must be a profile that is a member of the caller's organization; the handler
 * verifies that against trusted rows rather than trusting the body.
 */
export const CreateTenantSchema = z
  .object({
    full_name: boundedText(2, 120),
    email: EmailSchema.optional(),
    phone: PhoneSchema.optional(),
    profile_id: UuidSchema.optional(),
  })
  .strict();

export type CreateTenantInput = z.infer<typeof CreateTenantSchema>;

/**
 * `PATCH /api/v1/tenants/{tenantId}`
 *
 * No delete path: a tenant record outlives the tenancy because the maintenance
 * and audit history references it.
 */
export const UpdateTenantSchema = z
  .object({
    full_name: boundedText(2, 120).optional(),
    email: EmailSchema.nullable().optional(),
    phone: PhoneSchema.nullable().optional(),
    profile_id: UuidSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateTenantInput = z.infer<typeof UpdateTenantSchema>;

/** `GET /api/v1/tenants?cursor=&limit=&q=` — staff only per the §4 matrix. */
export const ListTenantsQuerySchema = PaginationQuerySchema.extend({
  q: optionalQueryParam(boundedText(1, 120)),
}).strict();

export type ListTenantsQuery = z.infer<typeof ListTenantsQuerySchema>;

export const TenantPathParamsSchema = z.object({ tenantId: UuidSchema }).strict();

export type TenantPathParams = z.infer<typeof TenantPathParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** The full record. Staff, or the tenant themselves. Never a service provider. */
export const TenantSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    profile_id: UuidSchema.nullable(),
    full_name: ShortTextSchema,
    email: EmailSchema.nullable(),
    phone: PhoneSchema.nullable(),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Tenant = z.infer<typeof TenantSchema>;

/**
 * Name only — the §4 matrix's `service_provider` view of a tenant, reached
 * through an assigned ticket. Contains no contact details by construction, so a
 * handler cannot leak them by forgetting to omit a field.
 */
export const TenantNameSchema = z
  .object({
    id: UuidSchema,
    full_name: ShortTextSchema,
  })
  .strict();

export type TenantName = z.infer<typeof TenantNameSchema>;

export const TenantResponseSchema = resourceResponseSchema(TenantSchema);
export const TenantListResponseSchema = listResponseSchema(TenantSchema);
