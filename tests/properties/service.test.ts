/**
 * `features/properties/service.ts` — the data layer.
 *
 * Everything in `features/properties/**` and `lib/auth/authorize.ts` is the real
 * implementation. Only the transport is a fake, and the fake is used adversarially: it
 * returns rows a correctly-configured database would never return, so the assertions can
 * show that the application layer denies **without** help from Row Level Security. That
 * is the second half of CLAUDE.md goal 1, and it is not provable any other way — against
 * a correct database, a missing application-space check looks exactly like a present one.
 *
 * The RLS half is `tests/rls/**` (lane w0-l6), behind the `PS_RLS` gate. This lane has no
 * anon key, so it cannot and does not claim to have exercised it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';
import {
  archiveProperty,
  createProperty,
  createUnit,
  getProperty,
  getUnit,
  listProperties,
  listUnits,
  portfolioCounts,
  updateProperty,
  updateUnit,
} from '@/features/properties/service';
import {
  ListPropertiesQuerySchema,
  ListUnitsQuerySchema,
  type ListPropertiesQuery,
  type ListUnitsQuery,
} from '@shared/index';

import {
  counts,
  createFakeClient,
  eqValue,
  fails,
  inValues,
  limitValue,
  orFilters,
  queriesFor,
  rows,
  sequence,
  type Responder,
} from './support/fake-supabase';
import {
  IDS,
  MANAGER_A,
  ORG_A,
  ORG_B,
  OWNER_A,
  PROVIDER_A,
  TENANT_A,
  memberRow,
  membership,
  propertyRow,
  unitRow,
} from './support/world';

const DEFAULT_PROPERTY_QUERY: ListPropertiesQuery = ListPropertiesQuerySchema.parse({});
const DEFAULT_UNIT_QUERY: ListUnitsQuery = ListUnitsQuerySchema.parse({});

function fake(responders: Record<string, Responder>) {
  return createFakeClient(responders);
}

/** Captures a thrown `ApiRouteError`, failing the test if nothing was thrown. */
async function captured(run: () => Promise<unknown>): Promise<ApiRouteError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiRouteError) return error;
    throw error;
  }
  throw new Error('expected the call to throw an ApiRouteError');
}

/* ------------------------------------------------------------------ list -- */

describe('listProperties — the statement it builds', () => {
  let client: ReturnType<typeof fake>;

  beforeEach(() => {
    client = fake({ properties: rows(propertyRow()) });
  });

  it('scopes every read by the membership organization, never by a request value', async () => {
    await listProperties(client.client, MANAGER_A, DEFAULT_PROPERTY_QUERY);

    const [statement] = queriesFor(client, 'properties', 'select');
    expect(statement).toBeDefined();
    expect(eqValue(statement!, 'organization_id')).toBe(ORG_A);
  });

  it('selects the columns the frozen PropertySchema describes, and no others', async () => {
    await listProperties(client.client, MANAGER_A, DEFAULT_PROPERTY_QUERY);

    const columns = (queriesFor(client, 'properties', 'select')[0]?.columns ?? '')
      .split(',')
      .map((column) => column.trim());

    expect(columns).toEqual([
      'id',
      'organization_id',
      'name',
      'property_type',
      'address_line',
      'city',
      'emirate',
      'owner_member_id',
      'status',
      'created_at',
      'updated_at',
    ]);
  });

  it('over-fetches by exactly one row to answer "is there more" without a count', async () => {
    await listProperties(client.client, MANAGER_A, DEFAULT_PROPERTY_QUERY);
    // Default page size is 25 (§5.7), so the statement asks for 26.
    expect(limitValue(queriesFor(client, 'properties', 'select')[0]!)).toBe(26);
  });

  it('never asks for a count — an offset or total over an RLS-filtered list is a disclosure', async () => {
    await listProperties(client.client, MANAGER_A, DEFAULT_PROPERTY_QUERY);
    for (const statement of client.queries) {
      expect(statement.countRequested).toBe(false);
      expect(statement.calls.map((call) => call.method)).not.toContain('range');
    }
  });

  it('applies the sanitised search term, not the raw one', async () => {
    const query = ListPropertiesQuerySchema.parse({ q: 'Marina,status.eq.archived' });
    await listProperties(client.client, MANAGER_A, query);

    const filters = orFilters(queriesFor(client, 'properties', 'select')[0]!);
    expect(filters).toHaveLength(1);
    expect(filters[0]).toBe(
      'name.ilike.*Marina status eq archived*,address_line.ilike.*Marina status eq archived*',
    );
    expect(filters[0]).not.toContain('status.eq.archived,');
  });

  it('applies the status filter when one is given', async () => {
    const query = ListPropertiesQuerySchema.parse({ status: 'archived' });
    await listProperties(client.client, MANAGER_A, query);
    expect(eqValue(queriesFor(client, 'properties', 'select')[0]!, 'status')).toBe('archived');
  });
});

