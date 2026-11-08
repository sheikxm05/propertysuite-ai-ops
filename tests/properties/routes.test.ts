/**
 * The property and unit route handlers, end to end through the real wrapper.
 *
 * `withApiHandler` is **not** mocked: the real role gate, the real Zod validation, the
 * real rate limiter, the real SQLSTATE mapping and the real frozen envelope all run. So
 * does `authorize()` and all of `features/properties/**`. Three modules are replaced, and
 * each is covered by its own suite or by the live-database suite:
 *
 *   @/lib/supabase/server   the transport — see `support/fake-supabase.ts` for why
 *   @/lib/auth/session      covered by `lib/api/__tests__/with-handler.test.ts`
 *   @/lib/auth/roles        covered by the same, and by `tests/rls/**` against real RLS
 *   @/lib/audit/write       captured here so the audit assertion can be made at all
 *
 * The point of this file over `service.test.ts` is the *contract*: status codes, the
 * `{ data }` / `{ data, next_cursor }` success envelopes, the
 * `{ error: { code, message, request_id } }` failure envelope, and the `Location` header —
 * `docs/api-contracts.md` field for field.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ADMIN_A,
  IDS,
  MANAGER_A,
  ORG_A,
  ORG_B,
  OWNER_A,
  PROVIDER_A,
  TENANT_A,
  memberRow,
  propertyRow,
  unitRow,
} from './support/world';
import {
  createFakeClient,
  fails,
  rows,
  sequence,
  type FakeClient,
  type Responder,
} from './support/fake-supabase';

/* ------------------------------------------------------------------ mocks -- */

const harness = vi.hoisted(() => ({
  /** Swapped per test. The route reads whatever is here when it builds its client. */
  client: null as unknown,
  membership: null as unknown,
  auditCalls: [] as {
    action: string;
    entityType: string;
    entityId: unknown;
    organizationId: string;
    metadata?: Record<string, unknown>;
  }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createRouteHandlerClient: () => ({ supabase: harness.client, pendingCookies: [] }),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSessionFromClient: async () => ({
    userId: 'auth-user-fixture',
    email: 'principal@example.test',
    lastSignInAt: null,
  }),
}));

vi.mock('@/lib/auth/roles', () => ({
  requireMembership: async () => harness.membership,
  membershipLogFields: (m: { organization: { id: string }; role: string }) => ({
    organization_id: m.organization.id,
    role: m.role,
  }),
}));

vi.mock('@/lib/audit/write', () => ({
  writeAuditLog: async (
    _client: unknown,
    entry: {
      action: string;
      entityType: string;
      entityId: unknown;
      organizationId: string;
      metadata?: Record<string, unknown>;
    },
  ) => {
    harness.auditCalls.push(entry);
    return { written: true, auditId: 'audit-fixture', reason: null };
  },
}));

import { PropertyListResponseSchema, UnitListResponseSchema } from '@shared/index';
import { resetRateLimits } from '@/lib/rate-limit';
import { GET as listProperties, POST as createPropertyRoute } from '@/app/api/v1/properties/route';
import {
  GET as getPropertyRoute,
  PATCH as patchPropertyRoute,
} from '@/app/api/v1/properties/[propertyId]/route';
import { POST as archivePropertyRoute } from '@/app/api/v1/properties/[propertyId]/archive/route';
import {
  GET as listUnitsRoute,
  POST as createUnitRoute,
} from '@/app/api/v1/properties/[propertyId]/units/route';
import {
  GET as getUnitRoute,
  PATCH as patchUnitRoute,
} from '@/app/api/v1/properties/[propertyId]/units/[unitId]/route';

/* ---------------------------------------------------------------- helpers -- */

const BASE = 'https://app.example.test';

function use(responders: Record<string, Responder>): FakeClient {
  const fake = createFakeClient(responders);
  harness.client = fake.client;
  return fake;
}

function as(membership: unknown): void {
  harness.membership = membership;
}

function get(path: string): Request {
  return new Request(`${BASE}${path}`, { method: 'GET' });
}

