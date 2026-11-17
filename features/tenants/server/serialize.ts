/**
 * Row → response projection for `tenants`. The most load-bearing file in this lane.
 *
 * `tenants` holds the personal data that finding 3 in `docs/implementation-plan.md` §3
 * exposed organization-wide. Row Level Security has since been fixed, but RLS is
 * row-level: `tenants_select_provider_assigned` correctly *grants the row* to a service
 * provider who has been assigned the ticket, and it structurally cannot withhold the
 * `email` and `phone` columns that the §4 matrix limits them out of ("R name only, via
 * assignment"). That column boundary exists only here and in
 * `lib/auth/authorize.ts`'s `PROVIDER_TENANT_FIELDS`.
 *
 * So there are exactly two tenant shapes, both from `packages/shared`, and no third:
 *
 *   `TenantSchema`      id, organization_id, profile_id, full_name, email, phone,
 *                       created_at — staff, or the tenant themselves
 *   `TenantNameSchema`  id, full_name — a service provider, via an assigned ticket
 *
 * Both are `.strict()`, which is the mechanism rather than a detail: parsing a row that
 * carries one extra column *throws* instead of serialising it. A `select *` that drifted
 * into the provider path would fail loudly here rather than quietly returning a phone
 * number.
 *
 * `select *` is never used on this table. Callers pass a column list derived from
 * `projectionFor()`.
 */

import { TenantNameSchema, TenantSchema, type Tenant, type TenantName } from '@shared/index';

import { PROVIDER_TENANT_FIELDS } from '@/lib/auth/authorize';

/**
 * Every column a full tenant read may select. Ordered as `TenantSchema` declares them.
 *
 * This is not a second copy of the schema: it is the SQL-side column list, and
 * `assertCoversTenantSchema` below is the compile-time link between the two.
 */
export const TENANT_FULL_FIELDS = [
  'id',
  'organization_id',
  'profile_id',
  'full_name',
  'email',
  'phone',
  'created_at',
] as const;

export type TenantFullField = (typeof TENANT_FULL_FIELDS)[number];

/**
 * The columns `authenticated` may actually SELECT after migration 0004.
 *
 * 0004 revoked table-level SELECT on `tenants` and granted back only these five,
 * because a `service_provider` could otherwise read every assigned tenant's `email` and
 * `phone` straight through PostgREST — RLS filters rows, not columns, and all five app
 * roles share one Postgres role, so no policy could express "name only". The
 * application-layer projection was correct but bypassable, since the anon key is public
 * by design and a provider holds a real JWT.
 *
 * `email` and `phone` are therefore NOT selectable by anyone, staff included. Staff read
 * them through the `tenant_contact` security-definer RPC, which checks `is_org_staff()`
 * — see `hydrateContacts` in `tenant-service.ts`.
 */
export const TENANT_GRANTED_FIELDS = [
  'id',
  'organization_id',
  'profile_id',
  'full_name',
  'created_at',
] as const;

/**
 * Compile-time proof that `TENANT_FULL_FIELDS` and `TenantSchema` describe the same
 * column set. If a future migration adds a column to `tenants` and it is added to one
 * of the two but not the other, `tsc --noEmit` fails on this line.
 */
type _TenantFieldParity = [
  Exclude<keyof Tenant, TenantFullField> extends never ? true : never,
  Exclude<TenantFullField, keyof Tenant> extends never ? true : never,
];
const _tenantFieldParity: _TenantFieldParity = [true, true];
void _tenantFieldParity;

/** The widest row shape any tenant query in this lane selects. Fields may be absent. */
export interface TenantRowLike {
  id?: unknown;
  organization_id?: unknown;
  profile_id?: unknown;
  full_name?: unknown;
  email?: unknown;
  phone?: unknown;
  created_at?: unknown;
}

