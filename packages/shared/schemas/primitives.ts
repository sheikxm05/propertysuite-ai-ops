import { z } from 'zod';

import {
  DEFAULT_PAGE_SIZE,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
} from '../constants/pagination';
import { DEFAULT_CURRENCY } from '../constants/locale';

/**
 * Shared Zod primitives.
 *
 * Every domain schema is built from these, so a rule like "money is
 * `numeric(12,2)` plus an ISO currency code, never a float" or "dates are ISO
 * 8601" is implemented exactly once and cannot drift between six lanes.
 *
 * Two conventions apply across every request schema in this package:
 *
 *  1. `.strict()` — unknown keys are rejected rather than stripped. This is a
 *     security property, not a style choice: a client that posts
 *     `organization_id`, `status`, `tenant_id` or `role` into a create body
 *     gets a 400 instead of having the field silently ignored, so a
 *     mass-assignment attempt is visible in the logs instead of invisible.
 *     Server-derived columns never appear in a request schema at all.
 *  2. Every string is length-bounded. An unbounded text field is a cheap
 *     denial-of-service and an expensive database row.
 */

/* -------------------------------------------------------------------------- */
/* Identifiers and text                                                       */
/* -------------------------------------------------------------------------- */

export const UuidSchema = z.string().uuid({ message: 'Expected a UUID.' });

/** Bounded, trimmed, non-empty text. */
export function boundedText(min: number, max: number) {
  return z.string().trim().min(min).max(max);
}

export const ShortTextSchema = boundedText(1, 200);
export const TitleSchema = boundedText(3, 200);
export const DescriptionSchema = boundedText(10, 4000);
export const NoteSchema = boundedText(1, 2000);

/** URL-safe organization slug: lowercase, hyphen-separated, no leading or trailing hyphen. */
export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'Expected lowercase letters, digits and single hyphens.',
  });

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Loose international phone number, normalized by stripping formatting.
 *
 * Deliberately permissive about country: a Dubai property organization has
 * tenants from everywhere. Deliberately strict about shape so that the value
 * is dialable and cannot smuggle text.
 */
export const PhoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(32)
  // Normalize first, then validate. Validating the raw string would mean
  // enumerating every way a human writes a number — `+971 50 123 4567`,
  // `(04) 123-4567`, `050.123.4567` — and getting one of them wrong is a
  // rejected tenant record rather than a security problem, so the permissive
  // path is the correct one. Only the normalized digits are stored.
  .transform((value) => value.replace(/[\s()\-.]/g, ''))
  .refine((compact) => /^\+?[0-9]{7,15}$/.test(compact), {
    message: 'Expected a phone number of 7 to 15 digits, optionally with a + prefix.',
  });

/* -------------------------------------------------------------------------- */
/* Dates                                                                      */
/* -------------------------------------------------------------------------- */

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO 8601 calendar date, `YYYY-MM-DD`, matching a Postgres `date` column.
 *
 * The regex is not sufficient on its own: `2026-02-31` and `2026-13-01` both
 * match it and both are rejected by Postgres. The round-trip check below
 * rejects them here instead, so an impossible date fails validation rather than
 * surfacing as a database error with a less useful status code.
 */
export const IsoDateSchema = z
  .string()
  .trim()
  .regex(CALENDAR_DATE_PATTERN, { message: 'Expected an ISO 8601 date (YYYY-MM-DD).' })
  .refine(
    (value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime())) return false;
      return parsed.toISOString().slice(0, 10) === value;
    },
    { message: 'Expected a real calendar date.' },
  );

/** ISO 8601 instant with an offset, matching a Postgres `timestamptz` column. */
export const IsoDateTimeSchema = z.string().trim().datetime({ offset: true });

/**
 * Is `end` on or after `start`? Mirrors the `check (end_date >= start_date)`
 * constraint on `tenancies`, so the API rejects the pair before the database
 * has to.
 *
 * String comparison is correct and total for `YYYY-MM-DD`, which is why both
 * operands must already have passed `IsoDateSchema`.
 */