function send(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** Next.js hands a dynamic route its params as a promise. */
function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) };
}

interface Envelope {
  error?: { code: string; message: string; request_id: string };
  data?: unknown;
  /** `listResponseSchema` in `packages/shared` — see the note on the list routes. */
  page_info?: { next_cursor: string | null; has_more: boolean; limit: number };
}

async function body(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}

/** Every failure body must be exactly the frozen shape, with no extra keys. */
async function expectFrozenEnvelope(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  const payload = await body(response);
  expect(Object.keys(payload)).toEqual(['error']);
  expect(Object.keys(payload.error ?? {}).sort()).toEqual(['code', 'message', 'request_id']);
  expect(payload.error?.code).toBe(code);
  expect(payload.error?.request_id).toBeTruthy();
  expect(response.headers.get('x-request-id')).toBe(payload.error?.request_id);
  // Every response is tenant-scoped, so none of them may be cached by a shared cache.
  expect(response.headers.get('cache-control')).toBe('no-store');
  return payload;
}

const CREATE_BODY = {
  name: 'Marina Residence',
  property_type: 'apartment_building',
  address_line: 'Example Street',
  city: 'Dubai',
  emirate: 'Dubai',
};

beforeEach(() => {
  harness.auditCalls.length = 0;
  harness.client = null;
  as(MANAGER_A);
  resetRateLimits();
  // The wrapper logs a line per request; keep the output readable.
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------- GET /api/v1/properties -- */

describe('GET /api/v1/properties', () => {
  it('returns the cursor-page envelope from docs/api-contracts.md', async () => {
    use({ properties: rows(propertyRow()) });

    const response = await listProperties(get('/api/v1/properties'));
    const payload = await body(response);

    expect(response.status).toBe(200);
    expect(Object.keys(payload).sort()).toEqual(['data', 'page_info']);
    expect(Array.isArray(payload.data)).toBe(true);
    expect(Object.keys(payload.page_info ?? {}).sort()).toEqual([
      'has_more',
      'limit',
      'next_cursor',
    ]);
    expect(payload.page_info?.next_cursor).toBeNull();
    expect(payload.page_info?.has_more).toBe(false);
    expect(payload.page_info?.limit).toBe(25);
    // No total count and no page index — §5.7.
    expect(payload).not.toHaveProperty('total');
    expect(payload).not.toHaveProperty('page');
    expect(payload.page_info).not.toHaveProperty('total');
  });

  it('returns a next cursor when the over-fetched row came back', async () => {
    const page = Array.from({ length: 26 }, (_, index) =>
      propertyRow({
        id: `aaaa0001-0001-4001-8001-${String(index).padStart(12, '0')}`,
        created_at: `2026-01-10T08:00:${String(index).padStart(2, '0')}+00:00`,
      }),
    );
    use({ properties: rows(...page) });

    const payload = await body(await listProperties(get('/api/v1/properties')));

    expect((payload.data as unknown[]).length).toBe(25);
    expect(typeof payload.page_info?.next_cursor).toBe('string');
    expect(payload.page_info?.has_more).toBe(true);
  });

  it('rejects a malformed cursor with VALIDATION_ERROR 400', async () => {
    use({});
    const response = await listProperties(get('/api/v1/properties?cursor=not-a-cursor'));
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('rejects a limit above the frozen maximum of 100', async () => {
    use({});
    const response = await listProperties(get('/api/v1/properties?limit=1000'));
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('rejects an unknown query parameter, so a probe is visible in the logs', async () => {
    use({});
    const response = await listProperties(get('/api/v1/properties?organization_id=' + ORG_B));
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('is open to every role, and each gets only their own visible set', async () => {
    // tenant
    use({
      tenancies: rows({ property_unit_id: IDS.a.p1u1 }),
      property_units: rows({ id: IDS.a.p1u1, property_id: IDS.a.p1 }),
      properties: rows(propertyRow({ id: IDS.a.p1 }), propertyRow({ id: IDS.a.p2 })),
    });
    as(TENANT_A);
    let payload = await body(await listProperties(get('/api/v1/properties')));
    expect((payload.data as { id: string }[]).map((row) => row.id)).toEqual([IDS.a.p1]);

    // provider
    resetRateLimits();
    use({
      maintenance_tickets: rows({ property_id: IDS.a.p1, property_unit_id: IDS.a.p1u1 }),
      properties: rows(propertyRow({ id: IDS.a.p1 }), propertyRow({ id: IDS.a.p2 })),
    });
    as(PROVIDER_A);
    payload = await body(await listProperties(get('/api/v1/properties')));
    expect((payload.data as { id: string }[]).map((row) => row.id)).toEqual([IDS.a.p1]);

    // owner
    resetRateLimits();
    use({ properties: rows(propertyRow({ id: IDS.a.p1 })) });
    as(OWNER_A);
    payload = await body(await listProperties(get('/api/v1/properties')));
    expect((payload.data as { id: string }[]).map((row) => row.id)).toEqual([IDS.a.p1]);
  });

  it('drops a cross-organization row even though the database returned it', async () => {
    use({
      properties: rows(
        propertyRow({ id: IDS.a.p1 }),
        propertyRow({ id: IDS.b.p1, organization_id: ORG_B }),
      ),
    });

    const payload = await body(await listProperties(get('/api/v1/properties')));
    const ids = (payload.data as { id: string }[]).map((row) => row.id);

    expect(ids).toEqual([IDS.a.p1]);
    expect(ids).not.toContain(IDS.b.p1);
  });

  it('writes no audit row for a read', async () => {
    use({ properties: rows(propertyRow()) });
    await listProperties(get('/api/v1/properties'));
    expect(harness.auditCalls).toHaveLength(0);
  });
});

/* ------------------------------------------------ POST /api/v1/properties -- */

describe('POST /api/v1/properties', () => {
  it('returns 201 with the resource envelope, a Location header and an audit row', async () => {
    use({ properties: rows(propertyRow()) });

    const response = await createPropertyRoute(send('/api/v1/properties', 'POST', CREATE_BODY));
    const payload = await body(response);

    expect(response.status).toBe(201);
    expect(Object.keys(payload)).toEqual(['data']);
    expect(response.headers.get('location')).toBe(`/api/v1/properties/${IDS.a.p1}`);

    expect(harness.auditCalls).toHaveLength(1);
    expect(harness.auditCalls[0]).toMatchObject({
      action: 'property_created',
      entityType: 'property',
      entityId: IDS.a.p1,
      organizationId: ORG_A,
    });
  });

  it('accepts the create body from docs/api-contracts.md verbatim', async () => {
    use({ properties: rows(propertyRow()) });
    const response = await createPropertyRoute(
      send('/api/v1/properties', 'POST', {
        name: 'Marina Residence',
        property_type: 'apartment_building',
        address_line: 'Example Street',
        city: 'Dubai',
        emirate: 'Dubai',
      }),
    );
    expect(response.status).toBe(201);
  });

  it('lets an administrator create too', async () => {
    as(ADMIN_A);
    use({ properties: rows(propertyRow()) });
    expect(
      (await createPropertyRoute(send('/api/v1/properties', 'POST', CREATE_BODY))).status,
    ).toBe(201);
  });

  it.each([
    ['a property owner', OWNER_A],
    ['a tenant', TENANT_A],
    ['a service provider', PROVIDER_A],
  ])('refuses %s with FORBIDDEN 403 and no audit row', async (_label, caller) => {
    as(caller);
    const fake = use({});

    const response = await createPropertyRoute(send('/api/v1/properties', 'POST', CREATE_BODY));

    await expectFrozenEnvelope(response, 'FORBIDDEN', 403);
    expect(harness.auditCalls).toHaveLength(0);
    // The coarse role gate runs before validation, so no statement was built.
    expect(fake.queries).toHaveLength(0);
  });

  it('refuses a body that smuggles organization_id, rather than ignoring the field', async () => {
    use({});
    const response = await createPropertyRoute(
      send('/api/v1/properties', 'POST', { ...CREATE_BODY, organization_id: ORG_B }),
    );
    // `.strict()` on every request schema makes a mass-assignment attempt a 400 that shows
    // up in the logs, instead of a silently stripped field.
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('refuses a body that tries to set the status', async () => {
    use({});
    const response = await createPropertyRoute(
      send('/api/v1/properties', 'POST', { ...CREATE_BODY, status: 'archived' }),
    );
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('answers an owner association outside the organization with UNPROCESSABLE 422', async () => {
    use({ organization_members: rows(memberRow({ organization_id: ORG_B })) });

    const response = await createPropertyRoute(
      send('/api/v1/properties', 'POST', { ...CREATE_BODY, owner_member_id: IDS.a.owner.member }),
    );

    await expectFrozenEnvelope(response, 'UNPROCESSABLE', 422);
    expect(harness.auditCalls).toHaveLength(0);
  });

  it('answers a tenant named as owner with UNPROCESSABLE 422', async () => {
    use({ organization_members: rows(memberRow({ role: 'tenant' })) });

    const response = await createPropertyRoute(
      send('/api/v1/properties', 'POST', { ...CREATE_BODY, owner_member_id: IDS.a.tenant.member }),
    );

    await expectFrozenEnvelope(response, 'UNPROCESSABLE', 422);
  });

  it('rejects a non-JSON content type', async () => {
    use({});
    const response = await createPropertyRoute(
      new Request(`${BASE}/api/v1/properties`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'name=Marina',
      }),
    );
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });
});

/* --------------------------------------- GET / PATCH /properties/{id} -- */

describe('GET /api/v1/properties/{propertyId}', () => {
  it('returns 200 with the resource envelope', async () => {
    use({ properties: rows(propertyRow()) });

    const response = await getPropertyRoute(
      get(`/api/v1/properties/${IDS.a.p1}`),
      params({ propertyId: IDS.a.p1 }),
    );

    expect(response.status).toBe(200);
    expect(Object.keys(await body(response))).toEqual(['data']);
  });

  it('answers a path segment that is not a UUID with 400, not a database error', async () => {
    use({});
    const response = await getPropertyRoute(
      get('/api/v1/properties/not-a-uuid'),
      params({ propertyId: 'not-a-uuid' }),
    );
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('answers another organization’s property with 404, never 403', async () => {
    use({ properties: rows(propertyRow({ id: IDS.b.p1, organization_id: ORG_B })) });

    const response = await getPropertyRoute(
      get(`/api/v1/properties/${IDS.b.p1}`),
      params({ propertyId: IDS.b.p1 }),
    );

    const payload = await expectFrozenEnvelope(response, 'NOT_FOUND', 404);
    // The response must be indistinguishable from "no such property".
    expect(payload.error?.message).not.toMatch(/organization|forbidden|permission/i);
  });

  it('answers an absent property with the identical 404 body', async () => {
    use({ properties: rows() });
    const absent = await getPropertyRoute(
      get(`/api/v1/properties/${IDS.a.p2}`),
      params({ propertyId: IDS.a.p2 }),
    );
    const absentBody = await expectFrozenEnvelope(absent, 'NOT_FOUND', 404);

    resetRateLimits();
    use({ properties: rows(propertyRow({ id: IDS.b.p1, organization_id: ORG_B })) });
    const foreign = await getPropertyRoute(
      get(`/api/v1/properties/${IDS.b.p1}`),
      params({ propertyId: IDS.b.p1 }),
    );
    const foreignBody = await expectFrozenEnvelope(foreign, 'NOT_FOUND', 404);

    expect(absentBody.error?.code).toBe(foreignBody.error?.code);
    expect(absentBody.error?.message).toBe(foreignBody.error?.message);
  });

  it('lets a property owner read the property they own', async () => {
    as(OWNER_A);
    use({ properties: rows(propertyRow()) });

    const response = await getPropertyRoute(
      get(`/api/v1/properties/${IDS.a.p1}`),
      params({ propertyId: IDS.a.p1 }),
    );
    expect(response.status).toBe(200);
  });
});

describe('PATCH /api/v1/properties/{propertyId}', () => {
  it('returns 200 and writes an audit row', async () => {
    use({
      'properties:select': rows(propertyRow()),
      'properties:update': rows(propertyRow({ name: 'Renamed' })),
    });

    const response = await patchPropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}`, 'PATCH', { name: 'Renamed' }),
      params({ propertyId: IDS.a.p1 }),
    );

    expect(response.status).toBe(200);
    expect(harness.auditCalls[0]).toMatchObject({
      action: 'property_updated',
      entityType: 'property',
      entityId: IDS.a.p1,
      organizationId: ORG_A,
    });
  });

  it('puts no property name or address into the audit metadata', async () => {
    use({
      'properties:select': rows(propertyRow()),
      'properties:update': rows(propertyRow({ name: 'Renamed' })),
    });

    await patchPropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}`, 'PATCH', { name: 'Renamed' }),
      params({ propertyId: IDS.a.p1 }),
    );

    const metadata = harness.auditCalls[0]?.metadata ?? {};

    // The handler contributes ids and enum-valued state only; `withApiHandler` adds the
    // correlation fields. Every key must be on the logger's allowlist, and none of them
    // may carry the property name — an audit row is readable by an administrator and lives
    // forever, so it must describe the change without becoming a second copy of the data.
    expect(Object.keys(metadata).sort()).toEqual([
      'method',
      'property_id',
      'request_id',
      'route',
      'status',
    ]);
    expect(JSON.stringify(metadata)).not.toContain('Renamed');
    expect(JSON.stringify(metadata)).not.toContain('Example Street');
  });

  it('refuses a property owner with 403 — the owner is read-only', async () => {
    as(OWNER_A);
    use({});

    const response = await patchPropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}`, 'PATCH', { name: 'Renamed' }),
      params({ propertyId: IDS.a.p1 }),
    );

    await expectFrozenEnvelope(response, 'FORBIDDEN', 403);
    expect(harness.auditCalls).toHaveLength(0);
  });

  it('rejects an empty patch', async () => {
    use({});
    const response = await patchPropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}`, 'PATCH', {}),
      params({ propertyId: IDS.a.p1 }),
    );
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('archives through the status field', async () => {
    use({
      'properties:select': rows(propertyRow()),
      'properties:update': rows(propertyRow({ status: 'archived' })),
    });

    const response = await patchPropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}`, 'PATCH', { status: 'archived' }),
      params({ propertyId: IDS.a.p1 }),
    );

    expect(response.status).toBe(200);
    expect(((await body(response)).data as { status: string }).status).toBe('archived');
  });
});

/* ---------------------------------- POST /properties/{id}/archive -- */

describe('POST /api/v1/properties/{propertyId}/archive', () => {
  it('archives rather than deletes, and audits the action by name', async () => {
    const fake = use({
      'properties:select': rows(propertyRow()),
      'properties:update': rows(propertyRow({ status: 'archived' })),
    });

    const response = await archivePropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}/archive`, 'POST'),
      params({ propertyId: IDS.a.p1 }),
    );

    expect(response.status).toBe(200);
    expect(((await body(response)).data as { status: string }).status).toBe('archived');
    expect(harness.auditCalls[0]).toMatchObject({
      action: 'property_archived',
      entityType: 'property',
      entityId: IDS.a.p1,
    });

    // The row still exists. No statement was a delete, and the fake has no delete to call.
    expect(fake.queries.map((query) => query.operation)).toEqual(['select', 'update']);
  });

  it('is idempotent', async () => {
    use({ 'properties:select': rows(propertyRow({ status: 'archived' })) });

    const response = await archivePropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}/archive`, 'POST'),
      params({ propertyId: IDS.a.p1 }),
    );

    expect(response.status).toBe(200);
  });

  it('refuses a non-staff caller with 403', async () => {
    as(OWNER_A);
    use({});
    const response = await archivePropertyRoute(
      send(`/api/v1/properties/${IDS.a.p1}/archive`, 'POST'),
      params({ propertyId: IDS.a.p1 }),
    );
    await expectFrozenEnvelope(response, 'FORBIDDEN', 403);
  });

  it('answers another organization’s property with 404', async () => {
    use({ 'properties:select': rows(propertyRow({ id: IDS.b.p1, organization_id: ORG_B })) });
    const response = await archivePropertyRoute(
      send(`/api/v1/properties/${IDS.b.p1}/archive`, 'POST'),
      params({ propertyId: IDS.b.p1 }),
    );
    await expectFrozenEnvelope(response, 'NOT_FOUND', 404);
  });
});

/* ---------------------------------------- units routes -- */

describe('GET /api/v1/properties/{propertyId}/units', () => {
  it('returns the cursor-page envelope', async () => {
    use({ 'properties:select': rows(propertyRow()), 'property_units:select': rows(unitRow()) });

    const response = await listUnitsRoute(
      get(`/api/v1/properties/${IDS.a.p1}/units`),
      params({ propertyId: IDS.a.p1 }),
    );

    expect(response.status).toBe(200);
    expect(Object.keys(await body(response)).sort()).toEqual(['data', 'page_info']);
  });

  it('answers an unreachable property with 404 rather than an empty page', async () => {
    use({ 'properties:select': rows() });

    const response = await listUnitsRoute(
      get(`/api/v1/properties/${IDS.a.p2}/units`),
      params({ propertyId: IDS.a.p2 }),
    );

    await expectFrozenEnvelope(response, 'NOT_FOUND', 404);
  });

  it('gives a tenant only their leased unit', async () => {
    as(TENANT_A);
    use({
      tenancies: rows({ property_unit_id: IDS.a.p1u1 }),
      'properties:select': rows(propertyRow()),
      'property_units:select': sequence(
        { rows: [{ id: IDS.a.p1u1, property_id: IDS.a.p1 }] },
        {
          rows: [unitRow({ id: IDS.a.p1u1 }), unitRow({ id: IDS.a.p1u2, unit_number: '1808' })],
        },
      ),
    });

    const payload = await body(
      await listUnitsRoute(
        get(`/api/v1/properties/${IDS.a.p1}/units`),
        params({ propertyId: IDS.a.p1 }),
      ),
    );

    expect((payload.data as { id: string }[]).map((row) => row.id)).toEqual([IDS.a.p1u1]);
  });
});

describe('POST /api/v1/properties/{propertyId}/units', () => {
  it('returns 201 with a Location header and an audit row', async () => {
    use({ 'properties:select': rows(propertyRow()), 'property_units:insert': rows(unitRow()) });

    const response = await createUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units`, 'POST', { unit_number: '1204' }),
      params({ propertyId: IDS.a.p1 }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe(
      `/api/v1/properties/${IDS.a.p1}/units/${IDS.a.p1u1}`,
    );
    expect(harness.auditCalls[0]).toMatchObject({
      action: 'unit_created',
      entityType: 'property_unit',
      entityId: IDS.a.p1u1,
    });
  });

  it('answers a duplicate unit number with CONFLICT 409', async () => {
    use({
      'properties:select': rows(propertyRow()),
      'property_units:insert': fails(
        '23505',
        'duplicate key value violates unique constraint "property_units_property_id_unit_number_key"',
      ),
    });

    const response = await createUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units`, 'POST', { unit_number: '1204' }),
      params({ propertyId: IDS.a.p1 }),
    );

    const payload = await expectFrozenEnvelope(response, 'CONFLICT', 409);
    // The raw Postgres message can echo row data and must not reach the client.
    expect(payload.error?.message).not.toContain('duplicate key');
    expect(payload.error?.message).not.toContain('property_units_property_id_unit_number_key');
    expect(harness.auditCalls).toHaveLength(0);
  });

  it('rejects a body that tries to set property_id', async () => {
    use({});
    const response = await createUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units`, 'POST', {
        unit_number: '1204',
        property_id: IDS.a.p2,
      }),
      params({ propertyId: IDS.a.p1 }),
    );
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('refuses a property owner with 403', async () => {
    as(OWNER_A);
    use({});
    const response = await createUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units`, 'POST', { unit_number: '1204' }),
      params({ propertyId: IDS.a.p1 }),
    );
    await expectFrozenEnvelope(response, 'FORBIDDEN', 403);
  });

  it('refuses a unit on an archived property with 409', async () => {
    use({ 'properties:select': rows(propertyRow({ status: 'archived' })) });
    const response = await createUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units`, 'POST', { unit_number: '1204' }),
      params({ propertyId: IDS.a.p1 }),
    );
    await expectFrozenEnvelope(response, 'CONFLICT', 409);
  });
});

describe('GET / PATCH /api/v1/properties/{propertyId}/units/{unitId}', () => {
  it('answers a unit that belongs to another property with 404', async () => {
    use({
      'properties:select': rows(propertyRow({ id: IDS.a.p1 })),
      'property_units:select': rows(unitRow({ id: IDS.a.p2u1, property_id: IDS.a.p2 })),
    });

    const response = await getUnitRoute(
      get(`/api/v1/properties/${IDS.a.p1}/units/${IDS.a.p2u1}`),
      params({ propertyId: IDS.a.p1, unitId: IDS.a.p2u1 }),
    );

    await expectFrozenEnvelope(response, 'NOT_FOUND', 404);
  });

  it('rejects a unit id that is not a UUID with 400', async () => {
    use({});
    const response = await getUnitRoute(
      get(`/api/v1/properties/${IDS.a.p1}/units/nope`),
      params({ propertyId: IDS.a.p1, unitId: 'nope' }),
    );
    await expectFrozenEnvelope(response, 'VALIDATION_ERROR', 400);
  });

  it('applies a legal status transition and audits from/to', async () => {
    use({
      'properties:select': rows(propertyRow()),
      'property_units:select': rows(unitRow({ status: 'occupied' })),
      'property_units:update': rows(unitRow({ status: 'available' })),
    });

    const response = await patchUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units/${IDS.a.p1u1}`, 'PATCH', { status: 'available' }),
      params({ propertyId: IDS.a.p1, unitId: IDS.a.p1u1 }),
    );

    expect(response.status).toBe(200);
    expect(harness.auditCalls[0]).toMatchObject({
      action: 'unit_updated',
      entityType: 'property_unit',
      entityId: IDS.a.p1u1,
      metadata: {
        property_id: IDS.a.p1,
        unit_id: IDS.a.p1u1,
        from_status: 'occupied',
        to_status: 'available',
      },
    });
  });

  it('answers an illegal status transition with CONFLICT 409 and no audit row', async () => {
    use({
      'properties:select': rows(propertyRow()),
      'property_units:select': rows(unitRow({ status: 'occupied' })),
    });

    const response = await patchUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units/${IDS.a.p1u1}`, 'PATCH', { status: 'inactive' }),
      params({ propertyId: IDS.a.p1, unitId: IDS.a.p1u1 }),
    );

    await expectFrozenEnvelope(response, 'CONFLICT', 409);
    expect(harness.auditCalls).toHaveLength(0);
  });

  it('refuses the wrong role with 403 — an illegal edge is 409, the wrong role is 403', async () => {
    as(OWNER_A);
    use({});

    const response = await patchUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units/${IDS.a.p1u1}`, 'PATCH', { status: 'occupied' }),
      params({ propertyId: IDS.a.p1, unitId: IDS.a.p1u1 }),
    );

    await expectFrozenEnvelope(response, 'FORBIDDEN', 403);
  });

  it('archives a unit by setting it inactive — there is no delete export on the route', async () => {
    use({
      'properties:select': rows(propertyRow()),
      'property_units:select': rows(unitRow({ status: 'available' })),
      'property_units:update': rows(unitRow({ status: 'inactive' })),
    });

    const response = await patchUnitRoute(
      send(`/api/v1/properties/${IDS.a.p1}/units/${IDS.a.p1u1}`, 'PATCH', { status: 'inactive' }),
      params({ propertyId: IDS.a.p1, unitId: IDS.a.p1u1 }),
    );

    expect(response.status).toBe(200);
    expect(((await body(response)).data as { status: string }).status).toBe('inactive');
  });
});

/* ------------------------------------------------------- the DELETE gate -- */

describe('no route in this lane exports a DELETE handler', () => {
  it('holds for every property and unit route module', async () => {
    // `authenticated` holds the DELETE privilege on no table in this database, so a DELETE
    // handler could not work even if one existed. This asserts none does — including on a
    // nested route, where a stray export is easy to miss in review.
    const modules = await Promise.all([
      import('@/app/api/v1/properties/route'),
      import('@/app/api/v1/properties/[propertyId]/route'),
      import('@/app/api/v1/properties/[propertyId]/archive/route'),
      import('@/app/api/v1/properties/[propertyId]/units/route'),
      import('@/app/api/v1/properties/[propertyId]/units/[unitId]/route'),
    ]);

    // Not named `module`: `@next/next/no-assign-module-variable` reserves that identifier.
    for (const routeModule of modules) {
      expect(Object.keys(routeModule)).not.toContain('DELETE');
      expect(Object.keys(routeModule)).not.toContain('PUT');
    }
  });
});

/* ------------------------------------------------------- ruling A18 ------- */

describe('ruling A18 — the list envelope is the frozen packages/shared shape', () => {
  it('GET /properties validates against PropertyListResponseSchema', async () => {
    use({ properties: rows(propertyRow()) });

    const payload = await body(await listProperties(get('/api/v1/properties')));

    // The real proof of A18: not "the keys look right", but that the frozen per-domain
    // schema a client would validate against actually accepts this response. The schema is
    // `.strict()` at both levels, so an extra key or a flat `next_cursor` fails here.
    const parsed = PropertyListResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('GET /properties/{id}/units validates against UnitListResponseSchema', async () => {
    use({ 'properties:select': rows(propertyRow()), 'property_units:select': rows(unitRow()) });

    const payload = await body(
      await listUnitsRoute(
        get(`/api/v1/properties/${IDS.a.p1}/units`),
        params({ propertyId: IDS.a.p1 }),
      ),
    );

    const parsed = UnitListResponseSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('rejects the pre-A18 flat envelope, so a regression cannot pass silently', () => {
    // Guards the ruling itself. If someone restores `paginated()` at the call site, the two
    // tests above fail — this one proves they fail for the right reason rather than because
    // the schema accepts anything.
    const flat = { data: [propertyRow()], next_cursor: null };
    expect(PropertyListResponseSchema.safeParse(flat).success).toBe(false);
  });

  it('reports has_more independently of next_cursor, which is A18’s stated reason', async () => {
    const page = Array.from({ length: 26 }, (_, index) =>
      propertyRow({
        id: `aaaa0001-0001-4001-8001-${String(index).padStart(12, '0')}`,
        created_at: `2026-01-10T08:00:${String(index).padStart(2, '0')}+00:00`,
      }),
    );
    use({ properties: rows(...page) });

    const full = await body(await listProperties(get('/api/v1/properties')));
    expect(full.page_info?.has_more).toBe(true);
    expect(full.page_info?.limit).toBe(25);

    // A short page is normal on an RLS-filtered list. `has_more: false` is what tells a
    // client that is the end, rather than a cursor the server forgot to issue.
    resetRateLimits();
    use({ properties: rows(propertyRow()) });
    const short = await body(await listProperties(get('/api/v1/properties?limit=100')));
    expect((short.data as unknown[]).length).toBe(1);
    expect(short.page_info?.has_more).toBe(false);
    expect(short.page_info?.next_cursor).toBeNull();
    expect(short.page_info?.limit).toBe(100);
  });
});
