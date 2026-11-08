/**
 * The keyset cursor codec and the page splitter.
 *
 * Two things are being proven here, and only the first is about pagination:
 *
 *  1. A round trip preserves the position, and the next cursor is built from the last row
 *     of the *page*, never from the extra row fetched to answer "is there more".
 *  2. **A hostile cursor cannot restructure the PostgREST filter.** `keysetFilter`
 *     interpolates its two values into an `or=(…)` expression where `,` `(` `)` are
 *     structural. The guarantee is not escaping — it is that `decodeCursor` refuses
 *     anything that is not an ISO instant and a UUID, so no structural character can
 *     reach the expression. The tests below attack exactly that.
 */

import { describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import {
  decodeCursor,
  encodeCursor,
  keysetFilter,
  overFetchLimit,
  pageInfo,
  toPage,
} from '@/features/properties/cursor';
import { DEFAULT_PAGE_SIZE, MAX_CURSOR_LENGTH, PageInfoSchema } from '@shared/index';

const POSITION = {
  createdAt: '2026-01-10T08:00:00+00:00',
  id: '11111111-1111-4111-8111-111111111111',
};

/** Encodes an arbitrary payload the way a hostile client would have to. */
function forge(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a position', () => {
    expect(decodeCursor(encodeCursor(POSITION))).toEqual(POSITION);
  });

  it('is opaque: the encoded form is not the raw values', () => {
    const encoded = encodeCursor(POSITION);
    expect(encoded).not.toContain(POSITION.id);
    expect(encoded).not.toContain('2026-01-10');
  });

  it('is url-safe, so it needs no escaping in a query string', () => {
    expect(encodeCursor(POSITION)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 at all', 'not-a-cursor!!'],
    ['base64 of something that is not JSON', Buffer.from('plain text').toString('base64url')],
    ['a wrong version tag', forge({ v: 2, t: POSITION.createdAt, i: POSITION.id })],
    ['a missing field', forge({ v: 1, t: POSITION.createdAt })],
    ['an extra field', forge({ v: 1, t: POSITION.createdAt, i: POSITION.id, x: 1 })],
    ['a non-UUID id', forge({ v: 1, t: POSITION.createdAt, i: 'not-a-uuid' })],
    ['a non-ISO timestamp', forge({ v: 1, t: 'yesterday', i: POSITION.id })],
    ['a timestamp with no offset', forge({ v: 1, t: '2026-01-10T08:00:00', i: POSITION.id })],
  ])('rejects %s with VALIDATION_ERROR', (_label, raw) => {
    try {
      decodeCursor(raw);
      throw new Error('expected decodeCursor to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRouteError);
      expect((error as ApiRouteError).code).toBe('VALIDATION_ERROR');
      expect((error as ApiRouteError).status).toBe(400);
    }
  });

  it('rejects an oversized cursor before trying to decode it', () => {
    const oversized = 'A'.repeat(MAX_CURSOR_LENGTH + 1);
    expect(() => decodeCursor(oversized)).toThrow(ApiRouteError);
  });

  it('never leaks cursor contents into the log fields', () => {
    try {
      decodeCursor(forge({ v: 1, t: 'secret-value', i: POSITION.id }));
    } catch (error) {
      const fields = (error as ApiRouteError).logFields;
      expect(JSON.stringify(fields)).not.toContain('secret-value');
      expect(fields.reason).toBe('cursor_schema_rejected');
    }
  });
});

describe('keysetFilter', () => {
  it('is strictly-after in the sort direction', () => {
    expect(keysetFilter(POSITION, 'desc')).toBe(
      `created_at.lt.${POSITION.createdAt},and(created_at.eq.${POSITION.createdAt},id.lt.${POSITION.id})`,
    );
    expect(keysetFilter(POSITION, 'asc')).toContain('created_at.gt.');
    expect(keysetFilter(POSITION, 'asc')).toContain(`id.gt.${POSITION.id}`);
  });

  it('cannot be given a value carrying a structural character', () => {
    // This is the real guard: the only way into `keysetFilter` is through `decodeCursor`,
    // and every one of these is refused there, so none of them can reach the expression.
    const attacks = [
      { v: 1, t: '2026-01-10T08:00:00+00:00,id.gt.0', i: POSITION.id },
      { v: 1, t: POSITION.createdAt, i: `${POSITION.id},status.eq.active` },
      { v: 1, t: POSITION.createdAt, i: '11111111-1111-4111-8111-111111111111)' },
      { v: 1, t: `"${POSITION.createdAt}"`, i: POSITION.id },
    ];

    for (const attack of attacks) {
      expect(() => decodeCursor(forge(attack))).toThrow(ApiRouteError);
    }
  });

  it('produces an expression with exactly the two commas the grammar expects', () => {
    const filter = keysetFilter(POSITION, 'desc');
    expect(filter.split(',')).toHaveLength(3);
    expect(filter.match(/\(/g)).toHaveLength(1);
    expect(filter.match(/\)/g)).toHaveLength(1);
  });
});

describe('toPage / overFetchLimit', () => {
  const row = (n: number) => ({
    id: `0000000${n}-0000-4000-8000-000000000000`,
    created_at: `2026-01-0${n}T08:00:00+00:00`,
  });

  it('asks the database for one row more than the client wanted', () => {
    expect(overFetchLimit(25)).toBe(26);
    expect(overFetchLimit(1)).toBe(2);
    expect(overFetchLimit(undefined)).toBe(DEFAULT_PAGE_SIZE + 1);
  });

  it('returns no cursor when the extra row did not come back', () => {
    const page = toPage([row(1), row(2)], 2);
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
    // `limit` echoes what the caller asked for, not how many rows came back.
    expect(page.limit).toBe(2);
  });

  it('drops the extra row and builds the cursor from the last row of the page', () => {
    const page = toPage([row(1), row(2), row(3)], 2);
    expect(page.rows.map((r) => r.id)).toEqual([row(1).id, row(2).id]);
    // row(3) was only the "is there more" probe and must not become the position.
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({
      createdAt: row(2).created_at,
      id: row(2).id,
    });
    expect(page.hasMore).toBe(true);
  });

  it('returns no cursor for an empty result', () => {
    expect(toPage([], 25)).toEqual({ rows: [], nextCursor: null, hasMore: false, limit: 25 });
  });

  it('projects page_info exactly as PageInfoSchema declares it (ruling A18)', () => {
    const info = pageInfo(toPage([row(1), row(2), row(3)], 2));

    // `PageInfoSchema` is `.strict()`, so this fails if `pageInfo()` adds, drops or renames
    // a field — which is the compile-time binding made observable at runtime.
    expect(PageInfoSchema.safeParse(info).success).toBe(true);
    expect(Object.keys(info).sort()).toEqual(['has_more', 'limit', 'next_cursor']);
    expect(info.has_more).toBe(true);
    expect(info.limit).toBe(2);
    expect(typeof info.next_cursor).toBe('string');
  });
});
