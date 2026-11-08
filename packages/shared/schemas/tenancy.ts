import { z } from 'zod';

import { TENANCY_STATUSES } from '../constants/statuses';
import {
  CurrencyCodeSchema,
  DefaultedCurrencySchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  PaginationQuerySchema,
  UuidSchema,
  boundedText,
  isOnOrAfter,
  listResponseSchema,
  optionalQueryParam,
  resourceResponseSchema,
} from './primitives';
import { TenantSchema } from './tenant';
import { UnitSchema } from './unit';

/**
 * Tenancies — the lease that links a tenant to a unit.
 *
 * Routes: `/api/v1/tenancies` (lane w1-l3).
 *
 * Money handling, per the project rule "money is `numeric(12,2)` plus an ISO
 * currency code, never a float": `rent_amount` is validated and normalized by
 * `MoneyAmountSchema` to a fixed-scale decimal string and is always accompanied
 * by `currency`, defaulted to AED.
 *
 * Dates are ISO 8601 calendar dates and the `end_date >= start_date` rule is
 * checked here as well as by the database's own `check` constraint — so the
 * caller gets a 422 with a useful message instead of a 500 from a constraint
 * violation.
 */

export const TenancyStatusSchema = z.enum(TENANCY_STATUSES);

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

const CreateTenancyFields = z.object({
  property_unit_id: UuidSchema,
  tenant_id: UuidSchema,
  contract_number: boundedText(1, 60).optional(),
  start_date: IsoDateSchema,
  end_date: IsoDateSchema,
  rent_amount: MoneyAmountSchema,
  currency: DefaultedCurrencySchema,
  status: TenancyStatusSchema.optional(),
});

/**
 * `POST /api/v1/tenancies`
 *
 * `property_unit_id` and `tenant_id` must both belong to the caller's
 * organization. The composite foreign keys in `0001` make a cross-organization
 * pair impossible at the database level; the handler must also check it, since
 * a foreign-key violation is a 500-shaped failure and this is a 422-shaped
 * mistake.
 */
export const CreateTenancySchema = CreateTenancyFields.strict().refine(
  (value) => isOnOrAfter(value.start_date, value.end_date),
  { message: 'end_date must be on or after start_date.', path: ['end_date'] },
);

export type CreateTenancyInput = z.infer<typeof CreateTenancySchema>;

/**
 * `PATCH /api/v1/tenancies/{tenancyId}`
 *
 * The unit and the tenant are not editable: re-letting a unit or substituting a
 * tenant is a new tenancy, not an edit, and the maintenance history already
 * references the old one. `status` carries the lifecycle
 * (`ALLOWED_TENANCY_TRANSITIONS`).
 *
 * The date check runs only when it can: on a partial body with just one of the
 * two dates, the handler compares the incoming value against the stored row.
 */
export const UpdateTenancySchema = z
  .object({
    contract_number: boundedText(1, 60).nullable().optional(),
    start_date: IsoDateSchema.optional(),
    end_date: IsoDateSchema.optional(),
    rent_amount: MoneyAmountSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    status: TenancyStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  })
  .refine(
    (value) =>
      value.start_date === undefined ||
      value.end_date === undefined ||
      isOnOrAfter(value.start_date, value.end_date),
    { message: 'end_date must be on or after start_date.', path: ['end_date'] },
  );

export type UpdateTenancyInput = z.infer<typeof UpdateTenancySchema>;

/**
 * `GET /api/v1/tenancies?cursor=&limit=&status=&tenant_id=&property_unit_id=`
 *
 * A tenant calling this sees only their own tenancy whatever the filters say —
 * RLS decides the row set, the query only narrows it. That is acceptance
 * criterion "a signed-in tenant sees their own tenancy and provably cannot read
 * another's", and passing another tenant's `tenant_id` here returns an empty
 * list rather than a denial, which leaks nothing about whether the row exists.
 */
export const ListTenanciesQuerySchema = PaginationQuerySchema.extend({
  status: optionalQueryParam(TenancyStatusSchema),
  tenant_id: optionalQueryParam(UuidSchema),
  property_unit_id: optionalQueryParam(UuidSchema),
}).strict();

export type ListTenanciesQuery = z.infer<typeof ListTenanciesQuerySchema>;

export const TenancyPathParamsSchema = z.object({ tenancyId: UuidSchema }).strict();

export type TenancyPathParams = z.infer<typeof TenancyPathParamsSchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export const TenancySchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    property_unit_id: UuidSchema,
    tenant_id: UuidSchema,
    contract_number: boundedText(1, 60).nullable(),
    start_date: IsoDateSchema,
    end_date: IsoDateSchema,
    /** Canonical decimal string, e.g. `"120000.00"`. Never a float. */
    rent_amount: MoneyAmountSchema,
    currency: CurrencyCodeSchema,
    status: TenancyStatusSchema,
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Tenancy = z.infer<typeof TenancySchema>;

/** A tenancy with its unit and tenant embedded, for the tenancy detail view. */
export const TenancyDetailSchema = TenancySchema.extend({
  unit: UnitSchema.optional(),
  tenant: TenantSchema.optional(),
}).strict();

export type TenancyDetail = z.infer<typeof TenancyDetailSchema>;

export const TenancyResponseSchema = resourceResponseSchema(TenancyDetailSchema);
export const TenancyListResponseSchema = listResponseSchema(TenancySchema);