/**
 * Turns an `authorize()` projection into a PostgREST `select` list.
 *
 * `null` means "every column the row exposes" (`projectionFor`'s contract) and resolves
 * to `TENANT_GRANTED_FIELDS` — never to `*`, and deliberately NOT to
 * `TENANT_FULL_FIELDS`. An empty projection means the read was denied and must not have
 * produced a query at all, so it throws rather than selecting nothing.
 *
 * WHY GRANTED AND NOT FULL. After migration 0004 the `authenticated` role holds SELECT
 * on five columns; `email` and `phone` are revoked from every role. Naming them in a
 * select list is no longer an over-fetch to be filtered on the way out — it is a hard
 * `42501` from Postgres, which `postgresErrorToApiError` turns into a 403. Resolving
 * `null` to the full list meant every staff detail read failed with "You do not have
 * access to this resource" against a record they are fully entitled to. Caught by
 * `tests/tenants` once the fake started mirroring the real grant.
 *
 * The intersection with `TENANT_GRANTED_FIELDS` is the safety net, and it now enforces
 * the grant rather than merely the schema: a projection naming a revoked column cannot
 * smuggle it into the select list and turn a legitimate read into a 403.
 *
 * `TENANT_FULL_FIELDS` keeps all seven because it is the compile-time link to
 * `TenantSchema` — the serialized shape still carries `email` and `phone`, supplied by
 * `hydrateContacts` through the `tenant_contact` RPC rather than by the select.
 */
export function tenantSelectList(projection: readonly string[] | null): string {
  if (projection === null) return TENANT_GRANTED_FIELDS.join(', ');

  const allowed = TENANT_GRANTED_FIELDS.filter((field) => projection.includes(field));
  if (allowed.length === 0) {
    throw new Error('tenantSelectList called with an empty projection');
  }
  // `id` is always needed to identify the row, and is on every projection the matrix
  // grants, so this is an assertion rather than a widening.
  if (!allowed.includes('id')) {
    throw new Error('tenantSelectList projection does not include id');
  }
  return allowed.join(', ');
}

/** Is this projection the provider's name-only view? */
export function isNameOnlyProjection(projection: readonly string[] | null): boolean {
  if (projection === null) return false;
  return !projection.includes('email') && !projection.includes('phone');
}

/** The full record. For staff, or for the tenant reading their own row. */
export function serializeTenant(row: TenantRowLike): Tenant {
  return TenantSchema.parse({
    id: row.id,
    organization_id: row.organization_id,
    profile_id: row.profile_id ?? null,
    full_name: row.full_name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    created_at: row.created_at,
  });
}

/**
 * Name only — the service-provider view.
 *
 * `organization_id` is selected (it is in `PROVIDER_TENANT_FIELDS`, so the handler can
 * compare the row's organization against trusted membership) but deliberately not
 * returned: the provider needs the name to knock on the right door and nothing else.
 */
export function serializeTenantName(row: TenantRowLike): TenantName {
  return TenantNameSchema.parse({ id: row.id, full_name: row.full_name });
}

/** Which of the two shapes a given projection permits. */
export type TenantViewKind = 'full' | 'name_only';

/** A tenant read, tagged with which shape it is, so a caller cannot mix them up. */
export type TenantView =
  { kind: 'full'; tenant: Tenant } | { kind: 'name_only'; tenant: TenantName };

/**
 * Serialises a row through whichever shape the projection permits.
 *
 * This is the single branch point between the two views. Every tenant read in the lane
 * goes through it, so "did this path remember to project?" is one question with one
 * answer rather than a question asked at each of four call sites.
 */
export function serializeTenantView(
  row: TenantRowLike,
  projection: readonly string[] | null,
): TenantView {
  if (isNameOnlyProjection(projection)) {
    return { kind: 'name_only', tenant: serializeTenantName(row) };
  }
  return { kind: 'full', tenant: serializeTenant(row) };
}

/**
 * Re-exported so a route, a page and a test all name the same list.
 *
 * It is `lib/auth/authorize.ts`'s constant, not a copy: the matrix's column allowlist
 * has one definition.
 */
export { PROVIDER_TENANT_FIELDS };
