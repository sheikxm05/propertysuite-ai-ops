/**
 * Cursor pagination.
 *
 * Two classes of claim: the round trip is lossless, and a hostile cursor cannot become
 * a query fragment. The second is the one worth having — the cursor's decoded values are
 * interpolated into a PostgREST `or(...)` expression, so if a cursor could carry a comma
 * or a quote it could carry a filter.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ListTicketsQuerySchema } from '@shared/index';

import { ApiRouteError } from '@/lib/api/errors';
import {
  decodeTicketCursor,
  encodeTicketCursor,
  nextCursorFor,
} from '@/features/maintenance/domain';

import { TICKET_ID } from './_support/fixtures';

const CREATED_AT = '2026-11-01T08:00:00.000+00:00';

describe('round trip', () => {
  it('survives encode and decode', () => {
    const encoded = encodeTicketCursor({ createdAt: CREATED_AT, id: TICKET_ID });
    expect(decodeTicketCursor(encoded)).toEqual({ createdAt: CREATED_AT, id: TICKET_ID });
  });

  it('is base64url, so it survives a query string intact', () => {
    const encoded = encodeTicketCursor({ createdAt: CREATED_AT, id: TICKET_ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    // `+` would arrive as a space and `=` would need escaping.
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('=');
  });

  it('handles the microsecond precision Postgres actually returns', () => {
    const precise = '2026-11-01T08:00:00.123456+00:00';
    const encoded = encodeTicketCursor({ createdAt: precise, id: TICKET_ID });
    expect(decodeTicketCursor(encoded).createdAt).toBe(precise);
  });

  it('fits inside the shared cursor length bound', () => {
    const encoded = encodeTicketCursor({ createdAt: CREATED_AT, id: TICKET_ID });
    expect(ListTicketsQuerySchema.safeParse({ cursor: encoded }).success).toBe(true);
  });
});

describe('a hostile cursor is a 400, not a query', () => {
  const rejected: [string, string][] = [
    ['not base64url at all', 'not a cursor!'],
    ['base64url of nothing', ''],
    ['base64url with no separator', Buffer.from('nonsense').toString('base64url')],
    ['a non-UUID id', Buffer.from(`${CREATED_AT}|not-a-uuid`).toString('base64url')],
    ['a non-timestamp position', Buffer.from(`tomorrow|${TICKET_ID}`).toString('base64url')],
    [
      'a PostgREST filter smuggled into the timestamp',
      Buffer.from(`2026-11-01T08:00:00.000+00:00",or(organization_id.neq.x|${TICKET_ID}`).toString(
        'base64url',
      ),
    ],
    [
      'a quote smuggled into the id',
      Buffer.from(`${CREATED_AT}|${TICKET_ID}"`).toString('base64url'),
    ],
  ];

  for (const [label, cursor] of rejected) {
    it(`rejects ${label}`, () => {
      try {
        decodeTicketCursor(cursor);
        expect.unreachable('a malformed cursor must throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ApiRouteError);
        expect((error as ApiRouteError).code).toBe('VALIDATION_ERROR');
        expect((error as ApiRouteError).status).toBe(400);
      }
    });
  }

  it('does not quietly fall back to page one', () => {
    // Returning the first page for a broken cursor would make a paging bug invisible in
    // the client and in the logs.
    expect(() => decodeTicketCursor('!!!')).toThrow();
  });
});

describe('next cursor', () => {
  const rows = [
    { created_at: '2026-11-03T08:00:00.000+00:00', id: TICKET_ID },
    { created_at: '2026-11-02T08:00:00.000+00:00', id: '33333333-3333-4333-8333-333333333334' },
  ];

  it('is null on the last page', () => {
    expect(nextCursorFor(rows, false)).toBeNull();
  });

  it('points at the LAST row of the page, not the first', () => {
    const cursor = nextCursorFor(rows, true);
    expect(cursor).not.toBeNull();
    expect(decodeTicketCursor(cursor!)).toEqual({
      createdAt: rows[1]!.created_at,
      id: rows[1]!.id,
    });
  });

  it('is null for an empty page even when more rows are claimed', () => {
    expect(nextCursorFor([], true)).toBeNull();
  });
});

describe('the shared page-size bounds are the only ones', () => {
  it('defaults to 25 and caps at 100 (§5.7)', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(MAX_PAGE_SIZE).toBe(100);
    expect(ListTicketsQuerySchema.parse({}).limit).toBe(25);
    expect(ListTicketsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('cannot be bypassed by repeating the parameter', () => {
    // `withApiHandler` collapses repeated keys to an array precisely so a second
    // `limit=10000` cannot slip past a schema that only sees the first.
    expect(ListTicketsQuerySchema.safeParse({ limit: ['25', '10000'] }).success).toBe(false);
  });
});
