/**
 * Column projection on `tenants` — the control Row Level Security cannot provide.
 *
 * The §4 matrix grants a `service_provider` a tenant's "name only, via assignment".
 * `0002`'s `tenants_select_provider_assigned` correctly grants the **row**; a row-level
 * policy cannot withhold a **column**. These tests exercise the mechanism that does:
 * `projectionFor()` → `tenantSelectList()` → `serializeTenantView()`.
 *
 * Every assertion below is about the *absence* of `email` and `phone`. Asserting that a
 * provider's read succeeded, or that a different role's read was refused, would leave the
 * actual failure mode — a successful read carrying two extra columns — untested.
 */

import { describe, expect, it } from 'vitest';

import { PROVIDER_TENANT_FIELDS, projectionFor } from '@/lib/auth/authorize';
import { TenantNameSchema, TenantSchema } from '@shared/index';

import {
  TENANT_FULL_FIELDS,
  isNameOnlyProjection,
  serializeTenant,
  serializeTenantName,
  serializeTenantView,
  tenantSelectList,
} from '@/features/tenants/server/serialize';

import { ORG_A, PROVIDER_ONE, TENANT_ONE, membership, seedTables } from './_support/fixtures';

/** The row as it exists in the database: name, email and phone all populated. */
function storedTenantRow() {
  const row = seedTables().tenants.find((candidate) => candidate.id === TENANT_ONE);
  if (!row) throw new Error('fixture missing');
  return row;
}

describe('the provider projection', () => {
  it('is exactly (id, organization_id, full_name)', () => {
    // Pinned against the matrix rather than derived from the constant, so a change to
    // `PROVIDER_TENANT_FIELDS` has to be a deliberate edit of this expectation too.
    expect([...PROVIDER_TENANT_FIELDS]).toEqual(['id', 'organization_id', 'full_name']);
  });

  it('contains no contact column', () => {
    expect(PROVIDER_TENANT_FIELDS).not.toContain('email');
    expect(PROVIDER_TENANT_FIELDS).not.toContain('phone');
    expect(PROVIDER_TENANT_FIELDS).not.toContain('profile_id');
  });

  it('is what the matrix hands a provider with an assignment', () => {
    const projection = projectionFor(membership('service_provider'), {
      type: 'tenant',
      organizationId: ORG_A,
      providerId: PROVIDER_ONE,
    });

    expect(projection).toEqual(PROVIDER_TENANT_FIELDS);
  });

  it('is empty — not narrow — for a provider with no assignment', () => {
    const projection = projectionFor(membership('service_provider'), {
      type: 'tenant',
      organizationId: ORG_A,
      providerId: null,
    });

    // `[]` means the read was denied outright, which `tenantSelectList` refuses to turn
    // into a query at all.
    expect(projection).toEqual([]);
    expect(() => tenantSelectList(projection)).toThrow(/empty projection/);
  });
});

describe('tenantSelectList', () => {
  it('never emits a wildcard', () => {
    expect(tenantSelectList(null)).not.toContain('*');
    expect(tenantSelectList(PROVIDER_TENANT_FIELDS)).not.toContain('*');
  });

  it('selects every column for an unrestricted read', () => {
    const list = tenantSelectList(null);
    for (const field of TENANT_FULL_FIELDS) expect(list).toContain(field);
  });

  it('omits email and phone for the provider projection', () => {
    const list = tenantSelectList(PROVIDER_TENANT_FIELDS);

    expect(list).toBe('id, organization_id, full_name');
    expect(list).not.toContain('email');
    expect(list).not.toContain('phone');
  });

  it('drops a column that is not on the table allowlist', () => {
    // A projection naming something outside `TENANT_FULL_FIELDS` cannot smuggle it into
    // the select list — the intersection is one-directional.
    const list = tenantSelectList(['id', 'full_name', 'auth_user_id', 'password_hash']);

    expect(list).toBe('id, full_name');
  });

  it('refuses a projection without id', () => {
    expect(() => tenantSelectList(['full_name'])).toThrow(/does not include id/);
  });
});

describe('serialisation', () => {
  it('serialises the name-only view with two keys and no contact details', () => {
    const view = serializeTenantView(
      { id: TENANT_ONE, organization_id: ORG_A, full_name: 'Tariq Tenant' },
      PROVIDER_TENANT_FIELDS,
    );

    expect(view.kind).toBe('name_only');
    expect(Object.keys(view.tenant).sort()).toEqual(['full_name', 'id']);
    expect(view.tenant).not.toHaveProperty('email');
    expect(view.tenant).not.toHaveProperty('phone');
    // `organization_id` is selected so the handler can compare it against trusted
    // membership, and deliberately not returned.
    expect(view.tenant).not.toHaveProperty('organization_id');
  });

  it('refuses to emit contact details through the name-only shape at all', () => {
    // `TenantNameSchema` is `.strict()`, so there is no way to serialise a phone number
    // through it even by passing one: the shape itself is the guarantee.
    expect(() =>
      TenantNameSchema.parse({ id: TENANT_ONE, full_name: 'Tariq Tenant', phone: '+971500000001' }),
    ).toThrow();
  });

  it('strips withheld columns even if a caller hands over the whole stored row', () => {
    // The belt to the braces: the service never fetches the columns, and if a future
    // refactor did, the name-only path still cannot serialise them.
    const view = serializeTenantView(storedTenantRow(), PROVIDER_TENANT_FIELDS);

    expect(JSON.stringify(view.tenant)).not.toContain('example.test');
    expect(JSON.stringify(view.tenant)).not.toContain('+9715');
  });

  it('serialises the full record for an unrestricted read', () => {
    const view = serializeTenantView(storedTenantRow(), null);

    expect(view.kind).toBe('full');
    expect(view.tenant).toMatchObject({
      id: TENANT_ONE,
      full_name: 'Tariq Tenant',
      email: 'tariq@example.test',
    });
  });

  it('normalises absent optional columns to null rather than undefined', () => {
    const tenant = serializeTenant({
      id: TENANT_ONE,
      organization_id: ORG_A,
      full_name: 'Tariq Tenant',
      created_at: '2026-01-02T00:00:00+00:00',
    });

    expect(tenant.email).toBeNull();
    expect(tenant.phone).toBeNull();
    expect(tenant.profile_id).toBeNull();
    expect(() => TenantSchema.parse(tenant)).not.toThrow();
  });

  it('rejects a row whose name-only projection is missing the name', () => {
    expect(() => serializeTenantName({ id: TENANT_ONE })).toThrow();
  });
});

describe('isNameOnlyProjection', () => {
  it('treats an unrestricted projection as the full view', () => {
    expect(isNameOnlyProjection(null)).toBe(false);
  });

  it('treats any projection without email and phone as name-only', () => {
    expect(isNameOnlyProjection(PROVIDER_TENANT_FIELDS)).toBe(true);
    expect(isNameOnlyProjection(['id', 'full_name', 'email'])).toBe(false);
    expect(isNameOnlyProjection(['id', 'full_name', 'phone'])).toBe(false);
  });
});
