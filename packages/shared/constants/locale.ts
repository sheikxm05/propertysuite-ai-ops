/**
 * Locale and currency, frozen in `docs/parallel-execution-plan.md` §5.7:
 * "Currency AED, locale `en-AE`."
 */
export const DEFAULT_CURRENCY = 'AED';
export const DEFAULT_LOCALE = 'en-AE';
export const DEFAULT_CITY = 'Dubai';
export const DEFAULT_EMIRATE = 'Dubai';

/** The seven emirates. `properties.emirate` is free `text` in SQL; constrained here. */
export const EMIRATES = [
  'Dubai',
  'Abu Dhabi',
  'Sharjah',
  'Ajman',
  'Umm Al Quwain',
  'Ras Al Khaimah',
  'Fujairah',
] as const;
export type Emirate = (typeof EMIRATES)[number];

/**
 * `properties.property_type` — free `text` in SQL. `apartment_building` is the
 * value used in the `docs/api-contracts.md` create-property example and must
 * stay in this list.
 */
export const PROPERTY_TYPES = [
  'apartment_building',
  'apartment',
  'villa',
  'townhouse',
  'office',
  'retail',
  'warehouse',
  'mixed_use',
  'other',
] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