describe('listProperties — what each role sees', () => {
  it('gives staff the whole organization portfolio', async () => {
    const client = fake({
      properties: rows(propertyRow({ id: IDS.a.p1 }), propertyRow({ id: IDS.a.p2 })),
    });
    const page = await listProperties(client.client, MANAGER_A, DEFAULT_PROPERTY_QUERY);

    expect(page.rows.map((row) => row.id)).toEqual([IDS.a.p1, IDS.a.p2]);
    // No id restriction for staff: the organization filter is the whole bound.
    expect(inValues(queriesFor(client, 'properties', 'select')[0]!, 'id')).toBeUndefined();
  });

  it('restricts an owner to their own membership id', async () => {
    const client = fake({ properties: rows(propertyRow()) });
    await listProperties(client.client, OWNER_A, DEFAULT_PROPERTY_QUERY);

    expect(eqValue(queriesFor(client, 'properties', 'select')[0]!, 'owner_member_id')).toBe(
      IDS.a.owner.member,
    );
  });

  it('drops a property the owner does not own even when the database returned it', async () => {
    const client = fake({
      properties: rows(
        propertyRow({ id: IDS.a.p1 }),
        propertyRow({ id: IDS.a.p2, owner_member_id: null }),
      ),
    });
    const page = await listProperties(client.client, OWNER_A, DEFAULT_PROPERTY_QUERY);

    expect(page.rows.map((row) => row.id)).toEqual([IDS.a.p1]);
  });

  it('gives a tenant only the property behind an active tenancy', async () => {
    const client = fake({
      tenancies: rows({ property_unit_id: IDS.a.p1u1 }),
      property_units: rows({ id: IDS.a.p1u1, property_id: IDS.a.p1 }),
      // The database returns P2 as well — the bugged-RLS case.
      properties: rows(propertyRow({ id: IDS.a.p1 }), propertyRow({ id: IDS.a.p2 })),
    });

    const page = await listProperties(client.client, TENANT_A, DEFAULT_PROPERTY_QUERY);

    expect(page.rows.map((row) => row.id)).toEqual([IDS.a.p1]);

    // The scope also narrowed the statement before it was sent.
    expect(inValues(queriesFor(client, 'properties', 'select')[0]!, 'id')).toEqual([IDS.a.p1]);
    // And the tenancy lookup was restricted to active tenancies of this tenant only.
    const tenancyStatement = queriesFor(client, 'tenancies', 'select')[0]!;
    expect(eqValue(tenancyStatement, 'tenant_id')).toBe(TENANT_A.tenantId);
    expect(eqValue(tenancyStatement, 'status')).toBe('active');
    expect(eqValue(tenancyStatement, 'organization_id')).toBe(ORG_A);
  });

  it('gives a provider only the property behind an assigned ticket', async () => {
    const client = fake({
      maintenance_tickets: rows({ property_id: IDS.a.p1, property_unit_id: IDS.a.p1u1 }),
      properties: rows(propertyRow({ id: IDS.a.p1 }), propertyRow({ id: IDS.a.p2 })),
    });

    const page = await listProperties(client.client, PROVIDER_A, DEFAULT_PROPERTY_QUERY);

    expect(page.rows.map((row) => row.id)).toEqual([IDS.a.p1]);
    const ticketStatement = queriesFor(client, 'maintenance_tickets', 'select')[0]!;
    expect(eqValue(ticketStatement, 'assigned_provider_id')).toBe(PROVIDER_A.providerId);
    expect(eqValue(ticketStatement, 'organization_id')).toBe(ORG_A);
  });

  it('shows a tenant with no active tenancy nothing, and issues no property statement', async () => {
    const client = fake({ tenancies: rows(), properties: rows(propertyRow()) });
    const page = await listProperties(client.client, TENANT_A, DEFAULT_PROPERTY_QUERY);

    expect(page.rows).toEqual([]);
    expect(queriesFor(client, 'properties', 'select')).toHaveLength(0);
  });

  it('shows a tenant with no tenants row nothing, and issues no statement at all', async () => {
    const orphan = membership({ role: 'tenant', tenantId: null });
    const client = fake({});
    const page = await listProperties(client.client, orphan, DEFAULT_PROPERTY_QUERY);

    expect(page).toEqual({ rows: [], nextCursor: null, hasMore: false, limit: 25 });
    expect(client.queries).toHaveLength(0);
  });

  it('drops a cross-organization row the database returned anyway', async () => {
    // The whole point of the second enforcement layer. Both rows are named identically in
    // the fixtures, so only the identifier comparison can catch the leak.
    const client = fake({
      properties: rows(
        propertyRow({ id: IDS.a.p1 }),
        propertyRow({ id: IDS.b.p1, organization_id: ORG_B }),
      ),
    });

    const page = await listProperties(client.client, MANAGER_A, DEFAULT_PROPERTY_QUERY);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.organization_id).toBe(ORG_A);
    expect(page.rows.map((row) => row.id)).not.toContain(IDS.b.p1);
  });
});

