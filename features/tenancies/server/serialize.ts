/**
 * Row → response projection for `tenancies`.
 *
 * Two things make this more than a field copy.
 *
 * **Money.** `tenancies.rent_amount` is `numeric(12,2)` and PostgREST hands it back as a
 * JSON number, which cannot represent most two-decimal values exactly. Every row goes
 * through `MoneyAmountSchema` (inside `TenancySchema`), which normalises it to a
 * fixed-scale decimal string — so `"120000.00"` leaves this module, never `120000` and
 * never `1.2000000000000002`. The currency travels with it, always.
 *
 * **The embedded tenant.** `TenancyDetailSchema` can carry the unit and the tenant, and
 * the §4 matrix does not grant those two to the same set of roles as the tenancy itself:
 * a `property_owner` has `R owned` on `tenancies` but a dash — no access at all — on
 * `tenants`. Embedding the tenant unconditionally would hand an owner the contact
 * details of every tenant in their building through a route that looks like it is only
 * about leases. So the embeds are **optional in the schema and separately authorized**
 * by the service; this module only renders what it is given.
 */

import {
  TenancySchema,
  TenancyDetailSchema,
  UnitSchema,
  type Tenancy,
  type TenancyDetail,
  type Tenant,
  type Unit,
} from '@shared/index';

/** Every column a tenancy read selects, in `TenancySchema` order. Never `*`. */
export const TENANCY_FIELDS = [
  'id',
  'organization_id',
  'property_unit_id',
  'tenant_id',
  'contract_number',
  'start_date',
  'end_date',
  'rent_amount',
  'currency',
  'status',
  'created_at',
] as const;

export type TenancyField = (typeof TENANCY_FIELDS)[number];

/** Compile-time parity between the SQL column list and the response schema. */
type _TenancyFieldParity = [
  Exclude<keyof Tenancy, TenancyField> extends never ? true : never,
  Exclude<TenancyField, keyof Tenancy> extends never ? true : never,
];
const _tenancyFieldParity: _TenancyFieldParity = [true, true];
void _tenancyFieldParity;

export const TENANCY_SELECT = TENANCY_FIELDS.join(', ');

/** The widest tenancy row shape this lane selects. */
export interface TenancyRowLike {
  id?: unknown;
  organization_id?: unknown;
  property_unit_id?: unknown;
  tenant_id?: unknown;
  contract_number?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  rent_amount?: unknown;
  currency?: unknown;
  status?: unknown;
  created_at?: unknown;
}

/** The unit columns needed for the optional embed and for the ownership chain. */
export const UNIT_FIELDS = [
  'id',
  'organization_id',
  'property_id',
  'unit_number',
  'bedrooms',
  'bathrooms',
  'area_sqft',
  'status',
  'created_at',
] as const;

export const UNIT_SELECT = UNIT_FIELDS.join(', ');

export interface UnitRowLike {
  id?: unknown;
  organization_id?: unknown;
  property_id?: unknown;
  unit_number?: unknown;
  bedrooms?: unknown;
  bathrooms?: unknown;
  area_sqft?: unknown;
  status?: unknown;
  created_at?: unknown;
}

export function serializeTenancy(row: TenancyRowLike): Tenancy {
  return TenancySchema.parse({
    id: row.id,
    organization_id: row.organization_id,
    property_unit_id: row.property_unit_id,
    tenant_id: row.tenant_id,
    contract_number: row.contract_number ?? null,
    start_date: row.start_date,
    end_date: row.end_date,
    rent_amount: row.rent_amount,
    currency: row.currency,
    status: row.status,
    created_at: row.created_at,
  });
}

export function serializeUnit(row: UnitRowLike): Unit {
  return UnitSchema.parse({
    id: row.id,
    organization_id: row.organization_id,
    property_id: row.property_id,
    unit_number: row.unit_number,
    bedrooms: row.bedrooms ?? null,
    bathrooms: row.bathrooms ?? null,
    area_sqft: row.area_sqft ?? null,
    status: row.status,
    created_at: row.created_at,
  });
}

/**
 * A tenancy with whichever embeds the caller was separately authorized for.
 *
 * `undefined` for an embed means "not granted to this caller", and because
 * `TenancyDetailSchema` is `.strict()` with both embeds optional, omitting a key is
 * expressible while adding an unexpected one is not. An absent `tenant` on an owner's
 * response is therefore the matrix being enforced, not a missing feature.
 */
export function serializeTenancyDetail(
  row: TenancyRowLike,
  embeds: { unit?: Unit | null; tenant?: Tenant | null } = {},
): TenancyDetail {
  const base = serializeTenancy(row);
  const detail: Record<string, unknown> = { ...base };
  if (embeds.unit) detail.unit = embeds.unit;
  if (embeds.tenant) detail.tenant = embeds.tenant;
  return TenancyDetailSchema.parse(detail);
}
