/**
 * `features/tenants/server/tenant-service.ts` — the server-side half of the two
 * enforcement layers, exercised against an in-memory PostgREST stand-in.
 *
 * The fake applies **no** policy of its own (see `_support/fake-postgrest.ts`). Every
 * row in the fixture is returned if the service's own filters select it, so a service
 * that leaned on Row Level Security to scope a query would see organization B's rows
 * here and fail. That is the point: these tests measure this layer on the assumption
 * that the other one is broken.
 *
 * They prove nothing about RLS. `tests/rls/**` does that, against a real database.
 */

import { describe, expect, it } from 'vitest';

import { isApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';
import { ListTenantsQuerySchema } from '@shared/index';

import type { DataContext } from '@/features/tenants/server/context';
import {
  createTenant,
  getTenantById,
  listTenants,
  updateTenant,
} from '@/features/tenants/server/tenant-service';

import { createFakeClient, type FakeClient, type Row } from './_support/fake-postgrest';
import {
  ORG_A,
  ORG_B,
  PROFILE_TENANT_TWO,
  PROFILE_UNLINKED,
  TENANT_FOREIGN,
  TENANT_ONE,
  TENANT_TWO,
  foreignMembership,
  membership,
  seedTables,
  testLogger,
  type SeedTables,
} from './_support/fixtures';
import type { MemberRole } from '@shared/index';

interface Harness {
  ctx: DataContext;
  fake: FakeClient;
  tables: SeedTables;
  logs: ReturnType<typeof testLogger>;
}

function harness(role: MemberRole, options: { foreign?: boolean } = {}): Harness {
  const tables = seedTables();
  const who = options.foreign ? foreignMembership(role) : membership(role);
  // The same membership on both sides. `tenant_contact` is `security definer` and reads
  // its own caller, so the fake has to be told who that is; handing it the very object
  // the service receives means a test cannot accidentally grant the fake a role the
  // service was not given.
  const fake = createFakeClient({ tables, caller: who });
  const logs = testLogger();

  return {
    ctx: { supabase: fake.client, membership: who, logger: logs },
    fake,
    tables,
    logs,
  };
}

const defaultQuery = ListTenantsQuerySchema.parse({});

async function expectApiError(promise: Promise<unknown>, code: string, status: number) {
  try {
    await promise;
  } catch (thrown) {
    expect(isApiRouteError(thrown), `expected an ApiRouteError, got ${String(thrown)}`).toBe(true);
    if (isApiRouteError(thrown)) {
      expect(thrown.code).toBe(code);
      expect(thrown.status).toBe(status);
    }
    return;
  }
  throw new Error(`expected ${code} but the call resolved`);
}

/* ------------------------------------------------------------------- read -- */

describe('listTenants', () => {
  it('returns the organization’s tenants to a manager, and only theirs', () => {
    return (async () => {
      const { ctx } = harness('property_manager');

      const page = await listTenants(ctx, defaultQuery);
      const ids = page.items.map((tenant) => tenant.id);

      expect(ids).toContain(TENANT_ONE);
      expect(ids).toContain(TENANT_TWO);
      // Organization B's tenant is in the fixture and must not be in the result. The
      // fake applies no policy, so this passes only because the service filtered.
      expect(ids).not.toContain(TENANT_FOREIGN);
    })();
  });

  it('filters on organization_id derived from membership, not from a request', async () => {
    const { ctx, fake } = harness('property_manager');
    await listTenants(ctx, defaultQuery);

    const query = fake.against('tenants')[0];
    expect(query?.filters).toEqual(
      expect.arrayContaining([{ method: 'eq', column: 'organization_id', value: ORG_A }]),
    );
  });

  it('returns organization B’s tenants to organization B’s manager and no others', async () => {
    const { ctx } = harness('property_manager', { foreign: true });

    const page = await listTenants(ctx, defaultQuery);

    expect(page.items.map((tenant) => tenant.id)).toEqual([TENANT_FOREIGN]);
  });

  it('refuses a tenant — there is no tenant-facing directory', async () => {
    const { ctx } = harness('tenant');

    await expect(listTenants(ctx, defaultQuery)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses a service provider', async () => {
    const { ctx } = harness('service_provider');

    await expect(listTenants(ctx, defaultQuery)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses a property owner — the matrix cell is a dash', async () => {
    const { ctx } = harness('property_owner');

    await expect(listTenants(ctx, defaultQuery)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('never selects a wildcard', async () => {
    const { ctx, fake } = harness('organization_admin');
    await listTenants(ctx, defaultQuery);

    for (const query of fake.against('tenants')) {
      expect(query.select).not.toContain('*');
    }
  });

  it('searches by name, and a punctuation-only term matches nothing', async () => {
    const { ctx } = harness('property_manager');

    const found = await listTenants(ctx, ListTenantsQuerySchema.parse({ q: 'Noura' }));
    expect(found.items.map((tenant) => tenant.id)).toEqual([TENANT_TWO]);

    // Sanitised to the empty string: returning every row would be a surprising answer
    // to a search, and the raw term must never reach a filter expression.
    const none = await listTenants(ctx, ListTenantsQuerySchema.parse({ q: '%;--' }));
    expect(none.items).toEqual([]);
  });

  it('strips filter syntax out of a search term before it reaches a query', async () => {
    const { ctx, fake } = harness('property_manager');

    await listTenants(ctx, ListTenantsQuerySchema.parse({ q: 'Noura,or=(id.eq.1)' }));

    const ilike = fake
      .against('tenants')
      .flatMap((query) => query.filters)
      .find((filter) => filter.method === 'ilike');

    expect(String(ilike?.value)).not.toContain(',');
    expect(String(ilike?.value)).not.toContain('(');
    expect(String(ilike?.value)).not.toContain('=');
  });
});

describe('getTenantById', () => {
  it('gives a manager the full record', async () => {
    const { ctx } = harness('property_manager');

    const view = await getTenantById(ctx, TENANT_ONE);

    expect(view.kind).toBe('full');
    expect(view.tenant).toHaveProperty('email', 'tariq@example.test');
  });

  it('gives a tenant their own record', async () => {
    const { ctx } = harness('tenant');

    const view = await getTenantById(ctx, TENANT_ONE);

    expect(view.kind).toBe('full');
    expect(view.tenant.id).toBe(TENANT_ONE);
  });

  it('REFUSES a tenant another tenant’s record', async () => {
    const { ctx } = harness('tenant');

    await expect(getTenantById(ctx, TENANT_TWO)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses before it queries, so a probe learns nothing from the database', async () => {
    const { ctx, fake } = harness('tenant');

    await getTenantById(ctx, TENANT_TWO).catch(() => undefined);

    expect(fake.against('tenants')).toHaveLength(0);
  });

  it('gives an assigned provider the NAME ONLY — no email, no phone', async () => {
    const { ctx } = harness('service_provider');

    const view = await getTenantById(ctx, TENANT_ONE);

    expect(view.kind).toBe('name_only');
    expect(Object.keys(view.tenant).sort()).toEqual(['full_name', 'id']);
    expect(view.tenant).not.toHaveProperty('email');
    expect(view.tenant).not.toHaveProperty('phone');
    expect(JSON.stringify(view.tenant)).not.toContain('tariq@example.test');
    expect(JSON.stringify(view.tenant)).not.toContain('+971500000001');
  });

  it('never even fetches the withheld columns for a provider', async () => {
    const { ctx, fake } = harness('service_provider');

    await getTenantById(ctx, TENANT_ONE);

    // The projection assertion the briefing asks for: the select list itself, not just
    // the serialised output. A row-level policy could not have produced this.
    const select = fake.against('tenants').at(-1)?.select;
    expect(select).toBe('id, organization_id, full_name');
    expect(select).not.toContain('email');
    expect(select).not.toContain('phone');
  });

  it('refuses a provider with no assignment to that tenant', async () => {
    const { ctx, tables } = harness('service_provider');
    tables.maintenance_tickets = [];

    await expect(getTenantById(ctx, TENANT_ONE)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('refuses a provider the tenant behind somebody else’s ticket', async () => {
    const { ctx } = harness('service_provider');

    // TENANT_TWO has no ticket assigned to this provider.
    await expect(getTenantById(ctx, TENANT_TWO)).rejects.toThrow(AuthorizationDeniedError);
  });

  it('returns 404, not 403, for a tenant record in another organization', async () => {
    const { ctx } = harness('property_manager');

    // A 403 would confirm that the identifier names a real tenant somewhere.
    await expectApiError(getTenantById(ctx, TENANT_FOREIGN), 'NOT_FOUND', 404);
  });

  it('returns 404 for an identifier that does not exist', async () => {
    const { ctx } = harness('property_manager');

    await expectApiError(
      getTenantById(ctx, '33333333-0000-4000-8000-00000000dead'),
      'NOT_FOUND',
      404,
    );
  });
});

/* ------------------------------------------- migration 0004: contact details -- */

/**
 * The column boundary, after `0004_agentic.sql` moved it out of the application layer.
 *
 * Before 0004 the only thing between a `service_provider` and an assigned tenant's phone
 * number was `projectionFor()` — correct, and bypassable, because the anon key is public
 * by design and a provider holds a real JWT, so PostgREST could be called directly. 0004
 * revoked SELECT on `tenants.email` and `tenants.phone` for every role and left one read
 * path, `tenant_contact()`, which checks `is_org_staff()`.
 *
 * These tests measure the fake against that migration rather than the service against the
 * fake. That is deliberate: every projection assertion in this file is only worth the
 * fidelity of the stand-in underneath it. A fake that answered `tenant_contact` for all
 * callers would make the provider's name-only view pass no matter what the service did —
 * a lie in exactly the direction the migration exists to prevent — and a fake that served
 * `email` from a plain `select` would let a regression reach production green.
 */
describe('migration 0004 — tenant contact details', () => {
  /** A loosely typed handle on the fake, for calling it the way PostgREST would. */
  function raw(fake: FakeClient) {
    return fake.client as unknown as {
      from(table: string): {
        select(list: string): PromiseLike<{ data: unknown; error: { code: string } | null }>;
      };
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{ data: unknown; error: { code: string } | null }>;
    };
  }

  it('raises 42501 for a select naming email or phone on tenants', async () => {
    const { fake } = harness('property_manager');

    for (const list of ['id, email', 'id, phone', 'id, full_name, email, phone']) {
      const { data, error } = await raw(fake).from('tenants').select(list);

      // Not "returns the row without the column" — the statement itself is refused, for
      // staff as much as for anybody else. A regression that reinstated a direct column
      // read would fail here rather than 403 in production.
      expect(error?.code).toBe('42501');
      expect(data).toEqual([]);
    }
  });

  it('still allows the five granted columns', async () => {
    const { fake } = harness('property_manager');

    const { error } = await raw(fake)
      .from('tenants')
      .select('id, organization_id, profile_id, full_name, created_at');

    expect(error).toBeNull();
  });

  it('answers tenant_contact for staff, scoped to their organization', async () => {
    const { fake } = harness('property_manager');

    const { data, error } = await raw(fake).rpc('tenant_contact', {
      p_organization_id: ORG_A,
      p_tenant_id: null,
    });

    expect(error).toBeNull();
    expect(data).toEqual(
      expect.arrayContaining([
        { tenant_id: TENANT_ONE, email: 'tariq@example.test', phone: '+971500000001' },
      ]),
    );
    // Organization B's tenant is in the fixture. A security-definer function reads
    // without RLS, so its organization filter is the only thing withholding this row.
    expect(JSON.stringify(data)).not.toContain(TENANT_FOREIGN);
  });

  it('REFUSES tenant_contact to a provider holding the assigned ticket', async () => {
    const { fake } = harness('service_provider');

    // The exact caller the matrix limits to "R name only, via assignment". The assignment
    // grants the row; it has never granted the columns.
    const { data, error } = await raw(fake).rpc('tenant_contact', {
      p_organization_id: ORG_A,
      p_tenant_id: TENANT_ONE,
    });

    expect(error?.code).toBe('42501');
    expect(data).toBeNull();
  });

  it('REFUSES tenant_contact to a property owner', async () => {
    const { fake } = harness('property_owner');

    const { error } = await raw(fake).rpc('tenant_contact', {
      p_organization_id: ORG_A,
      p_tenant_id: null,
    });

    expect(error?.code).toBe('42501');
  });

  it('REFUSES staff asking about an organization they are not staff of', async () => {
    const { fake } = harness('property_manager');

    const { error } = await raw(fake).rpc('tenant_contact', {
      p_organization_id: ORG_B,
      p_tenant_id: TENANT_FOREIGN,
    });

    expect(error?.code).toBe('42501');
  });

  it('answers the tenant themselves with their own row and no other', async () => {
    const { fake } = harness('tenant');

    // The §4 matrix gives `tenant` "R self only" on `tenants`, and that cell includes
    // their own contact details — a staff-only accessor would make it unsatisfiable.
    const { data, error } = await raw(fake).rpc('tenant_contact', {
      p_organization_id: ORG_A,
      p_tenant_id: null,
    });

    expect(error).toBeNull();
    expect(data).toEqual([
      { tenant_id: TENANT_ONE, email: 'tariq@example.test', phone: '+971500000001' },
    ]);

    const neighbour = await raw(fake).rpc('tenant_contact', {
      p_organization_id: ORG_A,
      p_tenant_id: TENANT_TWO,
    });
    expect(neighbour.error?.code).toBe('42501');
  });

  it('hydrates a staff list through the RPC rather than through the select list', async () => {
    const { ctx, fake } = harness('property_manager');

    await listTenants(ctx, defaultQuery);

    for (const query of fake.against('tenants')) {
      expect(query.select).not.toContain('email');
      expect(query.select).not.toContain('phone');
    }

    // One call for the whole page, with the organization taken from membership. The null
    // tenant id is what makes a list page one round trip instead of one per row.
    const calls = fake.rpcCalls('tenant_contact');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toEqual({ p_organization_id: ORG_A, p_tenant_id: null });
  });
});

/* ------------------------------------------------------------------ write -- */

describe('createTenant', () => {
  it('stamps organization_id from membership and never from the body', async () => {
    const { ctx, fake } = harness('property_manager');

    await createTenant(ctx, { full_name: 'New Person' });

    const insert = fake.against('tenants').find((query) => query.op === 'insert');
    expect((insert?.payload as Row | undefined)?.organization_id).toBe(ORG_A);
  });

  it('refuses a tenant, a provider and an owner', async () => {
    for (const role of ['tenant', 'service_provider', 'property_owner'] as const) {
      const { ctx } = harness(role);
      await expect(createTenant(ctx, { full_name: 'New Person' })).rejects.toThrow(
        AuthorizationDeniedError,
      );
    }
  });

  it('refuses to link a profile that is not a member of this organization', async () => {
    const { ctx } = harness('property_manager');

    // `PROFILE_UNLINKED` is an active member of organization B only. Linking it would
    // attach a stranger's account to a tenant record here — `tenants.profile_id` has no
    // organization component in its foreign key, so nothing else stops it.
    await expectApiError(
      createTenant(ctx, { full_name: 'Imported Person', profile_id: PROFILE_UNLINKED }),
      'UNPROCESSABLE',
      422,
    );
  });

  it('refuses to link a profile that already has a tenant record here', async () => {
    const { ctx } = harness('property_manager');

    // A second link would make `current_tenant_id()` — `select ... limit 1`, unordered —
    // return an arbitrary one of the two, and with it a different RLS row set.
    await expectApiError(
      createTenant(ctx, { full_name: 'Duplicate', profile_id: PROFILE_TENANT_TWO }),
      'CONFLICT',
      409,
    );
  });

  it('accepts a record with no profile at all', async () => {
    const { ctx } = harness('property_manager');

    const tenant = await createTenant(ctx, {
      full_name: 'Not Yet Signed Up',
      email: 'pending@example.test',
    });

    // `tenants.profile_id` is nullable precisely so a tenancy can exist before the
    // person has an account.
    expect(tenant.profile_id).toBeNull();
    expect(tenant.full_name).toBe('Not Yet Signed Up');
  });
});

describe('updateTenant', () => {
  it('writes only the fields the body carried', async () => {
    const { ctx, fake } = harness('property_manager');

    await updateTenant(ctx, TENANT_ONE, { phone: '+971500000123' });

    const update = fake.against('tenants').find((query) => query.op === 'update');
    expect(Object.keys(update?.payload as Row)).toEqual(['phone']);
  });

  it('clears a contact detail when the body sends null', async () => {
    const { ctx } = harness('property_manager');

    const tenant = await updateTenant(ctx, TENANT_ONE, { email: null });

    expect(tenant.email).toBeNull();
  });

  it('scopes the update by organization as well as by id', async () => {
    const { ctx, fake } = harness('property_manager');

    await updateTenant(ctx, TENANT_ONE, { full_name: 'Tariq T.' });

    const update = fake.against('tenants').find((query) => query.op === 'update');
    expect(update?.filters).toEqual(
      expect.arrayContaining([{ method: 'eq', column: 'organization_id', value: ORG_A }]),
    );
  });

  it('cannot reach a record in another organization', async () => {
    const { ctx, tables } = harness('property_manager');

    await expectApiError(
      updateTenant(ctx, TENANT_FOREIGN, { full_name: 'Renamed' }),
      'NOT_FOUND',
      404,
    );
    expect(tables.tenants.find((row) => row.id === TENANT_FOREIGN)?.full_name).toBe('Tariq Tenant');
  });

  it('refuses a tenant editing their own record', async () => {
    const { ctx } = harness('tenant');

    // The matrix gives a tenant `R self only` on `tenants`: contact changes go through
    // their own `profiles` row, which is a different table with a different policy.
    await expect(updateTenant(ctx, TENANT_ONE, { phone: '+971500000999' })).rejects.toThrow(
      AuthorizationDeniedError,
    );
  });

  it('refuses a provider', async () => {
    const { ctx } = harness('service_provider');

    await expect(updateTenant(ctx, TENANT_ONE, { full_name: 'Renamed' })).rejects.toThrow(
      AuthorizationDeniedError,
    );
  });

  it('re-checks profile linkage on update, not only on create', async () => {
    const { ctx } = harness('property_manager');

    await expectApiError(
      updateTenant(ctx, TENANT_ONE, { profile_id: PROFILE_UNLINKED }),
      'UNPROCESSABLE',
      422,
    );
  });

  it('allows re-linking the profile a record already has', async () => {
    const { ctx } = harness('property_manager');

    // The duplicate check excludes the row being updated; without that exclusion a
    // no-op re-link would collide with itself.
    const tenant = await updateTenant(ctx, TENANT_TWO, { profile_id: PROFILE_TENANT_TWO });

    expect(tenant.profile_id).toBe(PROFILE_TENANT_TWO);
  });
});

describe('the lane has no delete path', () => {
  it('exports no delete function from the tenant service', async () => {
    const exports: Record<string, unknown> =
      await import('@/features/tenants/server/tenant-service');

    const names = Object.keys(exports).filter((name) => /delete|destroy|remove/i.test(name));
    expect(names).toEqual([]);
  });

  it('never issues a query against organization B’s rows for organization A’s staff', async () => {
    const { ctx, fake } = harness('property_manager');

    await listTenants(ctx, defaultQuery);
    await getTenantById(ctx, TENANT_ONE);

    for (const query of fake.queries) {
      const org = query.filters.find((filter) => filter.column === 'organization_id');
      if (org) expect(org.value).not.toBe(ORG_B);
    }
  });
});
