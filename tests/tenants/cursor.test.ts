/**
 * The keyset cursor codec, including the filter-injection cases.
 *
 * A cursor is attacker-controlled input that is interpolated into a PostgREST `or=`
 * expression. If a crafted value could close the quoting and append its own filter, a
 * caller could widen the row set a query asks for — Row Level Security would still deny
 * another organization's rows, but the premise of this project is that neither layer
 * leans on the other.
 */

import { describe, expect, it } from 'vitest';

import { isApiRouteError } from '@/lib/api/errors';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@shared/index';

import {
  PAGE_ORDER,
  decodePageCursor,
  descendingKeysetFilter,
  encodePageCursor,
  takePage,
} from '@/features/tenants/server/cursor';

const CREATED_AT = '2026-11-09T08:30:00.123456+00:00';
const ID = '77777777-0000-4000-8000-000000000001';

function expectRejected(raw: string) {
  try {
    decodePageCursor(raw);
  } catch (thrown) {
    expect(isApiRouteError(thrown)).toBe(true);
    if (isApiRouteError(thrown)) {
      expect(thrown.code).toBe('VALIDATION_ERROR');
      expect(thrown.status).toBe(400);
    }
    return;
  }
  throw new Error(`cursor was accepted but should have been rejected: ${raw}`);
}

describe('encode / decode', () => {
  it('round-trips', () => {
    const encoded = encodePageCursor({ createdAt: CREATED_AT, id: ID });

    expect(decodePageCursor(encoded)).toEqual({ createdAt: CREATED_AT, id: ID });
  });

  it('is opaque — not a readable timestamp a client could construct', () => {
    const encoded = encodePageCursor({ createdAt: CREATED_AT, id: ID });

    expect(encoded).not.toContain(CREATED_AT);
    expect(encoded).not.toContain('|');
  });

  it('accepts the timestamp shapes PostgREST emits', () => {
    for (const timestamp of [
      '2026-11-09T08:30:00+00:00',
      '2026-11-09T08:30:00Z',
      '2026-11-09T08:30:00.1+04:00',
      '2026-11-09T08:30:00.123456-05:00',
    ]) {
      const encoded = encodePageCursor({ createdAt: timestamp, id: ID });
      expect(decodePageCursor(encoded).createdAt).toBe(timestamp);
    }
  });
});

describe('a hostile cursor', () => {
  it('cannot close the quoting and append a filter', () => {
    const payload = `2026-11-09T08:30:00+00:00",or=(id.eq.${ID})|${ID}`;
    expectRejected(Buffer.from(payload, 'utf8').toString('base64url'));
  });

  it('cannot smuggle a comma into the or-expression', () => {
    const payload = `2026-11-09T08:30:00+00:00,organization_id.eq.x|${ID}`;
    expectRejected(Buffer.from(payload, 'utf8').toString('base64url'));
  });

  it('cannot supply a non-uuid tiebreaker', () => {
    const payload = `${CREATED_AT}|1 or true`;
    expectRejected(Buffer.from(payload, 'utf8').toString('base64url'));
  });

  it('cannot supply a free-text timestamp', () => {
    expectRejected(Buffer.from(`now()|${ID}`, 'utf8').toString('base64url'));
  });

  it('is rejected when it has no separator', () => {
    expectRejected(Buffer.from(CREATED_AT, 'utf8').toString('base64url'));
  });

  it('is rejected when it is empty', () => {
    expectRejected('');
  });

  it('is rejected when it decodes to more than the byte cap', () => {
    const payload = `${CREATED_AT}|${ID}${'a'.repeat(300)}`;
    expectRejected(Buffer.from(payload, 'utf8').toString('base64url'));
  });

  it('is rejected when the separator is at position zero', () => {
    expectRejected(Buffer.from(`|${ID}`, 'utf8').toString('base64url'));
  });
});

describe('descendingKeysetFilter', () => {
  it('quotes the timestamp and covers the tie on the boundary row', () => {
    const filter = descendingKeysetFilter({ createdAt: CREATED_AT, id: ID });

    expect(filter).toBe(
      `created_at.lt."${CREATED_AT}",and(created_at.eq."${CREATED_AT}",id.lt.${ID})`,
    );
  });

  it('matches the order the queries apply', () => {
    expect(PAGE_ORDER.map((order) => order.column)).toEqual(['created_at', 'id']);
    expect(PAGE_ORDER.every((order) => order.ascending === false)).toBe(true);
  });
});

describe('takePage', () => {
  const rows = Array.from({ length: 4 }, (_, index) => ({
    id: `77777777-0000-4000-8000-00000000000${index}`,
    created_at: `2026-11-0${index + 1}T00:00:00+00:00`,
  }));

  it('returns the page and a cursor when an extra row was fetched', () => {
    const page = takePage(rows, 3);

    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    // The cursor is the last row OF THE PAGE, not the probe row.
    expect(decodePageCursor(page.nextCursor as string).id).toBe(rows[2]?.id);
  });

  it('returns no cursor on the last page', () => {
    const page = takePage(rows.slice(0, 2), 3);

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = takePage([], 25);

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  it('is bounded by the frozen page sizes', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});
