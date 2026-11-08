/**
 * Tenant records — the data layer for `/api/v1/tenants` and the tenant dashboard pages.
 *
 * Every function here is authorized twice over, and deliberately so: `assertAuthorized`
 * denies in application space *before* a query is issued, and Row Level Security denies
 * again inside Postgres on the assumption this file was never called. Neither layer is
 * trusted to be the only one (`docs/implementation-plan.md` §1.1).
 *
 * Three invariants this module owns, none of which the database can enforce:
 *
 *  1. **Column projection.** A `service_provider` assigned to a ticket legitimately sees
 *     the tenant's row — `tenants_select_provider_assigned` grants it — and must see
 *     only the name. The projection comes from `projectionFor()` and is applied to the
 *     `select` list, so the withheld columns are never fetched, let alone serialised.
 *  2. **One tenant record per profile per organization.** `current_tenant_id(org)` in
 *     `0002` is `select ... limit 1` with no ordering. Two `tenants` rows sharing a
 *     `profile_id` inside one organization would make that helper return an arbitrary
 *     one of them, and with it the tenant's entire RLS-visible row set. There is no
 *     unique index behind this (reported as a planning defect), so it is enforced here.
 *  3. **A linked profile must be a member of the caller's organization.** The composite
 *     foreign keys protect `tenancies`, but `tenants.profile_id` is a plain reference to
 *     `profiles(id)` with no organization component, so a staff member could otherwise
 *     link a stranger's profile to a tenant record in their organization.
 *
 * `select *` never appears below. On this table it is the difference between a provider
 * seeing a name and a provider seeing a phone number.
 */

import {
  type CreateTenantInput,
  type ListTenantsQuery,
  type TablesUpdate,
  type Tenant,
  type UpdateTenantInput,
} from '@shared/index';

import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import { assertAuthorized, authorize, projectionFor, type ResourceRef } from '@/lib/auth/authorize';

import {
  PAGE_ORDER,
  decodePageCursor,
  descendingKeysetFilter,
  takePage,
  type PageableRow,
} from './cursor';
import { sanitizeSearchTerm, type DataContext, type Page } from './context';
import {
  TENANT_FULL_FIELDS,
  serializeTenant,
  serializeTenantView,
  tenantSelectList,
  type TenantRowLike,
  type TenantView,
} from './serialize';

/**
 * The columns a staff member may change.
 *
 * `organization_id` and `created_at` are absent, and `id` is absent: a tenant record is
 * referenced by tenancies, tickets and audit rows, so its identity and its organization
 * are immutable. `UpdateTenantSchema` already omits all three — this is the second,
 * server-side half of that, so a schema change alone cannot widen what is writable.
 *
 * `_TenantPatchParity` is the compile-time link: if a future amendment adds a field to
 * `UpdateTenantSchema` that is not on this list, `tsc --noEmit` fails here rather than
 * the field being silently dropped on the way to the database.
 */
export const TENANT_MUTABLE_FIELDS = ['full_name', 'email', 'phone', 'profile_id'] as const;

type TenantMutableField = (typeof TENANT_MUTABLE_FIELDS)[number];
type _TenantPatchParity =
  Exclude<keyof UpdateTenantInput, TenantMutableField> extends never ? true : never;
const _tenantPatchParity: _TenantPatchParity = true;
void _tenantPatchParity;

const FULL_SELECT = TENANT_FULL_FIELDS.join(', ');

/* -------------------------------------------------------------------- read -- */

/**
 * A page of tenant records. Staff only.
 *
 * The role gate is `assertAuthorized(... 'read' ...)` with an organization-scoped
 * reference and no identity links, which the §4 matrix answers for exactly the two
 * staff roles: a `tenant` fails `isOwnTenant` (no `tenantId` on the reference), a
 * `service_provider` fails `isOwnProvider`, and a `property_owner` has no cell on this
 * table at all. Listing is the one tenant read that is not reachable by a narrower role
 * at all, so it is refused before a query exists rather than filtered afterwards.
 */
