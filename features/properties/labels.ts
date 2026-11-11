/**
 * Display labels and formatting for the properties UI.
 *
 * Presentation only. Every key below is a *value* from `packages/shared` — `PROPERTY_TYPES`,
 * `PROPERTY_STATUSES`, `UNIT_STATUSES`, `EMIRATES` — and the maps are typed
 * `Record<…, string>` over those unions, so adding a value to the frozen enum fails `tsc`
 * here rather than rendering a raw `snake_case` token in the browser. No value is declared
 * locally and nothing here is ever used as an identifier, a key or a filter.
 *
 * `MEMBER_ROLE_LABELS` already exists in `packages/shared`; it is re-used, not restated.
 */

import {
  PROPERTY_STATUS_STYLE,
  UNIT_STATUS_STYLE,
  styleFor,
  type StatusVariant,
} from '@/components/ui/status';
import {
  DEFAULT_LOCALE,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  UNIT_STATUSES,
  type PropertyStatus,
  type PropertyType,
  type UnitStatus,
} from '@shared/index';

export const PROPERTY_TYPE_LABELS: Readonly<Record<PropertyType, string>> = Object.freeze({
  apartment_building: 'Apartment building',
  apartment: 'Apartment',
  villa: 'Villa',
  townhouse: 'Townhouse',
  office: 'Office',
  retail: 'Retail',
  warehouse: 'Warehouse',
  mixed_use: 'Mixed use',
  other: 'Other',
});

export const PROPERTY_STATUS_LABELS: Readonly<Record<PropertyStatus, string>> = Object.freeze({
  active: 'Active',
  archived: 'Archived',
});

export const UNIT_STATUS_LABELS: Readonly<Record<UnitStatus, string>> = Object.freeze({
  available: 'Available',
  occupied: 'Occupied',
  inactive: 'Inactive',
});

/**
 * Labels a `text` column whose value the application does not recognise.
 *
 * `properties.property_type` and both `status` columns are `text` with a `check`
 * constraint, and the generated row type is therefore `string`. A row written outside the
 * application — or before a constraint changed — can hold a value these maps do not know.
 * The label falls back to the raw value with underscores opened up rather than throwing,
 * because a list page that 500s on one odd row is worse than one that shows it plainly.
 */
function labelOr(
  map: Readonly<Record<string, string>>,
  value: string,
  known: readonly string[],
): string {
  if (known.includes(value)) return map[value] ?? value;
  return value.replace(/_/g, ' ');
}

export function propertyTypeLabel(value: string): string {
  return labelOr(PROPERTY_TYPE_LABELS, value, PROPERTY_TYPES);
}

export function propertyStatusLabel(value: string): string {
  return labelOr(PROPERTY_STATUS_LABELS, value, PROPERTY_STATUSES);
}

export function unitStatusLabel(value: string): string {
  return labelOr(UNIT_STATUS_LABELS, value, UNIT_STATUSES);
}

/**
 * Badge variant per status, delegated to `components/ui/status.ts`.
 *
 * This file used to decide the colours itself, and it had drifted from the rest of the
 * product: an active property was `default` here while an active tenancy was `success`
 * two screens away, and an archived property was `secondary` — the same chip a
 * not-yet-started item wears. `styleFor` is the string-keyed lookup, used because both
 * columns are `text` in SQL and a row written outside the application can hold a value
 * the enum does not know; it degrades to `outline` rather than throwing.
 */
export function propertyStatusVariant(value: string): StatusVariant {
  return styleFor(PROPERTY_STATUS_STYLE, value).variant;
}

export function unitStatusVariant(value: string): StatusVariant {
  return styleFor(UNIT_STATUS_STYLE, value).variant;
}

/** `en-AE` per §5.7. A measurement, not money — see `MoneyAmountSchema` for amounts. */
export function formatArea(sqft: number | null): string {
  if (sqft === null) return '—';
  return `${new Intl.NumberFormat(DEFAULT_LOCALE, { maximumFractionDigits: 0 }).format(sqft)} sqft`;
}

/** `0` bedrooms is a studio, not "no bedrooms" — `BedroomsSchema` is `min(0)` for this reason. */
export function formatBedrooms(bedrooms: number | null): string {
  if (bedrooms === null) return '—';
  return bedrooms === 0 ? 'Studio' : `${bedrooms}`;
}

export function formatBathrooms(bathrooms: number | null): string {
  return bathrooms === null ? '—' : `${bathrooms}`;
}

/** Short, locale-aware date for a `timestamptz`. Never used for a calculation. */
export function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, { dateStyle: 'medium' }).format(parsed);
}
