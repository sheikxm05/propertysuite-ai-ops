/**
 * The list response envelope — amendment **A18**.
 *
 * The shape was defined twice and incompatibly: `listResponseSchema()` in
 * `packages/shared` emits `{ data, page_info: { next_cursor, has_more, limit } }`, and
 * `paginated()` in `lib/api/responses.ts` emitted `{ data, next_cursor }`. A18 rules for
 * the contract package. These tests pin that decision at the two places this lane could
 * regress it — the helper that builds the body, and the real output of both list
 * services — so a later edit that reaches back for `paginated()` fails here rather than
 * shipping a second API shape.
 *
 * `has_more` is the part worth testing rather than merely emitting. On a list filtered by
 * Row Level Security *and* re-filtered row by row in application space, a short page is
 * the normal case: the visible row set differs per caller. `next_cursor` alone cannot
 * distinguish "that was the last page" from "the server failed to issue a cursor", and in
 * this application the first is common and the second is a defect.
 */

import { describe, expect, it } from 'vitest';

import {
  ListTenanciesQuerySchema,
  ListTenantsQuerySchema,
  TenancyListResponseSchema,
  TenantListResponseSchema,
} from '@shared/index';

import { pageBody, type DataContext, type Page } from '@/features/tenants/server/context';
import { listTenants } from '@/features/tenants/server/tenant-service';
import { listTenancies } from '@/features/tenancies/server/tenancy-service';

import { createFakeClient } from './_support/fake-postgrest';
import { membership, seedTables, testLogger } from './_support/fixtures';
import type { MemberRole } from '@shared/index';

function context(role: MemberRole): DataContext {
  const fake = createFakeClient({ tables: seedTables() });
  return { supabase: fake.client, membership: membership(role), logger: testLogger() };
}

describe('pageBody', () => {
  const page: Page<{ id: string }> = {
    items: [{ id: 'a' }, { id: 'b' }],
    nextCursor: 'opaque-cursor',
    hasMore: true,
    limit: 25,
  };

  it('emits data plus page_info, and nothing else', () => {
    const body = pageBody(page);

    expect(Object.keys(body).sort()).toEqual(['data', 'page_info']);
    expect(Object.keys(body.page_info).sort()).toEqual(['has_more', 'limit', 'next_cursor']);
  });

  it('does not emit the superseded top-level next_cursor', () => {
    // The pre-A18 shape. If this key ever reappears at the top level, two API shapes are
    // live at once, which is the thing the ruling exists to prevent.
    expect(pageBody(page)).not.toHaveProperty('next_cursor');
  });

  it('carries a null cursor on the last page rather than omitting the key', () => {
    const body = pageBody({ items: [], nextCursor: null, hasMore: false, limit: 25 });

    expect(body.page_info.next_cursor).toBeNull();
    expect(body.page_info.has_more).toBe(false);
    // Present-and-null, so a client branches on one shape.
    expect('next_cursor' in body.page_info).toBe(true);
  });

  it('reports has_more on a SHORT page, which is the case next_cursor cannot express', () => {
    // Two rows against a limit of 25, and more to come: the state produced by RLS or by
    // the application-space row filter dropping rows out of a full database page.
    const body = pageBody({ items: [{ id: 'a' }], nextCursor: 'c', hasMore: true, limit: 25 });

    expect(body.data).toHaveLength(1);
    expect(body.page_info.limit).toBe(25);
    expect(body.page_info.has_more).toBe(true);
    expect(body.page_info.next_cursor).not.toBeNull();
  });

  it('echoes the limit the caller actually got, not the one they asked for', () => {
    expect(pageBody({ ...page, limit: 100 }).page_info.limit).toBe(100);
  });
});

describe('the frozen schemas', () => {
  it('accept the A18 body and reject the superseded one', () => {
    const valid = { data: [], page_info: { next_cursor: null, has_more: false, limit: 25 } };

    expect(TenantListResponseSchema.safeParse(valid).success).toBe(true);
    expect(TenancyListResponseSchema.safeParse(valid).success).toBe(true);

    // `{ data, next_cursor }` — what `paginated()` used to emit.
    expect(TenantListResponseSchema.safeParse({ data: [], next_cursor: null }).success).toBe(false);
    expect(TenancyListResponseSchema.safeParse({ data: [], next_cursor: null }).success).toBe(
      false,
    );
  });

  it('are strict at both levels, so no undocumented field reaches the wire', () => {
    expect(
      TenantListResponseSchema.safeParse({
        data: [],
        page_info: { next_cursor: null, has_more: false, limit: 25 },
        total_count: 3,
      }).success,
    ).toBe(false);

    expect(
      TenantListResponseSchema.safeParse({
        data: [],
        page_info: { next_cursor: null, has_more: false, limit: 25, offset: 0 },
      }).success,
    ).toBe(false);
  });

  it('require every page_info field', () => {
    for (const partial of [
      { next_cursor: null, has_more: false },
      { next_cursor: null, limit: 25 },
      { has_more: false, limit: 25 },
    ]) {
      expect(TenantListResponseSchema.safeParse({ data: [], page_info: partial }).success).toBe(
        false,
      );
    }
  });
});

describe('what the list services actually produce', () => {
  it('validates GET /api/v1/tenants against the frozen contract', async () => {
    const page = await listTenants(context('property_manager'), ListTenantsQuerySchema.parse({}));

    // Exactly the expression the route hands to the schema.
    const parsed = TenantListResponseSchema.parse(pageBody(page));

    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.page_info.limit).toBe(25);
    expect(parsed.page_info.has_more).toBe(false);
  });

  it('validates GET /api/v1/tenancies against the frozen contract', async () => {
    const page = await listTenancies(
      context('property_manager'),
      ListTenanciesQuerySchema.parse({}),
    );

    const parsed = TenancyListResponseSchema.parse(pageBody(page));

    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.page_info.has_more).toBe(false);
    // Money survives the envelope as a canonical decimal string, not a float.
    expect(typeof parsed.data[0]?.rent_amount).toBe('string');
  });

  it("validates a tenant's own short page — one row, no cursor, has_more false", async () => {
    const page = await listTenancies(context('tenant'), ListTenanciesQuerySchema.parse({}));

    const parsed = TenancyListResponseSchema.parse(pageBody(page));

    // Two of the organization's four leases. Short, complete, and unambiguous only
    // because `has_more` says so.
    expect(parsed.data).toHaveLength(2);
    expect(parsed.page_info.has_more).toBe(false);
    expect(parsed.page_info.next_cursor).toBeNull();
  });

  it('issues a cursor and has_more together when a page is full', async () => {
    const page = await listTenancies(
      context('property_manager'),
      ListTenanciesQuerySchema.parse({ limit: '1' }),
    );

    const parsed = TenancyListResponseSchema.parse(pageBody(page));

    expect(parsed.data).toHaveLength(1);
    expect(parsed.page_info.has_more).toBe(true);
    expect(parsed.page_info.next_cursor).toEqual(expect.any(String));
  });
});