export function isOnOrAfter(start: string, end: string): boolean {
  return end >= start;
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/** `numeric(12,2)`: at most 10 integer digits and at most 2 fractional digits, non-negative. */
const MONEY_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;

export const MONEY_MAX_INTEGER_DIGITS = 10;
export const MONEY_SCALE = 2;

/**
 * A monetary amount, normalized to a fixed-scale decimal string.
 *
 * Accepts a string (canonical) or a JSON number (what a browser form and
 * PostgREST both actually send) and always produces a string with exactly two
 * decimal places — `"120000.00"`, never `120000` and never `1.2000000000000002`.
 *
 * Why a string: IEEE-754 doubles cannot represent most two-decimal values
 * exactly, so any arithmetic on a parsed number silently loses money. Keeping
 * the canonical form as a decimal string means the only place a monetary value
 * exists as a float is inside a JSON parser, and `moneyToMinorUnits` is
 * available for arithmetic in integer fils.
 *
 * Pair every amount with `CurrencyCodeSchema`. An amount without a currency is
 * not a price.
 */
export const MoneyAmountSchema = z
  .union([z.string().trim(), z.number()])
  .transform((raw, ctx): string => {
    const text = typeof raw === 'number' ? (Number.isFinite(raw) ? raw.toFixed(MONEY_SCALE) : '') : raw;

    if (!MONEY_PATTERN.test(text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expected a non-negative amount with at most ${MONEY_MAX_INTEGER_DIGITS} integer digits and ${MONEY_SCALE} decimal places.`,
      });
      return z.NEVER;
    }

    const [whole = '0', fraction = ''] = text.split('.');
    return `${whole}.${fraction.padEnd(MONEY_SCALE, '0')}`;
  });

/** ISO 4217 alphabetic code. Defaults to AED per §5.7. */
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(3)
  .regex(/^[A-Z]{3}$/, { message: 'Expected a three-letter ISO 4217 currency code.' });

/**
 * A canonical amount as an integer count of minor units (fils for AED).
 *
 * Use this for any comparison or arithmetic. `"1234.56"` becomes `123456`.
 * The input must already be canonical — the output of `MoneyAmountSchema`.
 */
export function moneyToMinorUnits(canonicalAmount: string): number {
  const [whole = '0', fraction = '00'] = canonicalAmount.split('.');
  return Number(`${whole}${fraction.padEnd(MONEY_SCALE, '0')}`);
}

/** Inverse of `moneyToMinorUnits`. */
export function minorUnitsToMoney(minorUnits: number): string {
  const sign = minorUnits < 0 ? '-' : '';
  const absolute = Math.abs(Math.trunc(minorUnits)).toString().padStart(MONEY_SCALE + 1, '0');
  const whole = absolute.slice(0, absolute.length - MONEY_SCALE);
  const fraction = absolute.slice(absolute.length - MONEY_SCALE);
  return `${sign}${whole}.${fraction}`;
}

/** A money value as it appears in an API response. */
export const MoneySchema = z
  .object({
    amount: MoneyAmountSchema,
    currency: CurrencyCodeSchema,
  })
  .strict();

export type Money = z.infer<typeof MoneySchema>;

/* -------------------------------------------------------------------------- */
/* Non-monetary decimals                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A bounded non-negative decimal for measurements, matching `numeric(p,s)`.
 *
 * Measurements are safe as numbers — unlike money, nobody sums a thousand
 * bathroom counts and expects the cents to balance.
 */
export function decimalSchema(integerDigits: number, scale: number) {
  const max = Number('9'.repeat(integerDigits) + (scale > 0 ? `.${'9'.repeat(scale)}` : ''));
  const step = scale > 0 ? Number(`1e-${scale}`) : 1;
  return z.number().nonnegative().max(max).multipleOf(step);
}

/** `property_units.bathrooms numeric(4,1)` — up to 999.9, in halves or tenths. */
export const BathroomsSchema = decimalSchema(3, 1);

/** `property_units.area_sqft numeric(12,2)`. */
export const AreaSqftSchema = decimalSchema(10, 2);

/** `property_units.bedrooms integer check (>= 0)`. 0 means a studio. */
export const BedroomsSchema = z.number().int().min(0).max(99);

/* -------------------------------------------------------------------------- */
/* JSON metadata                                                              */
/* -------------------------------------------------------------------------- */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

/** Serialized size cap for a `jsonb` metadata column. */
export const MAX_METADATA_BYTES = 4096;

/**
 * A `jsonb` metadata object, size-bounded.
 *
 * Metadata is written to append-only tables (`maintenance_activities`,
 * `audit_logs`) that cannot be corrected afterwards, so an unbounded blob is
 * permanent. It must carry identifiers and decisions — never document text,
 * message bodies, tokens or personal data.
 */
export const MetadataSchema = z
  .record(JsonValueSchema)
  .refine((value) => JSON.stringify(value).length <= MAX_METADATA_BYTES, {
    message: `Metadata must serialize to at most ${MAX_METADATA_BYTES} bytes.`,
  });

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

/** Treat an absent query parameter and `?limit=` as the same thing. */
export function optionalQueryParam<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    schema.optional(),
  );
}

export const CursorSchema = z.string().min(1).max(MAX_CURSOR_LENGTH);

export const LimitSchema = z.coerce
  .number()
  .int()
  .min(MIN_PAGE_SIZE)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE);

/**
 * The query shape every list route accepts: `?cursor=&limit=`, per
 * `docs/api-contracts.md`. Default 25, maximum 100 (§5.7).
 */
export const PaginationQuerySchema = z.object({
  cursor: optionalQueryParam(CursorSchema),
  limit: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? undefined : value),
    LimitSchema,
  ),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PageInfoSchema = z
  .object({
    /** Opaque. Pass it back as `?cursor=`; never parse or construct it client-side. */
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
    limit: z.number().int(),
  })
  .strict();

export type PageInfo = z.infer<typeof PageInfoSchema>;

/** `{ data: [...], page_info: {...} }` — the shape of every list response. */
export function listResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z
    .object({
      data: z.array(item),
      page_info: PageInfoSchema,
    })
    .strict();
}

/** `{ data: {...} }` — the shape of every single-resource response. */
export function resourceResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({ data: item }).strict();
}

/* -------------------------------------------------------------------------- */
/* Shared field groups                                                        */
/* -------------------------------------------------------------------------- */

/** The default currency for a new record. */
export const DefaultedCurrencySchema = CurrencyCodeSchema.default(DEFAULT_CURRENCY);

/**
 * Require at least one field on a PATCH body.
 *
 * An empty PATCH is almost always a client bug, and accepting it would write an
 * audit row recording that nothing changed.
 */
export function requireAtLeastOneField<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine(
    (value) => typeof value === 'object' && value !== null && Object.keys(value).length > 0,
    { message: 'Provide at least one field to update.' },
  );
}

/**
 * An explicit human confirmation.
 *
 * `z.literal(true)` rather than `z.boolean()` so that an absent, false or
 * truthy-but-not-true value is a validation failure. Every mutation reachable
 * from model output carries one of these: it is the contract-level half of
 * "AI drafts, humans commit".
 */
export const ConfirmationSchema = z.literal(true, {
  errorMap: () => ({ message: 'Explicit confirmation is required.' }),
});