/* ------------------------------------------------------------------- read -- */

describe('getProperty', () => {
  it('returns the row for a staff caller', async () => {
    const client = fake({ properties: rows(propertyRow()) });
    const property = await getProperty(client.client, MANAGER_A, IDS.a.p1);
    expect(property.id).toBe(IDS.a.p1);
  });

  it('answers an absent row with NOT_FOUND', async () => {
    const client = fake({ properties: rows() });
    const error = await captured(() => getProperty(client.client, MANAGER_A, IDS.a.p1));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.logFields.reason).toBe('property_row_absent');
  });

  it('answers a cross-organization row with NOT_FOUND, not FORBIDDEN', async () => {
    const client = fake({
      properties: rows(propertyRow({ id: IDS.b.p1, organization_id: ORG_B })),
    });
    const error = await captured(() => getProperty(client.client, MANAGER_A, IDS.b.p1));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.status).toBe(404);
    expect(error.logFields.reason).toBe('cross_organization');
  });

  it('answers a same-organization row the tenant cannot reach with NOT_FOUND', async () => {
    const client = fake({
      tenancies: rows({ property_unit_id: IDS.a.p1u1 }),
      property_units: rows({ id: IDS.a.p1u1, property_id: IDS.a.p1 }),
      properties: rows(propertyRow({ id: IDS.a.p2 })),
    });

    const error = await captured(() => getProperty(client.client, TENANT_A, IDS.a.p2));
    expect(error.code).toBe('NOT_FOUND');
  });
});

/* ----------------------------------------------------------------- create -- */