export async function listTenants(
  ctx: DataContext,
  query: ListTenantsQuery,
): Promise<Page<Tenant>> {
  const organizationId = ctx.membership.organization.id;
  assertAuthorized(ctx.membership, 'read', { type: 'tenant', organizationId });

  let request = ctx.supabase
    .from('tenants')
    .select(FULL_SELECT)
    .eq('organization_id', organizationId);

  if (query.q) {
    const term = sanitizeSearchTerm(query.q);
    // An all-punctuation search term sanitises to nothing. Returning every row would be
    // a surprising answer to a search, so it matches nothing instead.
    if (term.length === 0) {
      return { items: [], nextCursor: null, hasMore: false, limit: query.limit };
    }
    request = request.ilike('full_name', `%${term}%`);
  }

  if (query.cursor) {
    request = request.or(descendingKeysetFilter(decodePageCursor(query.cursor)));
  }

  for (const order of PAGE_ORDER) {
    request = request.order(order.column, { ascending: order.ascending });
  }

  const { data, error } = await request.limit(query.limit + 1);
  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as (TenantRowLike & PageableRow)[];
  const page = takePage(rows, query.limit);

  return {
    items: page.items.map((row) => serializeTenant(row)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: query.limit,
  };
}

/**
 * One tenant record, in whichever shape the caller's role permits.
 *
 * Returns a `TenantView` rather than a `Tenant` so that the two shapes cannot be
 * confused by a caller: a route rendering `view.tenant` renders whatever the matrix
 * allowed, and there is no code path that reaches the full record without having been
 * granted it.
 */
export async function getTenantById(ctx: DataContext, tenantId: string): Promise<TenantView> {
  const organizationId = ctx.membership.organization.id;

  const reference: ResourceRef = {
    type: 'tenant',
    organizationId,
    tenantId,
    providerId: await resolveProviderLink(ctx, tenantId),
  };

  assertAuthorized(ctx.membership, 'read', reference);

  const projection = projectionFor(ctx.membership, reference);
  const { data, error } = await ctx.supabase
    .from('tenants')
    .select(tenantSelectList(projection))
    .eq('organization_id', organizationId)
    .eq('id', tenantId)
    .maybeSingle();
  throwIfPostgresError(error);

  if (!data) throw notFoundTenant();
  const row = data as unknown as TenantRowLike;

  // The row is re-authorized with its own `organization_id`, not the one the query
  // filtered on. Belt and braces: if the filter above were ever dropped in a refactor,
  // this still refuses a row from another organization.
  const decision = authorize(ctx.membership, 'read', {
    ...reference,
    organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
  });
  if (!decision.allowed) {
    ctx.logger.warn('tenant read denied after fetch', {
      reason: decision.reason,
      entity_type: 'tenant',
      entity_id: tenantId,
    });
    throw notFoundTenant();
  }

  return serializeTenantView(row, projection);
}

/**
 * Is the caller a service provider assigned to a ticket raised by this tenant?
 *
 * `null` for every other role, and for a provider with no such assignment — which makes
 * `isOwnProvider` false and the read denied. The query is the application-space twin of
 * `tenants_select_provider_assigned`: the matrix's "via assignment" qualifier has to be
 * *checked* here, not assumed, because this layer must hold if RLS has a defect.
 */
async function resolveProviderLink(ctx: DataContext, tenantId: string): Promise<string | null> {
  const { membership } = ctx;
  if (membership.role !== 'service_provider' || !membership.providerId) return null;

  const { data, error } = await ctx.supabase
    .from('maintenance_tickets')
    .select('id')
    .eq('organization_id', membership.organization.id)
    .eq('tenant_id', tenantId)
    .eq('assigned_provider_id', membership.providerId)
    .limit(1);
  throwIfPostgresError(error);

  return (data ?? []).length > 0 ? membership.providerId : null;
}

/* ------------------------------------------------------------------- write -- */

/** Creates a tenant record. Staff only; `organization_id` comes from membership. */
export async function createTenant(ctx: DataContext, input: CreateTenantInput): Promise<Tenant> {
  const organizationId = ctx.membership.organization.id;
  assertAuthorized(ctx.membership, 'create', { type: 'tenant', organizationId });

  if (input.profile_id) {
    await assertProfileLinkable(ctx, input.profile_id, null);
  }

  const { data, error } = await ctx.supabase
    .from('tenants')
    .insert({
      organization_id: organizationId,
      full_name: input.full_name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      profile_id: input.profile_id ?? null,
    })
    .select(FULL_SELECT)
    .single();
  throwIfPostgresError(error);

  return serializeTenant(data as unknown as TenantRowLike);
}

/**
 * Updates a tenant record. Staff only.
 *
 * The patch is built by intersecting the validated body with
 * `TENANT_MUTABLE_FIELDS`, so a column the matrix withholds cannot be written even if a
 * future schema change let it through validation.
 */
export async function updateTenant(
  ctx: DataContext,
  tenantId: string,
  input: UpdateTenantInput,
): Promise<Tenant> {
  const organizationId = ctx.membership.organization.id;
  assertAuthorized(ctx.membership, 'update', { type: 'tenant', organizationId, tenantId });

  // Written out field by field rather than copied from the body. A loop over the body's
  // keys would write whatever the schema happened to allow; this writes only these four,
  // and `_TenantPatchParity` above fails the build if the schema ever grows a fifth.
  const patch: TablesUpdate<'tenants'> = {};
  if (input.full_name !== undefined) patch.full_name = input.full_name;
  if (input.email !== undefined) patch.email = input.email ?? null;
  if (input.phone !== undefined) patch.phone = input.phone ?? null;
  if (input.profile_id !== undefined) patch.profile_id = input.profile_id ?? null;

  if (Object.keys(patch).length === 0) {
    // `UpdateTenantSchema` already refuses an empty body; reaching here would mean the
    // body carried only fields this list withholds.
    throw new ApiRouteError('VALIDATION_ERROR', {
      message: 'Provide at least one updatable field.',
      logFields: { reason: 'tenant_patch_empty' },
    });
  }

  if (typeof input.profile_id === 'string') {
    await assertProfileLinkable(ctx, input.profile_id, tenantId);
  }

  const { data, error } = await ctx.supabase
    .from('tenants')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', tenantId)
    .select(FULL_SELECT)
    .maybeSingle();
  throwIfPostgresError(error);

  if (!data) throw notFoundTenant();
  return serializeTenant(data as unknown as TenantRowLike);
}

/* ---------------------------------------------------------------- linkage -- */

/**
 * May this profile be linked to a tenant record in the caller's organization?
 *
 * Two checks, two different statuses:
 *
 *  - Not an active member of this organization → 422. The body is well-formed but
 *    semantically wrong, which is what `docs/api-contracts.md` reserves 422 for. It is
 *    also the check that stops a staff member attaching a profile from organization B.
 *  - Already linked to a different tenant record → 409. `current_tenant_id()` resolves
 *    `profile_id → tenants.id` with `limit 1`, so a second link would silently make a
 *    person's self-service view non-deterministic.
 *
 * `organization_members` is queried rather than `profiles`: it answers the membership
 * question directly, and `eslint.config.mjs` restricts ad-hoc `profiles` access to
 * `lib/auth/roles.ts` for precisely this reason.
 */
async function assertProfileLinkable(
  ctx: DataContext,
  profileId: string,
  excludeTenantId: string | null,
): Promise<void> {
  const organizationId = ctx.membership.organization.id;

  const { data: member, error: memberError } = await ctx.supabase
    .from('organization_members')
    .select('id, status')
    .eq('organization_id', organizationId)
    .eq('profile_id', profileId)
    .eq('status', 'active')
    .maybeSingle();
  throwIfPostgresError(memberError);

  if (!member) {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'That user is not an active member of this organization.',
      logFields: { reason: 'tenant_profile_not_a_member', profile_id: profileId },
    });
  }

  const { data: existing, error: existingError } = await ctx.supabase
    .from('tenants')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('profile_id', profileId)
    .limit(2);
  throwIfPostgresError(existingError);

  const clash = (existing ?? []).find((row) => row.id !== excludeTenantId);
  if (clash) {
    throw new ApiRouteError('CONFLICT', {
      message: 'That user is already linked to a tenant record in this organization.',
      logFields: { reason: 'tenant_profile_already_linked', profile_id: profileId },
    });
  }
}

/**
 * The denial for a tenant record that does not exist **or** is not visible to the
 * caller, which must be indistinguishable. A 403 here would confirm that a given
 * identifier names a real tenant in some organization.
 */
function notFoundTenant(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', {
    message: 'That tenant record was not found.',
    logFields: { reason: 'tenant_not_visible', entity_type: 'tenant' },
  });
}
