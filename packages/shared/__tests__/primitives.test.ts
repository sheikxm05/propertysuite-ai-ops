import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/pagination';
import {
  MAX_UPLOAD_BYTES,
  SIGNED_URL_TTL_SECONDS,
  buildStoragePath,
  isStoragePathForOrganization,
} from '../constants/storage';
import {
  AreaSqftSchema,
  BathroomsSchema,
  BedroomsSchema,
  ConfirmationSchema,
  CurrencyCodeSchema,
  EmailSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  MoneyAmountSchema,
  PaginationQuerySchema,
  PhoneSchema,
  SlugSchema,
  UuidSchema,
  isOnOrAfter,
  minorUnitsToMoney,
  moneyToMinorUnits,
} from '../schemas/primitives';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('MoneyAmountSchema', () => {
  it('normalizes to a fixed two-decimal string', () => {
    expect(MoneyAmountSchema.parse('120000')).toBe('120000.00');
    expect(MoneyAmountSchema.parse('120000.5')).toBe('120000.50');
    expect(MoneyAmountSchema.parse('120000.55')).toBe('120000.55');
    expect(MoneyAmountSchema.parse('0')).toBe('0.00');
  });

  it('accepts a JSON number and still returns a string, never a float', () => {
    const parsed = MoneyAmountSchema.parse(120000);
    expect(parsed).toBe('120000.00');
    expect(typeof parsed).toBe('string');
    expect(MoneyAmountSchema.parse(0.1)).toBe('0.10');
  });

  it('accepts the full numeric(12,2) domain', () => {
    expect(MoneyAmountSchema.parse('9999999999.99')).toBe('9999999999.99');
  });

  it('rejects more than two decimal places', () => {
    expect(() => MoneyAmountSchema.parse('1.234')).toThrow();
  });

  it('rejects more than ten integer digits, which numeric(12,2) cannot hold', () => {
    expect(() => MoneyAmountSchema.parse('12345678901')).toThrow();
  });

  it('rejects a negative amount, mirroring the check (rent_amount >= 0) constraint', () => {
    expect(() => MoneyAmountSchema.parse('-1.00')).toThrow();
    expect(() => MoneyAmountSchema.parse(-1)).toThrow();
  });

  it('rejects non-numeric text, infinity and NaN', () => {
    expect(() => MoneyAmountSchema.parse('')).toThrow();
    expect(() => MoneyAmountSchema.parse('abc')).toThrow();
    expect(() => MoneyAmountSchema.parse('1,000.00')).toThrow();
    expect(() => MoneyAmountSchema.parse('1e5')).toThrow();
    expect(() => MoneyAmountSchema.parse(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => MoneyAmountSchema.parse(Number.NaN)).toThrow();
  });

  it('round-trips through integer minor units without float error', () => {
    for (const amount of ['0.00', '0.01', '0.10', '1.00', '1.05', '120000.55', '9999999999.99']) {
      expect(minorUnitsToMoney(moneyToMinorUnits(amount))).toBe(amount);
    }
  });

  it('converts to minor units exactly', () => {
    expect(moneyToMinorUnits('1.00')).toBe(100);
    expect(moneyToMinorUnits('0.01')).toBe(1);
    expect(moneyToMinorUnits('120000.55')).toBe(12000055);
  });

  it('sums in minor units without the 0.1 + 0.2 problem', () => {
    const total = moneyToMinorUnits('0.10') + moneyToMinorUnits('0.20');
    expect(minorUnitsToMoney(total)).toBe('0.30');
  });
});

describe('CurrencyCodeSchema', () => {
  it('accepts and upper-cases a three-letter code', () => {
    expect(CurrencyCodeSchema.parse('AED')).toBe('AED');
    expect(CurrencyCodeSchema.parse('aed')).toBe('AED');
    expect(CurrencyCodeSchema.parse(' usd ')).toBe('USD');
  });

  it('rejects anything that is not three letters', () => {
    expect(() => CurrencyCodeSchema.parse('AE')).toThrow();
    expect(() => CurrencyCodeSchema.parse('AEDX')).toThrow();
    expect(() => CurrencyCodeSchema.parse('A3D')).toThrow();
    expect(() => CurrencyCodeSchema.parse('')).toThrow();
  });
});

describe('IsoDateSchema', () => {
  it('accepts a real ISO calendar date', () => {
    expect(IsoDateSchema.parse('2026-01-15')).toBe('2026-01-15');
    expect(IsoDateSchema.parse('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects an impossible date that the regex alone would allow', () => {
    expect(() => IsoDateSchema.parse('2026-02-31')).toThrow();
    expect(() => IsoDateSchema.parse('2026-13-01')).toThrow();
    expect(() => IsoDateSchema.parse('2026-00-10')).toThrow();
    expect(() => IsoDateSchema.parse('2025-02-29')).toThrow();
  });

  it('rejects other date formats', () => {
    expect(() => IsoDateSchema.parse('15/01/2026')).toThrow();
    expect(() => IsoDateSchema.parse('2026-1-5')).toThrow();
    expect(() => IsoDateSchema.parse('2026-01-15T00:00:00Z')).toThrow();
  });
});

describe('IsoDateTimeSchema', () => {
  it('accepts an instant with an offset, including fractional seconds', () => {
    expect(IsoDateTimeSchema.parse('2026-01-15T10:30:00Z')).toBe('2026-01-15T10:30:00Z');
    expect(IsoDateTimeSchema.parse('2026-01-15T10:30:00.123456+04:00')).toBeTruthy();
  });

  it('rejects a bare date or a naive datetime', () => {
    expect(() => IsoDateTimeSchema.parse('2026-01-15')).toThrow();
    expect(() => IsoDateTimeSchema.parse('not-a-date')).toThrow();
  });
});

describe('isOnOrAfter', () => {
  it('mirrors the check (end_date >= start_date) constraint', () => {
    expect(isOnOrAfter('2026-01-01', '2026-12-31')).toBe(true);
    expect(isOnOrAfter('2026-01-01', '2026-01-01')).toBe(true);
    expect(isOnOrAfter('2026-12-31', '2026-01-01')).toBe(false);
  });
});

describe('UuidSchema, SlugSchema, EmailSchema, PhoneSchema', () => {
  it('accepts a uuid and rejects anything else', () => {
    expect(UuidSchema.parse(UUID)).toBe(UUID);
    expect(() => UuidSchema.parse('not-a-uuid')).toThrow();
    expect(() => UuidSchema.parse('')).toThrow();
  });

  it('normalizes a slug and rejects malformed ones', () => {
    expect(SlugSchema.parse('Marina-Residence')).toBe('marina-residence');
    expect(() => SlugSchema.parse('-leading')).toThrow();
    expect(() => SlugSchema.parse('trailing-')).toThrow();
    expect(() => SlugSchema.parse('double--hyphen')).toThrow();
    expect(() => SlugSchema.parse('has space')).toThrow();
    expect(() => SlugSchema.parse('ab')).toThrow();
  });

  it('normalizes an email and rejects a malformed one', () => {
    expect(EmailSchema.parse(' Tenant@Example.COM ')).toBe('tenant@example.com');
    expect(() => EmailSchema.parse('not-an-email')).toThrow();
  });

  it('strips phone formatting and rejects text', () => {
    expect(PhoneSchema.parse('+971 50 123 4567')).toBe('+971501234567');
    expect(PhoneSchema.parse('(04) 123-4567')).toBe('041234567');
    expect(() => PhoneSchema.parse('call me')).toThrow();
    expect(() => PhoneSchema.parse('123')).toThrow();
  });
});

describe('numeric column schemas', () => {
  it('accepts a studio as zero bedrooms', () => {
    expect(BedroomsSchema.parse(0)).toBe(0);
  });

  it('rejects negative or fractional bedrooms', () => {
    expect(() => BedroomsSchema.parse(-1)).toThrow();
    expect(() => BedroomsSchema.parse(1.5)).toThrow();
  });

  it('accepts bathrooms to one decimal place, matching numeric(4,1)', () => {
    expect(BathroomsSchema.parse(2.5)).toBe(2.5);
    expect(BathroomsSchema.parse(0)).toBe(0);
    expect(() => BathroomsSchema.parse(2.55)).toThrow();
    expect(() => BathroomsSchema.parse(-1)).toThrow();
    expect(() => BathroomsSchema.parse(1000)).toThrow();
  });

  it('accepts area to two decimal places and rejects negatives', () => {
    expect(AreaSqftSchema.parse(1250.75)).toBe(1250.75);
    expect(() => AreaSqftSchema.parse(-5)).toThrow();
    expect(() => AreaSqftSchema.parse(1250.755)).toThrow();
  });
});

describe('MetadataSchema', () => {
  it('accepts a bounded JSON object', () => {
    expect(MetadataSchema.parse({ from: 'open', to: 'assigned' })).toEqual({
      from: 'open',
      to: 'assigned',
    });
    expect(MetadataSchema.parse({})).toEqual({});
    expect(MetadataSchema.parse({ nested: { a: [1, true, null] } })).toBeTruthy();
  });

  it('rejects an oversized blob, because the activity table is append-only', () => {
    expect(() => MetadataSchema.parse({ big: 'x'.repeat(5000) })).toThrow();
  });
});

describe('PaginationQuerySchema', () => {
  it('defaults the limit to 25', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({
      cursor: undefined,
      limit: DEFAULT_PAGE_SIZE,
    });
  });

  it('treats ?cursor=&limit= as absent, per the documented query string', () => {
    expect(PaginationQuerySchema.parse({ cursor: '', limit: '' })).toEqual({
      cursor: undefined,
      limit: DEFAULT_PAGE_SIZE,
    });
  });

  it('coerces a string limit from the query string', () => {
    expect(PaginationQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps the limit at 100 and rejects anything above it', () => {
    expect(PaginationQuerySchema.parse({ limit: String(MAX_PAGE_SIZE) }).limit).toBe(
      MAX_PAGE_SIZE,
    );
    expect(() => PaginationQuerySchema.parse({ limit: '101' })).toThrow();
    expect(() => PaginationQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => PaginationQuerySchema.parse({ limit: '-5' })).toThrow();
    expect(() => PaginationQuerySchema.parse({ limit: 'abc' })).toThrow();
  });

  it('rejects an absurdly long cursor', () => {
    expect(() => PaginationQuerySchema.parse({ cursor: 'x'.repeat(513) })).toThrow();
  });
});

describe('ConfirmationSchema', () => {
  it('accepts only the literal true', () => {
    expect(ConfirmationSchema.parse(true)).toBe(true);
    expect(() => ConfirmationSchema.parse(false)).toThrow();
    expect(() => ConfirmationSchema.parse('true')).toThrow();
    expect(() => ConfirmationSchema.parse(1)).toThrow();
    expect(() => ConfirmationSchema.parse(undefined)).toThrow();
  });
});

describe('storage path helpers', () => {
  it('builds the one frozen path shape', () => {
    expect(buildStoragePath(UUID, 'documents', UUID)).toBe(`${UUID}/documents/${UUID}.pdf`);
  });

  it('recognises a path belonging to an organization', () => {
    expect(isStoragePathForOrganization(`${UUID}/documents/x.pdf`, UUID)).toBe(true);
  });

  it('refuses another organization and refuses traversal', () => {
    const other = '11111111-2222-3333-4444-555555555555';
    expect(isStoragePathForOrganization(`${UUID}/documents/x.pdf`, other)).toBe(false);
    expect(isStoragePathForOrganization(`${UUID}/../${other}/x.pdf`, UUID)).toBe(false);
    expect(isStoragePathForOrganization(`${UUID}/documents/x.pdf`, '')).toBe(false);
  });

  it('holds the frozen §5.7 limits', () => {
    expect(SIGNED_URL_TTL_SECONDS).toBe(60);
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