describe('createProperty', () => {
  it('writes organization_id from the membership and nothing from the caller', async () => {
    const client = fake({ properties: rows(propertyRow()) });

    await createProperty(client.client, MANAGER_A, {
      name: 'Marina Residence',
      property_type: 'apartment_building',
      address_line: 'Example Street',
      city: 'Dubai',
      emirate: 'Dubai',
    });

    const insert = queriesFor(client, 'properties', 'insert')[0]!;
    const payload = insert.payload as Record<string, unknown>;
    expect(payload.organization_id).toBe(ORG_A);
    expect(payload.status).toBe('active');
    expect(payload.owner_member_id).toBeNull();
    // The row id is the database's to choose.
    expect(payload).not.toHaveProperty('id');
  });

  it('refuses a property owner before any statement is built', async () => {
    const client = fake({});

    await expect(
      createProperty(client.client, OWNER_A, {
        name: 'Marina Residence',
        property_type: 'apartment_building',
        address_line: 'Example Street',
        city: 'Dubai',
        emirate: 'Dubai',
      }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);

    // Denied before the query, so a probing client learns nothing from timing.
    expect(client.queries).toHaveLength(0);
  });

  it('validates a proposed owner against the caller’s own organization', async () => {
    const client = fake({
      organization_members: rows(memberRow()),
      properties: rows(propertyRow()),
    });

    await createProperty(client.client, MANAGER_A, {
      name: 'Marina Residence',
      property_type: 'apartment_building',
      address_line: 'Example Street',
      city: 'Dubai',
      emirate: 'Dubai',
      owner_member_id: IDS.a.owner.member,
    });

    const lookup = queriesFor(client, 'organization_members', 'select')[0]!;
    expect(eqValue(lookup, 'organization_id')).toBe(ORG_A);
    expect(eqValue(lookup, 'id')).toBe(IDS.a.owner.member);
  });

  it('refuses an owner that is not an associable member, with 422 and no insert', async () => {
    const client = fake({ organization_members: rows() });

    const error = await captured(() =>
      createProperty(client.client, MANAGER_A, {
        name: 'Marina Residence',
        property_type: 'apartment_building',
        address_line: 'Example Street',
        city: 'Dubai',
        emirate: 'Dubai',
        owner_member_id: IDS.a.owner.member,
      }),
    );

    expect(error.code).toBe('UNPROCESSABLE');
    expect(error.status).toBe(422);
    expect(queriesFor(client, 'properties', 'insert')).toHaveLength(0);
  });

  it('refuses a cross-organization owner even if the database handed one back', async () => {
    // The composite FK makes this impossible in Postgres; the assertion is the second layer.
    const client = fake({ organization_members: rows(memberRow({ organization_id: ORG_B })) });

    const error = await captured(() =>
      createProperty(client.client, MANAGER_A, {
        name: 'Marina Residence',
        property_type: 'apartment_building',
        address_line: 'Example Street',
        city: 'Dubai',
        emirate: 'Dubai',
        owner_member_id: IDS.a.owner.member,
      }),
    );

    expect(error.code).toBe('UNPROCESSABLE');
    expect(error.logFields.reason).toBe('owner_member_cross_organization');
  });

  it('surfaces a foreign-key violation as UNPROCESSABLE 422, not 500', async () => {
    const client = fake({
      'properties:insert': fails(
        '23503',
        'insert or update on table "properties" violates foreign key constraint',
      ),
    });

    const error = await captured(() =>
      createProperty(client.client, MANAGER_A, {
        name: 'Marina Residence',
        property_type: 'apartment_building',
        address_line: 'Example Street',
        city: 'Dubai',
        emirate: 'Dubai',
      }),
    );

    expect(error.code).toBe('UNPROCESSABLE');
    expect(error.status).toBe(422);
  });

  it('surfaces an RLS write denial as FORBIDDEN 403, not 500', async () => {
    // Postgres raises 42501 for an RLS denial on a write (amendment A2).
    const client = fake({
      'properties:insert': fails('42501', 'new row violates row-level security policy'),
    });

    const error = await captured(() =>
      createProperty(client.client, MANAGER_A, {
        name: 'Marina Residence',
        property_type: 'apartment_building',
        address_line: 'Example Street',
        city: 'Dubai',
        emirate: 'Dubai',
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.status).toBe(403);
  });
});

/* ----------------------------------------------------- update and archive -- */

describe('updateProperty', () => {
  it('writes only the fields the body contained', async () => {
    const client = fake({
      'properties:select': rows(propertyRow()),
      'properties:update': rows(propertyRow({ name: 'Renamed' })),
    });

    await updateProperty(client.client, MANAGER_A, IDS.a.p1, { name: 'Renamed' });

    const update = queriesFor(client, 'properties', 'update')[0]!;
    expect(update.payload).toEqual({ name: 'Renamed' });
    // Organization and row id are in the WHERE clause, not the patch.
    expect(eqValue(update, 'organization_id')).toBe(ORG_A);
    expect(eqValue(update, 'id')).toBe(IDS.a.p1);
  });

  it('refuses a property owner with 403 and issues no update', async () => {
    const client = fake({ 'properties:select': rows(propertyRow()) });

    await expect(
      updateProperty(client.client, OWNER_A, IDS.a.p1, { name: 'Renamed' }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);

    expect(queriesFor(client, 'properties', 'update')).toHaveLength(0);
  });

  it('refuses an edit to an archived property unless the status changes', async () => {
    const client = fake({ 'properties:select': rows(propertyRow({ status: 'archived' })) });

    const error = await captured(() =>
      updateProperty(client.client, MANAGER_A, IDS.a.p1, { name: 'Renamed' }),
    );

    expect(error.code).toBe('CONFLICT');
    expect(error.status).toBe(409);
    expect(error.logFields.reason).toBe('property_archived');
    expect(queriesFor(client, 'properties', 'update')).toHaveLength(0);
  });

  it('allows reactivating an archived property', async () => {
    const client = fake({
      'properties:select': rows(propertyRow({ status: 'archived' })),
      'properties:update': rows(propertyRow({ status: 'active' })),
    });

    const property = await updateProperty(client.client, MANAGER_A, IDS.a.p1, { status: 'active' });
    expect(property.status).toBe('active');
  });

  it('answers an update that matched no row with NOT_FOUND', async () => {
    const client = fake({
      'properties:select': rows(propertyRow()),
      'properties:update': rows(),
    });

    const error = await captured(() =>
      updateProperty(client.client, MANAGER_A, IDS.a.p1, { name: 'Renamed' }),
    );
    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('archiveProperty — archive is the only removal path', () => {
  it('sets the status and never issues a delete', async () => {
    const client = fake({
      'properties:select': rows(propertyRow()),
      'properties:update': rows(propertyRow({ status: 'archived' })),
    });

    const property = await archiveProperty(client.client, MANAGER_A, IDS.a.p1);

    expect(property.status).toBe('archived');
    expect(queriesFor(client, 'properties', 'update')[0]!.payload).toEqual({ status: 'archived' });
    // There is no delete operation on the fake at all, and nothing asked for one.
    expect(client.queries.map((query) => query.operation)).toEqual(['select', 'update']);
  });

  it('is idempotent: archiving an archived property writes nothing', async () => {
    const client = fake({ 'properties:select': rows(propertyRow({ status: 'archived' })) });

    const property = await archiveProperty(client.client, MANAGER_A, IDS.a.p1);

    expect(property.status).toBe('archived');
    expect(queriesFor(client, 'properties', 'update')).toHaveLength(0);
  });

  it('refuses a property owner', async () => {
    const client = fake({ 'properties:select': rows(propertyRow()) });
    await expect(archiveProperty(client.client, OWNER_A, IDS.a.p1)).rejects.toBeInstanceOf(
      AuthorizationDeniedError,
    );
  });
});

/* ------------------------------------------------------------------ units -- */

describe('listUnits', () => {
  it('reads the parent property first, so an unreachable property is 404 and not an empty page', async () => {
    const client = fake({ 'properties:select': rows() });

    const error = await captured(() =>
      listUnits(client.client, MANAGER_A, IDS.a.p1, DEFAULT_UNIT_QUERY),
    );

    expect(error.code).toBe('NOT_FOUND');
    expect(queriesFor(client, 'property_units', 'select')).toHaveLength(0);
  });

  it('filters by organization and by the property in the path', async () => {
    const client = fake({
      'properties:select': rows(propertyRow()),
      'property_units:select': rows(unitRow()),
    });

    await listUnits(client.client, MANAGER_A, IDS.a.p1, DEFAULT_UNIT_QUERY);

    const statement = queriesFor(client, 'property_units', 'select')[0]!;
    expect(eqValue(statement, 'organization_id')).toBe(ORG_A);
    expect(eqValue(statement, 'property_id')).toBe(IDS.a.p1);
    expect(limitValue(statement)).toBe(26);
  });

  it('drops a unit whose property_id does not match the path', async () => {
    // Invariant 4, asserted in TypeScript as well as in the WHERE clause. A unit/property
    // pair that was never cross-checked was the only blocking defect found in Wave 0.
    const client = fake({
      'properties:select': rows(propertyRow()),
      'property_units:select': rows(
        unitRow({ id: IDS.a.p1u1, property_id: IDS.a.p1 }),
        unitRow({ id: IDS.a.p2u1, property_id: IDS.a.p2 }),
      ),
    });

    const page = await listUnits(client.client, MANAGER_A, IDS.a.p1, DEFAULT_UNIT_QUERY);
    expect(page.rows.map((row) => row.id)).toEqual([IDS.a.p1u1]);
  });

  it('gives a tenant only the unit they actively lease', async () => {
    const client = fake({
      tenancies: rows({ property_unit_id: IDS.a.p1u1 }),
      'properties:select': rows(propertyRow({ id: IDS.a.p1 })),
      'property_units:select': sequence(
        // 1. the scope resolution
        { rows: [{ id: IDS.a.p1u1, property_id: IDS.a.p1 }] },
        // 2. the list itself — the database hands back the neighbour's unit too
        {
          rows: [
            unitRow({ id: IDS.a.p1u1, property_id: IDS.a.p1 }),
            unitRow({ id: IDS.a.p1u2, property_id: IDS.a.p1, unit_number: '1808' }),
          ],
        },
      ),
    });

    const page = await listUnits(client.client, TENANT_A, IDS.a.p1, DEFAULT_UNIT_QUERY);

    expect(page.rows.map((row) => row.id)).toEqual([IDS.a.p1u1]);
    expect(page.rows.map((row) => row.unit_number)).not.toContain('1808');
  });

  it('gives a provider only the unit behind their assigned ticket', async () => {
    const client = fake({
      maintenance_tickets: rows({ property_id: IDS.a.p1, property_unit_id: IDS.a.p1u1 }),
      'properties:select': rows(propertyRow({ id: IDS.a.p1 })),
      'property_units:select': rows(
        unitRow({ id: IDS.a.p1u1 }),
        unitRow({ id: IDS.a.p1u2, unit_number: '1808' }),
      ),
    });

    const page = await listUnits(client.client, PROVIDER_A, IDS.a.p1, DEFAULT_UNIT_QUERY);
    expect(page.rows.map((row) => row.id)).toEqual([IDS.a.p1u1]);
  });
});

describe('getUnit', () => {
  it('answers a unit that belongs to a different property with NOT_FOUND', async () => {
    const client = fake({
      'properties:select': rows(propertyRow({ id: IDS.a.p1 })),
      'property_units:select': rows(unitRow({ id: IDS.a.p2u1, property_id: IDS.a.p2 })),
    });

    const error = await captured(() => getUnit(client.client, MANAGER_A, IDS.a.p1, IDS.a.p2u1));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.logFields.reason).toBe('unit_property_mismatch');
  });

  it('answers a cross-organization unit with NOT_FOUND', async () => {
    const client = fake({
      'properties:select': rows(propertyRow({ id: IDS.a.p1 })),
      'property_units:select': rows(
        unitRow({ id: IDS.b.p1u1, organization_id: ORG_B, property_id: IDS.a.p1 }),
      ),
    });

    const error = await captured(() => getUnit(client.client, MANAGER_A, IDS.a.p1, IDS.b.p1u1));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.logFields.reason).toBe('cross_organization');
  });
});

describe('createUnit', () => {
  it('takes property_id from the path, so no body can disagree with the URL', async () => {
    const client = fake({
      'properties:select': rows(propertyRow()),
      'property_units:insert': rows(unitRow()),
    });

    await createUnit(client.client, MANAGER_A, IDS.a.p1, { unit_number: '1204' });

    const payload = queriesFor(client, 'property_units', 'insert')[0]!.payload as Record<
      string,
      unknown
    >;
    expect(payload.property_id).toBe(IDS.a.p1);
    expect(payload.organization_id).toBe(ORG_A);
    expect(payload.unit_number).toBe('1204');
    // Omitted measurements are explicit nulls, not absent keys.
    expect(payload.bedrooms).toBeNull();
    // Status is left to the DDL default when the client did not choose one.
    expect(payload).not.toHaveProperty('status');
  });

  it('answers a duplicate unit number in the same property with CONFLICT 409', async () => {
    // `unique (property_id, unit_number)` from 0001 → 23505 → CONFLICT (amendment A2).
    const client = fake({
      'properties:select': rows(propertyRow()),
      'property_units:insert': fails(
        '23505',
        'duplicate key value violates unique constraint "property_units_property_id_unit_number_key"',
      ),
    });

    const error = await captured(() =>
      createUnit(client.client, MANAGER_A, IDS.a.p1, { unit_number: '1204' }),
    );

    expect(error.code).toBe('CONFLICT');
    expect(error.status).toBe(409);
    // The raw Postgres message, which can echo row data, does not reach the client.
    expect(error.publicMessage).not.toContain('duplicate key');
  });

  it('refuses a unit on an archived property with CONFLICT and no insert', async () => {
    const client = fake({ 'properties:select': rows(propertyRow({ status: 'archived' })) });

    const error = await captured(() =>
      createUnit(client.client, MANAGER_A, IDS.a.p1, { unit_number: '1204' }),
    );

    expect(error.code).toBe('CONFLICT');
    expect(error.logFields.reason).toBe('property_archived');
    expect(queriesFor(client, 'property_units', 'insert')).toHaveLength(0);
  });

  it('refuses a property owner, who is read-only on their own property', async () => {
    const client = fake({ 'properties:select': rows(propertyRow()) });

    await expect(
      createUnit(client.client, OWNER_A, IDS.a.p1, { unit_number: '1204' }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);

    expect(queriesFor(client, 'property_units', 'insert')).toHaveLength(0);
  });
});

describe('updateUnit — the status machine on the write path', () => {
  function client(currentStatus: string, updated = unitRow()) {
    return fake({
      'properties:select': rows(propertyRow()),
      'property_units:select': rows(unitRow({ status: currentStatus })),
      'property_units:update': rows(updated),
    });
  }

  it('applies a legal transition and reports where it came from', async () => {
    const fakeClient = client('occupied', unitRow({ status: 'available' }));

    const result = await updateUnit(fakeClient.client, MANAGER_A, IDS.a.p1, IDS.a.p1u1, {
      status: 'available',
    });

    expect(result.previousStatus).toBe('occupied');
    expect(result.unit.status).toBe('available');
    expect(queriesFor(fakeClient, 'property_units', 'update')[0]!.payload).toEqual({
      status: 'available',
    });
  });

  it('refuses an illegal transition with CONFLICT 409 and issues no update', async () => {
    const fakeClient = client('occupied');

    const error = await captured(() =>
      updateUnit(fakeClient.client, MANAGER_A, IDS.a.p1, IDS.a.p1u1, { status: 'inactive' }),
    );

    expect(error.code).toBe('CONFLICT');
    expect(error.status).toBe(409);
    expect(queriesFor(fakeClient, 'property_units', 'update')).toHaveLength(0);
  });

  it('refuses the wrong role with 403 — an illegal edge is 409, the wrong role is 403', async () => {
    const fakeClient = fake({
      'properties:select': rows(propertyRow()),
      'property_units:select': rows(unitRow({ status: 'available' })),
    });

    await expect(
      updateUnit(fakeClient.client, OWNER_A, IDS.a.p1, IDS.a.p1u1, { status: 'occupied' }),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  it('clears a measurement when the body sends null', async () => {
    const fakeClient = client('available', unitRow({ bedrooms: null }));

    await updateUnit(fakeClient.client, MANAGER_A, IDS.a.p1, IDS.a.p1u1, { bedrooms: null });

    expect(queriesFor(fakeClient, 'property_units', 'update')[0]!.payload).toEqual({
      bedrooms: null,
    });
  });

  it('pins the organization, the property and the unit in the WHERE clause', async () => {
    const fakeClient = client('available');

    await updateUnit(fakeClient.client, MANAGER_A, IDS.a.p1, IDS.a.p1u1, { unit_number: '1205' });

    const update = queriesFor(fakeClient, 'property_units', 'update')[0]!;
    expect(eqValue(update, 'organization_id')).toBe(ORG_A);
    expect(eqValue(update, 'property_id')).toBe(IDS.a.p1);
    expect(eqValue(update, 'id')).toBe(IDS.a.p1u1);
  });
});

/* -------------------------------------------------------------- portfolio -- */

describe('portfolioCounts', () => {
  it('counts the caller’s own visible set, scoped by organization', async () => {
    const client = fake({ properties: counts(4), property_units: counts(10) });

    const result = await portfolioCounts(client.client, MANAGER_A);

    expect(result.properties).toBe(4);
    expect(result.units).toBe(10);
    for (const statement of client.queries) {
      expect(statement.countRequested).toBe(true);
      expect(eqValue(statement, 'organization_id')).toBe(ORG_A);
    }
  });

  it('restricts an owner’s counts to their own membership', async () => {
    const client = fake({ properties: counts(1), property_units: counts(2) });

    await portfolioCounts(client.client, OWNER_A);

    for (const statement of queriesFor(client, 'properties', 'select')) {
      expect(eqValue(statement, 'owner_member_id')).toBe(IDS.a.owner.member);
    }
  });

  it('returns zeroes without querying when the caller has no domain identity', async () => {
    const orphan = membership({ role: 'service_provider', providerId: null });
    const client = fake({});

    const result = await portfolioCounts(client.client, orphan);

    expect(result).toEqual({
      properties: 0,
      archivedProperties: 0,
      units: 0,
      occupiedUnits: 0,
      availableUnits: 0,
    });
    expect(client.queries).toHaveLength(0);
  });
});
