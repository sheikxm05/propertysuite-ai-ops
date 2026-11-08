import { z } from 'zod';

import { SERVICE_PROVIDER_STATUSES } from '../constants/statuses';
import { MaintenanceCategorySchema } from './maintenance';
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
 * Service providers — the organization's record of a contractor.
 *
 * The counterpart of `tenants`: an outside party the organization holds a
 * record of, referenced by a ticket. §4 grants `RW` to staff and `R self` to
 * the provider; no provider ever reads another provider.
 *
 * `service_categories` is `text[]` in SQL but is constrained to
 * `MAINTENANCE_CATEGORIES` here, so provider capabilities and ticket categories
 * are drawn from one vocabulary and a manager can match them.
 */

export const ServiceProviderStatusSchema = z.enum(SERVICE_PROVIDER_STATUSES);

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

export const CreateServiceProviderSchema = z
  .object({
    company_name: boundedText(2, 200),
    service_categories: z.array(MaintenanceCategorySchema).max(9).default([]),
    /** Optional link to the provider's own application user. */
    profile_id: UuidSchema.optional(),
    contact_email: EmailSchema.optional(),
    contact_phone: PhoneSchema.optional(),
  })
  .strict();

export type CreateServiceProviderInput = z.infer<typeof CreateServiceProviderSchema>;

/** No delete path: tickets reference providers and that history must survive. */
export const UpdateServiceProviderSchema = z
  .object({
    company_name: boundedText(2, 200).optional(),
    service_categories: z.array(MaintenanceCategorySchema).max(9).optional(),
    profile_id: UuidSchema.nullable().optional(),
    status: ServiceProviderStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateServiceProviderInput = z.infer<typeof UpdateServiceProviderSchema>;

export const ListServiceProvidersQuerySchema = PaginationQuerySchema.extend({
  status: optionalQueryParam(ServiceProviderStatusSchema),
  category: optionalQueryParam(MaintenanceCategorySchema),
}).strict();

export type ListServiceProvidersQuery = z.infer<typeof ListServiceProvidersQuerySchema>;

export const ServiceProviderPathParamsSchema = z.object({ providerId: UuidSchema }).strict();

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export const ServiceProviderSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    profile_id: UuidSchema.nullable(),
    company_name: ShortTextSchema,
    service_categories: z.array(z.string()),
    status: ServiceProviderStatusSchema,
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type ServiceProvider = z.infer<typeof ServiceProviderSchema>;

export const ServiceProviderResponseSchema = resourceResponseSchema(ServiceProviderSchema);
export const ServiceProviderListResponseSchema = listResponseSchema(ServiceProviderSchema);
