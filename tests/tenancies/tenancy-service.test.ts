/**
 * `features/tenancies/server/tenancy-service.ts` — the rules no migration holds.
 *
 * Four of this lane's five invariants exist only in application space, so this is the
 * only suite that can fail when they break:
 *
 *   - an overlapping ACTIVE tenancy on one unit is rejected (no exclusion constraint);
 *   - the lifecycle edge set is enforced (no trigger);
 *   - `property_units.status` follows the active tenancy (denormalized, nothing derives it);
 *   - the embedded tenant is authorized separately, so a `property_owner` reading a lease
 *     on their own building receives no contact details.
 *
 * Plus the two that are also enforced elsewhere and are tested here anyway, on the
 * premise that the other layer may be broken: a tenant sees only their own tenancy, and
 * a cross-organization reference is refused.
 *
 * The fake PostgREST client applies no policy — see `tests/tenants/_support/fake-postgrest.ts`.
 * Row Level Security is proven by `tests/rls/**` against a real database; nothing here
 * substitutes for it.
 */

import { describe, expect, it } from 'vitest';

import { isApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';
import { ListTenanciesQuerySchema, UpdateTenancySchema, type MemberRole } from '@shared/index';

import type { DataContext } from '@/features/tenants/server/context';
import {
  createTenancy,
  getTenancyById,
  listExpiringTenancies,
  listOwnTenancies,
  listTenancies,
  tenancyReadScope,
  updateTenancy,
} from '@/features/tenancies/server/tenancy-service';

import { createFakeClient, type FakeClient, type Row } from '../tenants/_support/fake-postgrest';
import {
  ORG_A,
  TENANCY_ACTIVE,
  TENANCY_DRAFT,
  TENANCY_FOREIGN,
  TENANCY_OTHER_TENANT,
  TENANT_FOREIGN,
  TENANT_ONE,
  TENANT_TWO,
  UNIT_FOREIGN,
  UNIT_ONE,
  UNIT_TWO,
  foreignMembership,
  membership,
  seedTables,
  testLogger,
  type SeedTables,
} from '../tenants/_support/fixtures';

interface Harness {
  ctx: DataContext;
  fake: FakeClient;
  tables: SeedTables;
  logs: ReturnType<typeof testLogger>;
}

function harness(role: MemberRole, options: { foreign?: boolean } = {}): Harness {
  const tables = seedTables();
  const fake = createFakeClient({ tables });
  const logs = testLogger();

  return {
    ctx: {
      supabase: fake.client,
      membership: options.foreign ? foreignMembership(role) : membership(role),
      logger: logs,
    },
    fake,
    tables,
    logs,
  };
}

const defaultQuery = ListTenanciesQuerySchema.parse({});

/** A well-formed create body for unit two, which has no active tenancy in 2028. */
function createBody(overrides: Record<string, unknown> = {}) {
  return {
    property_unit_id: UNIT_ONE,
    tenant_id: TENANT_TWO,
    contract_number: 'EJARI-NEW',
    start_date: '2028-01-01',
    end_date: '2028-12-31',
    rent_amount: '100000.00',
    currency: 'AED',
    ...overrides,
  } as Parameters<typeof createTenancy>[1];
}

async function expectApiError(promise: Promise<unknown>, code: string, status: number) {
  try {
    await promise;
  } catch (thrown) {
    expect(isApiRouteError(thrown), `expected an ApiRouteError, got ${String(thrown)}`).toBe(true);
    if (isApiRouteError(thrown)) {
      expect(thrown.code).toBe(code);
      expect(thrown.status).toBe(status);
    }
    return thrown;
  }
  throw new Error(`expected ${code} but the call resolved`);
}

function unit(tables: SeedTables, id: string): Row | undefined {
  return tables.property_units.find((row) => row.id === id);
}

/* ------------------------------------------------------------------ scope -- */

describe('tenancyReadScope', () => {
  it('matches the §4 matrix row for tenancies', () => {
    expect(tenancyReadScope(membership('organization_admin'))).toEqual({ kind: 'organization' });
    expect(tenancyReadScope(membership('property_manager'))).toEqual({ kind: 'organization' });
    expect(tenancyReadScope(membership('property_owner'))).toEqual({ kind: 'owned_properties' });
    expect(tenancyReadScope(membership('tenant'))).toEqual({
      kind: 'own_tenant',
      tenantId: TENANT_ONE,
    });
    expect(tenancyReadScope(membership('service_provider'))).toEqual({ kind: 'denied' });
  });

  it('gives a tenant with no tenant record an empty scope, not a denial', () => {
    const unlinked = membership('tenant', { tenantId: null });

    // Authenticated with the tenant role but no `tenants` row is a legitimate state —
    // the record simply has not been linked yet.
    expect(tenancyReadScope(unlinked)).toEqual({ kind: 'empty' });
  });

  it('denies a disabled member and a suspended organization', () => {
    expect(tenancyReadScope(membership('property_manager', { status: 'disabled' }))).toEqual({
      kind: 'denied',
    });
    expect(
      tenancyReadScope(
        membership('property_manager', {
          organization: { id: ORG_A, name: 'A', slug: 'a', status: 'suspended' },
        }),
      ),
    ).toEqual({ kind: 'denied' });
  });
});

/* ------------------------------------------------------------------- read -- */

describe('listTenancies', () => {
  it('shows a manager the organization’s leases and not another organization’s', async () => {
    const { ctx } = harness('property_manager');

    const page = await listTenancies(ctx, defaultQuery);
    const ids = page.items.map((tenancy) => tenancy.id);

    expect(ids).toContain(TENANCY_ACTIVE);
    expect(ids).toContain(TENANCY_OTHER_TENANT);
    expect(ids).not.toContain(TENANCY_FOREIGN);
  });

  it('shows a tenant ONLY their own leases', async () => {
    const { ctx } = harness('tenant');

    const page = await listTenancies(ctx, defaultQuery);
    const ids = page.items.map((tenancy) => tenancy.id);

    expect(ids).toEqual(expect.arrayContaining([TENANCY_ACTIVE, TENANCY_DRAFT]));
    // The neighbour's active lease is in the fixture and the fake enforces no policy,
    // so its absence is the service's own filter.
    expect(ids).not.toContain(TENANCY_OTHER_TENANT);
    expect(ids).not.toContain(TENANCY_FOREIGN);
  });

  it('ignores a tenant’s attempt to ask about another tenant', async () => {
    const { ctx } = harness('tenant');

    const page = await listTenancies(
      ctx,
      ListTenanciesQuerySchema.parse({ tenant_id: TENANT_TWO }),
    );

    // Their own rows, not a 403: a denial would confirm the guessed id names a real
    // tenant.
    expect(page.items.every((tenancy) => tenancy.tenant_id === TENANT_ONE)).toBe(true);
  });

  it('pins the filter to the caller’s own tenant id', async () => {
    const { ctx, fake } = harness('tenant');
    await listTenancies(ctx, ListTenanciesQuerySchema.parse({ tenant_id: TENANT_TWO }));

    const filters = fake.against('tenancies')[0]?.filters ?? [];
    expect(filters).toEqual(
      expect.arrayContaining([{ method: 'eq', column: 'tenant_id', value: TENANT_ONE }]),
    );
    expect(filters).not.toEqual(
      expect.arrayContaining([{ method: 'eq', column: 'tenant_id', value: TENANT_TWO }]),
    );
  });

  it('refuses a service provider outright', async () => {
    const { ctx } = harness('service_provider');

    await expect(listTenancies(ctx, defaultQuery)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('issues no query at all for a provider', async () => {
    const { ctx, fake } = harness('service_provider');
    await listTenancies(ctx, defaultQuery).catch(() => undefined);

    expect(fake.queries).toHaveLength(0);
  });

  it('returns an empty page for a tenant with no linked record', async () => {
    const tables = seedTables();
    const fake = createFakeClient({ tables });
    const ctx: DataContext = {
      supabase: fake.client,
      membership: membership('tenant', { tenantId: null }),
      logger: testLogger(),
    };

    const page = await listTenancies(ctx, defaultQuery);

    expect(page.items).toEqual([]);
    expect(fake.queries).toHaveLength(0);
  });

  it('shows an owner only the leases on properties they own', async () => {
    const { ctx } = harness('property_owner');

    const page = await listTenancies(ctx, defaultQuery);
    const ids = page.items.map((tenancy) => tenancy.id);

    // UNIT_ONE belongs to PROPERTY_OWNED (owner_member_id = this member). UNIT_TWO
    // belongs to PROPERTY_OTHER, owned by somebody else.
    expect(ids).toContain(TENANCY_ACTIVE);
    expect(ids).not.toContain(TENANCY_DRAFT);
    expect(ids).not.toContain(TENANCY_OTHER_TENANT);
  });

  it('logs a layer disagreement when it withholds a row the query returned', async () => {
    const { ctx, logs } = harness('property_owner');
    await listTenancies(ctx, defaultQuery);

    // The fake returns every organization-A row; the owner's own check drops the ones
    // on properties they do not own. The two layers are meant to agree, so each
    // disagreement is recorded rather than silently handled.
    const warnings = logs.records.filter(
      (record) => record.fields.reason === 'authorization_layer_disagreement',
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('normalises rent to a fixed-scale decimal string, never a float', async () => {
    const { ctx } = harness('property_manager');

    const page = await listTenancies(ctx, defaultQuery);
    const draft = page.items.find((tenancy) => tenancy.id === TENANCY_DRAFT);

    // `95000.5` in the fixture — the shape a JSON number arrives in.
    expect(draft?.rent_amount).toBe('95000.50');
    expect(typeof draft?.rent_amount).toBe('string');

    const active = page.items.find((tenancy) => tenancy.id === TENANCY_ACTIVE);
    expect(active?.rent_amount).toBe('120000.00');
  });

  it('never selects a wildcard', async () => {
    const { ctx, fake } = harness('property_manager');
    await listTenancies(ctx, defaultQuery);

    for (const query of fake.queries) expect(query.select ?? '').not.toContain('*');
  });

  it('applies the keyset filter when a cursor is supplied', async () => {
    const { ctx, fake } = harness('property_manager');
    const cursor = Buffer.from(`2026-01-03T00:00:00+00:00|${TENANCY_DRAFT}`, 'utf8').toString(
      'base64url',
    );

    await listTenancies(ctx, ListTenanciesQuerySchema.parse({ cursor }));

    const or = fake.against('tenancies')[0]?.filters.find((filter) => filter.method === 'or');
    expect(String(or?.value)).toContain('created_at.lt."2026-01-03T00:00:00+00:00"');
  });

  it('rejects a malformed cursor with 400 before querying', async () => {
    const { ctx, fake } = harness('property_manager');

    await expectApiError(
      listTenancies(ctx, ListTenanciesQuerySchema.parse({ cursor: 'not-a-cursor' })),
      'VALIDATION_ERROR',
      400,
    );
    expect(fake.against('tenancies')).toHaveLength(0);
  });
});

describe('getTenancyById', () => {
  it('embeds the tenant for staff', async () => {
    const { ctx } = harness('property_manager');

    const tenancy = await getTenancyById(ctx, TENANCY_ACTIVE);

    expect(tenancy.tenant?.email).toBe('tariq@example.test');
    expect(tenancy.unit?.unit_number).toBe('101');
  });

  it('embeds the tenant’s own record for that tenant', async () => {
    const { ctx } = harness('tenant');

    const tenancy = await getTenancyById(ctx, TENANCY_ACTIVE);

    expect(tenancy.tenant?.id).toBe(TENANT_ONE);
  });

  it('does NOT embed the tenant for a property owner', async () => {
    const { ctx } = harness('property_owner');

    const tenancy = await getTenancyById(ctx, TENANCY_ACTIVE);

    // The matrix gives an owner `R owned` on tenancies and a dash on tenants. The lease
    // is theirs to see; the person is not.
    expect(tenancy.tenant).toBeUndefined();
    expect(JSON.stringify(tenancy)).not.toContain('tariq@example.test');
    expect(JSON.stringify(tenancy)).not.toContain('+971500000001');
    // The lease itself is still fully present.
    expect(tenancy.rent_amount).toBe('120000.00');
  });

  it('never fetches the tenant row at all for an owner', async () => {
    const { ctx, fake } = harness('property_owner');
    await getTenancyById(ctx, TENANCY_ACTIVE);

    expect(fake.against('tenants')).toHaveLength(0);
  });

  it('refuses a tenant another tenant’s lease', async () => {
    const { ctx } = harness('tenant');

    await expectApiError(getTenancyById(ctx, TENANCY_OTHER_TENANT), 'NOT_FOUND', 404);
  });

  it('refuses an owner a lease on a property they do not own', async () => {
    const { ctx } = harness('property_owner');

    await expectApiError(getTenancyById(ctx, TENANCY_OTHER_TENANT), 'NOT_FOUND', 404);
  });

  it('refuses a provider in any case', async () => {
    const { ctx } = harness('service_provider');

    await expect(getTenancyById(ctx, TENANCY_ACTIVE)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('returns 404 for a lease in another organization', async () => {
    const { ctx } = harness('property_manager');

    await expectApiError(getTenancyById(ctx, TENANCY_FOREIGN), 'NOT_FOUND', 404);
  });
});

describe('listOwnTenancies', () => {
  it('returns the caller’s leases and nothing else', async () => {
    const { ctx } = harness('tenant');

    const own = await listOwnTenancies(ctx);

    expect(own.map((tenancy) => tenancy.id).sort()).toEqual([TENANCY_ACTIVE, TENANCY_DRAFT].sort());
    expect(own.every((tenancy) => tenancy.tenant_id === TENANT_ONE)).toBe(true);
  });

  it('returns nothing when the profile has no tenant record', async () => {
    const tables = seedTables();
    const fake = createFakeClient({ tables });

    const own = await listOwnTenancies({
      supabase: fake.client,
      membership: membership('tenant', { tenantId: null }),
      logger: testLogger(),
    });

    expect(own).toEqual([]);
    expect(fake.queries).toHaveLength(0);
  });

  it('has no parameter through which another tenant could be requested', () => {
    // The signature is the control: `(ctx, limit?)`. There is no identifier to tamper
    // with, which is the self-service guarantee stated as a type.
    expect(listOwnTenancies.length).toBeLessThanOrEqual(2);
  });
});

describe('listExpiringTenancies', () => {
  it('returns active leases inside the window, scoped by role', async () => {
    const { ctx, tables } = harness('property_manager');
    const row = tables.tenancies.find((candidate) => candidate.id === TENANCY_ACTIVE);
    if (row) row.end_date = '2026-11-20';

    const expiring = await listExpiringTenancies(ctx, { withinDays: 60 });

    expect(expiring.some((tenancy) => tenancy.id === TENANCY_ACTIVE)).toBe(
      // Only meaningful while "today" is before the adjusted end date; the pure
      // predicate is covered exhaustively in `occupancy.test.ts`.
      new Date().toISOString().slice(0, 10) <= '2026-11-20',
    );
  });

  it('returns nothing for a provider', async () => {
    const { ctx, fake } = harness('service_provider');

    expect(await listExpiringTenancies(ctx)).toEqual([]);
    expect(fake.queries).toHaveLength(0);
  });

  it('filters to active status and to the caller’s own tenant id for a tenant', async () => {
    const { ctx, fake } = harness('tenant');
    await listExpiringTenancies(ctx);

    const filters = fake.against('tenancies')[0]?.filters ?? [];
    expect(filters).toEqual(
      expect.arrayContaining([
        { method: 'eq', column: 'status', value: 'active' },
        { method: 'eq', column: 'tenant_id', value: TENANT_ONE },
      ]),
    );
  });
});

/* --------------------------------------------------- the overlap invariant -- */

describe('an overlapping ACTIVE tenancy on one unit', () => {
  it('is REJECTED with 409', async () => {
    const { ctx } = harness('property_manager');

    // UNIT_ONE already has an active lease for the whole of 2026.
    await expectApiError(
      createTenancy(
        ctx,
        createBody({ status: 'active', start_date: '2026-06-01', end_date: '2026-07-01' }),
      ),
      'CONFLICT',
      409,
    );
  });

  it('is rejected when it shares only the final day', async () => {
    const { ctx } = harness('property_manager');

    await expectApiError(
      createTenancy(
        ctx,
        createBody({ status: 'active', start_date: '2026-12-31', end_date: '2027-06-30' }),
      ),
      'CONFLICT',
      409,
    );
  });

  it('writes no row when it is rejected', async () => {
    const { ctx, tables } = harness('property_manager');
    const before = tables.tenancies.length;

    await createTenancy(
      ctx,
      createBody({ status: 'active', start_date: '2026-06-01', end_date: '2026-07-01' }),
    ).catch(() => undefined);

    expect(tables.tenancies).toHaveLength(before);
  });

  it('names the colliding lease in the log, never in the response', async () => {
    const { ctx } = harness('property_manager');

    const thrown = await expectApiError(
      createTenancy(
        ctx,
        createBody({ status: 'active', start_date: '2026-06-01', end_date: '2026-07-01' }),
      ),
      'CONFLICT',
      409,
    );

    if (isApiRouteError(thrown)) {
      expect(thrown.logFields).toMatchObject({ reason: 'tenancy_overlaps_active' });
      expect(thrown.publicMessage).not.toContain(TENANCY_ACTIVE);
    }
  });

  it('is ALLOWED when the new lease starts the day after the old one ends', async () => {
    const { ctx } = harness('property_manager');

    const result = await createTenancy(
      ctx,
      createBody({ status: 'active', start_date: '2027-01-01', end_date: '2027-12-31' }),
    );

    expect(result.tenancy.status).toBe('active');
  });

  it('is not triggered by a DRAFT on an occupied unit — a draft occupies nothing', async () => {
    const { ctx } = harness('property_manager');

    const result = await createTenancy(
      ctx,
      createBody({ status: 'draft', start_date: '2026-06-01', end_date: '2026-07-01' }),
    );

    expect(result.tenancy.status).toBe('draft');
  });

  it('is re-checked on a date change to an already active lease', async () => {
    const { ctx, tables } = harness('property_manager');
    // A second active lease on UNIT_TWO, after the existing one ends.
    tables.tenancies.push({
      id: '77777777-0000-4000-8000-00000000000b',
      organization_id: ORG_A,
      property_unit_id: UNIT_TWO,
      tenant_id: TENANT_ONE,
      contract_number: 'EJARI-0004',
      start_date: '2026-12-01',
      end_date: '2027-06-30',
      rent_amount: 90000,
      currency: 'AED',
      status: 'active',
      created_at: '2026-01-06T00:00:00+00:00',
    });

    // Dragging its start back over TENANCY_OTHER_TENANT (active to 2026-11-30) collides.
    await expectApiError(
      updateTenancy(ctx, '77777777-0000-4000-8000-00000000000b', { start_date: '2026-11-01' }),
      'CONFLICT',
      409,
    );
  });

  it('is re-checked when a draft is activated onto an occupied unit', async () => {
    const { ctx, tables } = harness('property_manager');
    const draft = tables.tenancies.find((row) => row.id === TENANCY_DRAFT);
    if (draft) {
      draft.start_date = '2026-06-01';
      draft.end_date = '2026-07-01';
      draft.property_unit_id = UNIT_ONE;
    }

    await expectApiError(updateTenancy(ctx, TENANCY_DRAFT, { status: 'active' }), 'CONFLICT', 409);
  });

  it('does not collide with itself when only the rent changes', async () => {
    const { ctx } = harness('property_manager');

    const result = await updateTenancy(ctx, TENANCY_ACTIVE, { rent_amount: '130000.00' });

    expect(result.tenancy.rent_amount).toBe('130000.00');
  });
});

/* ------------------------------------------------------------ create rules -- */

describe('createTenancy', () => {
  it('stamps organization_id from membership', async () => {
    const { ctx, fake } = harness('property_manager');
    await createTenancy(ctx, createBody({ property_unit_id: UNIT_TWO }));

    const insert = fake.against('tenancies').find((query) => query.op === 'insert');
    expect((insert?.payload as Row | undefined)?.organization_id).toBe(ORG_A);
  });

  it('stores rent as the canonical decimal string, not a float', async () => {
    const { ctx, fake } = harness('property_manager');
    await createTenancy(ctx, createBody({ property_unit_id: UNIT_TWO, rent_amount: '99999.99' }));

    const insert = fake.against('tenancies').find((query) => query.op === 'insert');
    expect((insert?.payload as Row | undefined)?.rent_amount).toBe('99999.99');
    expect(typeof (insert?.payload as Row | undefined)?.rent_amount).toBe('string');
  });

  it('defaults the currency to AED', async () => {
    const { ctx } = harness('property_manager');
    const result = await createTenancy(ctx, createBody({ property_unit_id: UNIT_TWO }));

    expect(result.tenancy.currency).toBe('AED');
  });

  it('defaults the status to draft', async () => {
    const { ctx } = harness('property_manager');
    const result = await createTenancy(
      ctx,
      createBody({ property_unit_id: UNIT_TWO, status: undefined }),
    );

    expect(result.tenancy.status).toBe('draft');
  });

  it('refuses to create a tenancy in a terminal status', async () => {
    const { ctx } = harness('property_manager');

    for (const status of ['expired', 'terminated'] as const) {
      await expectApiError(
        createTenancy(ctx, createBody({ property_unit_id: UNIT_TWO, status })),
        'UNPROCESSABLE',
        422,
      );
    }
  });

  it('refuses a unit in another organization with 422, not a foreign-key 500', async () => {
    const { ctx } = harness('property_manager');

    await expectApiError(
      createTenancy(ctx, createBody({ property_unit_id: UNIT_FOREIGN })),
      'UNPROCESSABLE',
      422,
    );
  });

  it('refuses a tenant in another organization with 422', async () => {
    const { ctx } = harness('property_manager');

    await expectApiError(
      createTenancy(ctx, createBody({ property_unit_id: UNIT_TWO, tenant_id: TENANT_FOREIGN })),
      'UNPROCESSABLE',
      422,
    );
  });

  it('refuses every non-staff role', async () => {
    for (const role of ['tenant', 'service_provider', 'property_owner'] as const) {
      const { ctx } = harness(role);
      await expect(createTenancy(ctx, createBody())).rejects.toThrow(AuthorizationDeniedError);
    }
  });

  it('writes nothing when a non-staff caller tries', async () => {
    const { ctx, tables } = harness('tenant');
    const before = tables.tenancies.length;

    await createTenancy(ctx, createBody()).catch(() => undefined);

    expect(tables.tenancies).toHaveLength(before);
  });
});

/* ------------------------------------------------------------ update rules -- */

describe('updateTenancy', () => {
  it('rejects end_date before start_date on a PARTIAL patch with 422', async () => {
    const { ctx } = harness('property_manager');

    // The body carries only one date, so `UpdateTenancySchema` cannot compare the pair.
    // The effective row is checked against the stored value instead of letting `0001`'s
    // `check (end_date >= start_date)` produce the error.
    await expectApiError(
      updateTenancy(ctx, TENANCY_ACTIVE, { start_date: '2027-06-01' }),
      'UNPROCESSABLE',
      422,
    );
  });

  it('rejects end_date before start_date when both are supplied, at the schema', () => {
    const result = UpdateTenancySchema.safeParse({
      start_date: '2027-06-01',
      end_date: '2027-01-01',
    });

    expect(result.success).toBe(false);
  });

  it('writes no row when the dates are rejected', async () => {
    const { ctx, tables } = harness('property_manager');

    await updateTenancy(ctx, TENANCY_ACTIVE, { start_date: '2027-06-01' }).catch(() => undefined);

    expect(tables.tenancies.find((row) => row.id === TENANCY_ACTIVE)?.start_date).toBe(
      '2026-01-01',
    );
  });

  it('rejects an illegal lifecycle edge with 409 and writes nothing', async () => {
    const { ctx, tables } = harness('property_manager');
    const row = tables.tenancies.find((candidate) => candidate.id === TENANCY_ACTIVE);
    if (row) row.status = 'expired';

    await expectApiError(updateTenancy(ctx, TENANCY_ACTIVE, { status: 'active' }), 'CONFLICT', 409);
    expect(tables.tenancies.find((candidate) => candidate.id === TENANCY_ACTIVE)?.status).toBe(
      'expired',
    );
  });

  it('refuses a 404 for a lease in another organization', async () => {
    const { ctx } = harness('property_manager');

    await expectApiError(
      updateTenancy(ctx, TENANCY_FOREIGN, { rent_amount: '1.00' }),
      'NOT_FOUND',
      404,
    );
  });

  it('refuses a tenant, an owner and a provider', async () => {
    for (const role of ['tenant', 'property_owner', 'service_provider'] as const) {
      const { ctx } = harness(role);
      await expect(
        updateTenancy(ctx, TENANCY_ACTIVE, { rent_amount: '1.00' }),
      ).rejects.toBeTruthy();
    }
  });

  it('writes only the fields the body carried', async () => {
    const { ctx, fake } = harness('property_manager');
    await updateTenancy(ctx, TENANCY_ACTIVE, { contract_number: 'EJARI-0001-R' });

    const update = fake.against('tenancies').find((query) => query.op === 'update');
    expect(Object.keys(update?.payload as Row)).toEqual(['contract_number']);
  });
});

/* -------------------------------------------- lifecycle audit and occupancy -- */

describe('a lifecycle transition', () => {
  it('writes its own audit row carrying from_status and to_status', async () => {
    const { ctx, fake } = harness('property_manager');

    await updateTenancy(ctx, TENANCY_DRAFT, { status: 'active' });

    const audits = fake.rpcCalls('log_audit');
    const lifecycle = audits.find(
      (call) => (call.payload as Row | undefined)?.p_action === 'tenancy_status_changed',
    );

    expect(lifecycle).toBeDefined();
    expect((lifecycle?.payload as Row | undefined)?.p_entity_type).toBe('tenancy');
    expect((lifecycle?.payload as Row | undefined)?.p_organization_id).toBe(ORG_A);
    expect((lifecycle?.payload as Row | undefined)?.p_metadata).toMatchObject({
      from_status: 'draft',
      to_status: 'active',
    });
  });

  it('records no lifecycle audit row when the status did not change', async () => {
    const { ctx, fake } = harness('property_manager');

    await updateTenancy(ctx, TENANCY_ACTIVE, { rent_amount: '121000.00' });

    expect(
      fake
        .rpcCalls('log_audit')
        .filter((call) => (call.payload as Row).p_action === 'tenancy_status_changed'),
    ).toHaveLength(0);
  });

  it('keeps no rent amount or contract number in the audit metadata', async () => {
    const { ctx, fake } = harness('property_manager');
    await updateTenancy(ctx, TENANCY_DRAFT, { status: 'active' });

    const serialised = JSON.stringify(fake.rpcCalls('log_audit').map((call) => call.payload));

    expect(serialised).not.toContain('rent_amount');
    expect(serialised).not.toContain('EJARI');
  });
});

describe('unit occupancy', () => {
  it('becomes occupied when a draft is activated', async () => {
    const { ctx, tables } = harness('property_manager');
    expect(unit(tables, UNIT_TWO)?.status).toBe('available');

    const result = await updateTenancy(ctx, TENANCY_DRAFT, { status: 'active' });

    // TENANCY_DRAFT is on UNIT_TWO, which was `available`.
    expect(result.unitStatus).toBe('occupied');
    expect(unit(tables, UNIT_TWO)?.status).toBe('occupied');
  });

  it('becomes available when the last active tenancy is terminated', async () => {
    const { ctx, tables } = harness('property_manager');
    expect(unit(tables, UNIT_ONE)?.status).toBe('occupied');

    const result = await updateTenancy(ctx, TENANCY_ACTIVE, { status: 'terminated' });

    expect(result.unitStatus).toBe('available');
    expect(unit(tables, UNIT_ONE)?.status).toBe('available');
  });

  it('becomes available when a tenancy expires', async () => {
    const { ctx, tables } = harness('property_manager');

    await updateTenancy(ctx, TENANCY_ACTIVE, { status: 'expired' });

    expect(unit(tables, UNIT_ONE)?.status).toBe('available');
  });

  it('stays occupied while another active tenancy remains on the unit', async () => {
    const { ctx, tables } = harness('property_manager');
    // A second active lease on UNIT_TWO alongside TENANCY_OTHER_TENANT.
    tables.tenancies.push({
      id: '77777777-0000-4000-8000-00000000000c',
      organization_id: ORG_A,
      property_unit_id: UNIT_TWO,
      tenant_id: TENANT_ONE,
      contract_number: 'EJARI-0005',
      start_date: '2026-12-01',
      end_date: '2027-06-30',
      rent_amount: 90000,
      currency: 'AED',
      status: 'active',
      created_at: '2026-01-07T00:00:00+00:00',
    });
    const unitTwo = unit(tables, UNIT_TWO);
    if (unitTwo) unitTwo.status = 'occupied';

    await updateTenancy(ctx, TENANCY_OTHER_TENANT, { status: 'terminated' });

    expect(unit(tables, UNIT_TWO)?.status).toBe('occupied');
  });

  it('does not reopen a unit a manager deliberately marked inactive', async () => {
    const { ctx, tables } = harness('property_manager');
    const unitOne = unit(tables, UNIT_ONE);
    if (unitOne) unitOne.status = 'inactive';

    const result = await updateTenancy(ctx, TENANCY_ACTIVE, { status: 'terminated' });

    // A derived field must not undo an explicit human decision.
    expect(result.unitStatus).toBeNull();
    expect(unit(tables, UNIT_ONE)?.status).toBe('inactive');
  });

  it('does not fail the request when the unit write fails', async () => {
    const tables = seedTables();
    const fake = createFakeClient({
      tables,
      failures: { 'update:property_units': { code: '42501', message: 'insufficient_privilege' } },
    });
    const logs = testLogger();
    const ctx: DataContext = {
      supabase: fake.client,
      membership: membership('property_manager'),
      logger: logs,
    };

    // The tenancy write has already committed and there is no transaction spanning the
    // two. Returning 500 would tell the client to retry a write that succeeded.
    const result = await updateTenancy(ctx, TENANCY_ACTIVE, { status: 'terminated' });

    expect(result.tenancy.status).toBe('terminated');
    expect(result.unitStatus).toBeNull();
    expect(
      logs.records.some(
        (record) => record.level === 'error' && record.fields.reason === 'unit_status_sync_failed',
      ),
    ).toBe(true);
  });
});

describe('the lane has no delete path', () => {
  it('exports no delete function from the tenancy service', async () => {
    const exports: Record<string, unknown> =
      await import('@/features/tenancies/server/tenancy-service');

    expect(Object.keys(exports).filter((name) => /delete|destroy|remove/i.test(name))).toEqual([]);
  });

  it('terminating is the removal path, and it leaves the row in place', async () => {
    const { ctx, tables } = harness('property_manager');
    const before = tables.tenancies.length;

    await updateTenancy(ctx, TENANCY_ACTIVE, { status: 'terminated' });

    expect(tables.tenancies).toHaveLength(before);
    expect(tables.tenancies.find((row) => row.id === TENANCY_ACTIVE)?.status).toBe('terminated');
  });
});
