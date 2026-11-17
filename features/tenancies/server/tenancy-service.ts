/**
 * Tenancies — the data layer for `/api/v1/tenancies` and the tenancy dashboard pages.
 *
 * The lease is where this lane's two sensitive things meet: a person and a rent figure.
 * Four rules are enforced here and nowhere else, because no migration in this build
 * expresses them:
 *
 *  1. **No two ACTIVE tenancies overlap on one unit.** `0001` has no exclusion
 *     constraint and `0003` adds no trigger for it, so a race aside this is the only
 *     check standing between one unit and two concurrent tenants. The predicate is pure
 *     and lives in `../occupancy.ts`; this module supplies it the rows.
 *  2. **The lifecycle edge set.** `ALLOWED_TENANCY_TRANSITIONS` is advisory — unlike the
 *     ticket machine there is no database trigger — so `assertTenancyTransition` in
 *     `../lifecycle.ts` is the enforcement point, and every transition it permits leaves
 *     its own audit row carrying `from_status` and `to_status`.
 *  3. **`property_units.status` follows the unit's active tenancy.** Denormalized state,
 *     reconciled after every write that could have changed the answer.
 *  4. **The embedded tenant is authorized separately from the tenancy.** The §4 matrix
 *     gives a `property_owner` `R owned` on `tenancies` and nothing at all on `tenants`.
 *     An owner reading a lease on their own building therefore gets the rent and the
 *     dates and **no contact details** — see `serializeTenancyDetail`.
 *
 * Cross-organization safety is structural rather than checked: the composite foreign
 * keys `(organization_id, property_unit_id)` and `(organization_id, tenant_id)` make a
 * mismatched pair impossible to insert. This module still verifies both ids against the
 * caller's organization first, because a foreign-key violation would surface as a 422
 * with no useful message, and because a lane must not rely on the other layer.
 */

import {
  DEFAULT_CURRENCY,
  type CreateTenancyInput,
  type ListTenanciesQuery,
  type TablesUpdate,
  type Tenancy,
  type TenancyDetail,
  type TenancyStatus,
  type Tenant,
  type UnitStatus,
  type UpdateTenancyInput,
} from '@shared/index';

import { ApiRouteError, isApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import {
  AuthorizationDeniedError,
  assertAuthorized,
  authorize,
  projectionFor,
  type ResourceRef,
} from '@/lib/auth/authorize';
import type { Membership } from '@/lib/auth/roles';
import { writeAuditLog } from '@/lib/audit/write';

import {
  PAGE_ORDER,
  decodePageCursor,
  descendingKeysetFilter,
  takePage,
  type PageableRow,
} from '@/features/tenants/server/cursor';
import type { DataContext, Page } from '@/features/tenants/server/context';
import { getTenantById } from '@/features/tenants/server/tenant-service';

import {
  CREATABLE_TENANCY_STATUSES,
  asTenancyStatus,
  assertTenancyTransition,
  occupiesUnit,
} from '../lifecycle';
import {
  addDays,
  asUnitStatus,
  findOverlappingTenancy,
  reconciledUnitStatus,
  todayIsoDate,
  type TenancyInterval,
} from '../occupancy';
import {
  TENANCY_SELECT,
  UNIT_SELECT,
  serializeTenancy,
  serializeTenancyDetail,
  serializeUnit,
  type TenancyRowLike,
  type UnitRowLike,
} from './serialize';

/**
 * Columns a staff member may change. The unit, the tenant and the organization are not
 * among them: re-letting a unit or substituting a tenant is a new tenancy, not an edit.
 *
 * `_TenancyPatchParity` fails the build if `UpdateTenancySchema` ever grows a field this
 * list does not carry, rather than letting it be silently discarded.
 */
export const TENANCY_MUTABLE_FIELDS = [
  'contract_number',
  'start_date',
  'end_date',
  'rent_amount',
  'currency',
  'status',
] as const;

type TenancyMutableField = (typeof TENANCY_MUTABLE_FIELDS)[number];
type _TenancyPatchParity =
  Exclude<keyof UpdateTenancyInput, TenancyMutableField> extends never ? true : never;
const _tenancyPatchParity: _TenancyPatchParity = true;
void _tenancyPatchParity;

/**
 * Upper bound on the active tenancies fetched for an overlap check.
 *
 * If the invariant holds there is at most one, so any number above one is already a
 * symptom. A hundred is generous enough that a historical data problem is *visible* to
 * the check rather than silently truncated past it.
 */
const OVERLAP_SCAN_LIMIT = 100;

/* ------------------------------------------------------------------- scope -- */

/**
 * The row set a role may read, stated explicitly in application space.
 *
 * This is the `tenancies` column of the §4 matrix as a query filter. It exists because
 * `authorize()` cannot gate a *list*: deciding an owner's access needs the row's
 * `owner_member_id`, which is two joins away and not known before the query runs. So the
 * list path scopes by role here, lets RLS scope again in Postgres, and then re-authorizes
 * each returned row with its hydrated ownership — three independent narrowings.
 *
 * The `switch` is exhaustive over `MemberRole`, so adding a sixth role fails to compile
 * rather than silently defaulting to one of the branches.
 */
export type TenancyScope =
  | { kind: 'organization' }
  | { kind: 'own_tenant'; tenantId: string }
  | { kind: 'owned_properties' }
  /** A legitimate role with nothing to see — an empty page, not a denial. */
  | { kind: 'empty' }
  /** A role the matrix excludes from the table entirely. */
  | { kind: 'denied' };

export function tenancyReadScope(membership: Membership): TenancyScope {
  if (membership.status !== 'active' || membership.organization.status !== 'active') {
    return { kind: 'denied' };
  }

  switch (membership.role) {
    case 'organization_admin':
    case 'property_manager':
      return { kind: 'organization' };
    case 'property_owner':
      return { kind: 'owned_properties' };
    case 'tenant':
      // A member with the tenant role but no `tenants` row has no tenancy by
      // definition. That is an empty result, not a refusal: refusing would imply the
      // role is wrong when the record is merely not linked yet.
      return membership.tenantId
        ? { kind: 'own_tenant', tenantId: membership.tenantId }
        : { kind: 'empty' };
    case 'service_provider':
      return { kind: 'denied' };
  }
}

/* -------------------------------------------------------------------- read -- */

/**
 * A page of tenancies, scoped to the caller's role.
 *
 * A tenant passing another tenant's `?tenant_id=` gets their own rows, not a denial:
 * the filter narrows an already-scoped set and can never widen it. Returning 403 would
 * confirm that the identifier they guessed names a real tenant.
 */
export async function listTenancies(
  ctx: DataContext,
  query: ListTenanciesQuery,
): Promise<Page<Tenancy>> {
  const organizationId = ctx.membership.organization.id;
  const scope = tenancyReadScope(ctx.membership);

  if (scope.kind === 'denied') {
    throw new AuthorizationDeniedError('tenancy_not_permitted_for_role', 'tenancy', 'read');
  }
  const emptyPage: Page<Tenancy> = {
    items: [],
    nextCursor: null,
    hasMore: false,
    limit: query.limit,
  };
  if (scope.kind === 'empty') return emptyPage;

  let request = ctx.supabase
    .from('tenancies')
    .select(TENANCY_SELECT)
    .eq('organization_id', organizationId);

  if (scope.kind === 'own_tenant') {
    request = request.eq('tenant_id', scope.tenantId);
  } else if (query.tenant_id) {
    request = request.eq('tenant_id', query.tenant_id);
  }

  if (query.status) request = request.eq('status', query.status);
  if (query.property_unit_id) request = request.eq('property_unit_id', query.property_unit_id);
  if (query.cursor) request = request.or(descendingKeysetFilter(decodePageCursor(query.cursor)));

  for (const order of PAGE_ORDER) {
    request = request.order(order.column, { ascending: order.ascending });
  }

  const { data, error } = await request.limit(query.limit + 1);
  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as (TenancyRowLike & PageableRow)[];
  const page = takePage(rows, query.limit);
  const visible = await filterAuthorizedTenancies(ctx, page.items);

  return {
    items: visible.map((row) => serializeTenancy(row)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit: query.limit,
  };
}

/**
 * Re-authorizes a fetched page row by row, with ownership hydrated.
 *
 * For staff and for a tenant the decision needs nothing the row does not already carry.
 * For a `property_owner` it needs `properties.owner_member_id`, which costs two bounded
 * queries per page regardless of page size — the alternative, resolving every owned unit
 * up front, grows with the portfolio and needs a cap.
 *
 * A row that RLS returned and this check rejects is logged as
 * `authorization_layer_disagreement`: the two layers are supposed to agree, so a
 * disagreement is a defect in one of them and must be visible rather than merely
 * handled. The cursor is still taken from the database page, so dropping a row cannot
 * stall pagination.
 */
async function filterAuthorizedTenancies<T extends TenancyRowLike>(
  ctx: DataContext,
  rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return [];

  const ownerByUnit =
    ctx.membership.role === 'property_owner' ? await hydrateUnitOwners(ctx, rows) : new Map();

  const allowed: T[] = [];
  for (const row of rows) {
    const unitId = typeof row.property_unit_id === 'string' ? row.property_unit_id : null;
    const decision = authorize(ctx.membership, 'read', {
      type: 'tenancy',
      organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
      tenantId: typeof row.tenant_id === 'string' ? row.tenant_id : null,
      ownerMemberId: unitId ? (ownerByUnit.get(unitId) ?? null) : null,
    });

    if (decision.allowed) {
      allowed.push(row);
      continue;
    }

    ctx.logger.warn('tenancy row withheld after fetch', {
      reason: 'authorization_layer_disagreement',
      entity_type: 'tenancy',
      entity_id: typeof row.id === 'string' ? row.id : null,
      unit_id: unitId,
    });
  }

  return allowed;
}

/** `property_unit_id → properties.owner_member_id` for the units on one page. */
async function hydrateUnitOwners(
  ctx: DataContext,
  rows: readonly TenancyRowLike[],
): Promise<Map<string, string | null>> {
  const unitIds = unique(rows.map((row) => row.property_unit_id));
  if (unitIds.length === 0) return new Map();

  const { data: units, error: unitError } = await ctx.supabase
    .from('property_units')
    .select('id, property_id')
    .eq('organization_id', ctx.membership.organization.id)
    .in('id', unitIds);
  throwIfPostgresError(unitError);

  const propertyByUnit = new Map<string, string>();
  for (const unit of units ?? []) propertyByUnit.set(unit.id, unit.property_id);

  const propertyIds = unique([...propertyByUnit.values()]);
  if (propertyIds.length === 0) return new Map();

  const { data: properties, error: propertyError } = await ctx.supabase
    .from('properties')
    .select('id, owner_member_id')
    .eq('organization_id', ctx.membership.organization.id)
    .in('id', propertyIds);
  throwIfPostgresError(propertyError);

  const ownerByProperty = new Map<string, string | null>();
  for (const property of properties ?? []) {
    ownerByProperty.set(property.id, property.owner_member_id ?? null);
  }

  const ownerByUnit = new Map<string, string | null>();
  for (const [unitId, propertyId] of propertyByUnit) {
    ownerByUnit.set(unitId, ownerByProperty.get(propertyId) ?? null);
  }
  return ownerByUnit;
}

/**
 * One tenancy, with the unit and the tenant embedded only where the matrix allows.
 *
 * Both embeds are fetched *after* the tenancy read is authorized, each behind its own
 * `authorize()` call for its own resource type. A failed embed is an omitted key, never
 * an error: an owner is entitled to the lease and not to the tenant, and that is a
 * successful response, not a partial failure.
 */
export async function getTenancyById(ctx: DataContext, tenancyId: string): Promise<TenancyDetail> {
  const organizationId = ctx.membership.organization.id;
  const scope = tenancyReadScope(ctx.membership);
  if (scope.kind === 'denied') {
    throw new AuthorizationDeniedError('tenancy_not_permitted_for_role', 'tenancy', 'read');
  }
  if (scope.kind === 'empty') throw notFoundTenancy();

  const { data, error } = await ctx.supabase
    .from('tenancies')
    .select(TENANCY_SELECT)
    .eq('organization_id', organizationId)
    .eq('id', tenancyId)
    .maybeSingle();
  throwIfPostgresError(error);
  if (!data) throw notFoundTenancy();

  const row = data as unknown as TenancyRowLike;
  const unitId = asString(row.property_unit_id);
  const tenantId = asString(row.tenant_id);

  const unitRow = unitId ? await loadUnit(ctx, unitId) : null;
  const ownerMemberId = unitRow ? await loadUnitOwnerMember(ctx, unitRow) : null;

  const reference: ResourceRef = {
    type: 'tenancy',
    organizationId: asString(row.organization_id),
    tenantId,
    ownerMemberId,
  };
  const decision = authorize(ctx.membership, 'read', reference);
  if (!decision.allowed) {
    ctx.logger.warn('tenancy read denied after fetch', {
      reason: decision.reason,
      entity_type: 'tenancy',
      entity_id: tenancyId,
    });
    // Not a 403: the caller must not learn that the identifier names a real tenancy.
    throw notFoundTenancy();
  }

  const unit =
    unitRow &&
    authorize(ctx.membership, 'read', {
      type: 'property_unit',
      organizationId: asString(unitRow.organization_id),
      ownerMemberId,
      tenantId,
    }).allowed
      ? serializeUnit(unitRow)
      : null;

  const tenant = tenantId ? await loadEmbeddedTenant(ctx, tenantId) : null;

  return serializeTenancyDetail(row, { unit, tenant });
}

/**
 * The tenant record to embed, or `null` when the caller has no access to `tenants`.
 *
 * The gate is `projectionFor()` on the `tenant` resource, so the outcome is exactly the
 * matrix's: staff get the record, the tenant themselves get their own, a
 * `property_owner` gets `null` (no cell), and a `service_provider` never reaches this
 * function because the tenancy read already refused them. A name-only projection is
 * also treated as `null` — `TenancyDetailSchema` embeds `TenantSchema`, which has no
 * reduced form, so there is no shape in which a partial record could be attached.
 *
 * WHY THIS DELEGATES RATHER THAN QUERYING. Migration `0004_agentic.sql` revoked SELECT
 * on `tenants.email` and `tenants.phone` for *every* role, staff included: RLS filters
 * rows and not columns, all five application roles share the single Postgres role
 * `authenticated`, and so the matrix's "name only, via assignment" for a
 * `service_provider` was not expressible as a policy. The two columns now have exactly
 * one read path — the `security definer` RPC `tenant_contact(p_organization_id,
 * p_tenant_id)`, which checks `is_org_staff()` and raises `42501` otherwise.
 *
 * Selecting the granted five columns here and serialising them therefore produced a
 * tenancy detail whose `tenant.email` and `tenant.phone` were silently `null` for
 * everybody — a blank contact panel with no error to explain it. The hydration lives in
 * `hydrateContacts()` inside `tenant-service.ts`, which is private to that module, so
 * this calls the exported read that already uses it instead of copying the RPC call into
 * this lane (CLAUDE.md rule 4). That read performs the same `projectionFor()` gate, the
 * same granted-column select, a second authorization against the row's own
 * `organization_id`, and then one `tenant_contact` call — one RPC for the request, not
 * one per row.
 *
 * A non-staff caller who is not the tenant themselves is refused by the RPC and keeps
 * the nulls. That is the boundary holding, and there is deliberately no fallback that
 * fills the fields some other way: a `property_owner` is already turned away by the
 * projection gate above, and a `service_provider` never reaches this function.
 *
 * `getTenantById` raises `NOT_FOUND` where this function returned `null` — the tenancy
 * itself has already been authorized at this point, so an invisible or missing tenant
 * record drops the embed rather than 404-ing a lease the caller may read.
 */
async function loadEmbeddedTenant(ctx: DataContext, tenantId: string): Promise<Tenant | null> {
  const projection = projectionFor(ctx.membership, {
    type: 'tenant',
    organizationId: ctx.membership.organization.id,
    tenantId,
  });
  if (projection !== null) return null;

  try {
    const view = await getTenantById(ctx, tenantId);
    return view.kind === 'full' ? view.tenant : null;
  } catch (error) {
    if (isApiRouteError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/**
 * The caller's own tenancies, for the tenant self-service view.
 *
 * `tenant_id` is filtered to `membership.tenantId`, which `resolveMembership()` read
 * from `tenants.profile_id = <the verified session's profile>`. There is no parameter
 * through which a caller could ask about anybody else, which is the acceptance criterion
 * "a signed-in tenant sees their own tenancy and provably cannot read another's" stated
 * as a type signature rather than as a check.
 */
export async function listOwnTenancies(ctx: DataContext, limit = 25): Promise<TenancyDetail[]> {
  const tenantId = ctx.membership.tenantId;
  if (!tenantId) return [];

  const { data, error } = await ctx.supabase
    .from('tenancies')
    .select(TENANCY_SELECT)
    .eq('organization_id', ctx.membership.organization.id)
    .eq('tenant_id', tenantId)
    .order('start_date', { ascending: false })
    .limit(limit);
  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as TenancyRowLike[];
  const details: TenancyDetail[] = [];

  for (const row of rows) {
    if (asString(row.tenant_id) !== tenantId) {
      // Unreachable through the filter above and through `tenancies_select_own`. Logged
      // and dropped rather than trusted, because this is the one query in the lane whose
      // whole purpose is that it returns nobody else's lease.
      ctx.logger.error('own-tenancy query returned a foreign row', {
        reason: 'self_scope_violation',
        entity_type: 'tenancy',
        entity_id: asString(row.id),
      });
      continue;
    }
    const unitId = asString(row.property_unit_id);
    const unitRow = unitId ? await loadUnit(ctx, unitId) : null;
    details.push(serializeTenancyDetail(row, { unit: unitRow ? serializeUnit(unitRow) : null }));
  }

  return details;
}

/**
 * Tenancies ending within `withinDays`, soonest first. Backs the dashboard widget.
 *
 * Role scoping is the same as the list route's, so the widget shows a manager the
 * organization's renewals and a tenant their own — one query, no role-specific branches
 * in the UI.
 */
export async function listExpiringTenancies(
  ctx: DataContext,
  options: { withinDays?: number; limit?: number } = {},
): Promise<Tenancy[]> {
  const withinDays = options.withinDays ?? 60;
  const limit = Math.min(options.limit ?? 10, 50);
  const scope = tenancyReadScope(ctx.membership);
  if (scope.kind === 'denied' || scope.kind === 'empty') return [];

  const today = todayIsoDate();

  let request = ctx.supabase
    .from('tenancies')
    .select(TENANCY_SELECT)
    .eq('organization_id', ctx.membership.organization.id)
    .eq('status', 'active')
    .gte('end_date', today)
    .lte('end_date', addDays(today, withinDays));

  if (scope.kind === 'own_tenant') request = request.eq('tenant_id', scope.tenantId);

  const { data, error } = await request.order('end_date', { ascending: true }).limit(limit);
  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as TenancyRowLike[];
  const visible = await filterAuthorizedTenancies(ctx, rows);
  return visible.map((row) => serializeTenancy(row));
}

/* ------------------------------------------------------------------- write -- */

export interface TenancyWriteResult {
  tenancy: Tenancy;
  /** The unit status after reconciliation, or `null` if no write was needed. */
  unitStatus: UnitStatus | null;
  /** The lifecycle edge that was taken, if any. Audited separately. */
  transition: { from: TenancyStatus; to: TenancyStatus } | null;
}

/**
 * Creates a tenancy.
 *
 * Order of checks is deliberate: authorization, then the two organization-membership
 * checks on the unit and the tenant, then the creatable-status rule, then the overlap
 * rule. Each is cheaper and more general than the next, and the overlap query is the
 * only one that touches a table the caller might have many rows in.
 */
export async function createTenancy(
  ctx: DataContext,
  input: CreateTenancyInput,
): Promise<TenancyWriteResult> {
  const organizationId = ctx.membership.organization.id;
  assertAuthorized(ctx.membership, 'create', { type: 'tenancy', organizationId });

  const unit = await requireUnitInOrganization(ctx, input.property_unit_id);
  await requireTenantInOrganization(ctx, input.tenant_id);

  const status = input.status ?? 'draft';
  if (!CREATABLE_TENANCY_STATUSES.includes(status)) {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: `A tenancy cannot be created with status ${status}.`,
      logFields: { reason: 'tenancy_status_not_creatable', status },
    });
  }

  if (occupiesUnit(status)) {
    await assertNoOverlappingActiveTenancy(ctx, {
      propertyUnitId: input.property_unit_id,
      start: input.start_date,
      end: input.end_date,
      excludeTenancyId: null,
    });
  }

  const { data, error } = await ctx.supabase
    .from('tenancies')
    .insert({
      organization_id: organizationId,
      property_unit_id: input.property_unit_id,
      tenant_id: input.tenant_id,
      contract_number: input.contract_number ?? null,
      start_date: input.start_date,
      end_date: input.end_date,
      // The canonical decimal string from `MoneyAmountSchema`. Passing the parsed JSON
      // number instead would round-trip the amount through a float.
      rent_amount: input.rent_amount,
      currency: input.currency || DEFAULT_CURRENCY,
      status,
    })
    .select(TENANCY_SELECT)
    .single();
  throwIfPostgresError(error);

  const tenancy = serializeTenancy(data as unknown as TenancyRowLike);
  const unitStatus = await reconcileUnitOccupancy(ctx, input.property_unit_id, unit);

  return { tenancy, unitStatus, transition: null };
}

/**
 * Updates a tenancy, including its lifecycle status.
 *
 * The date rule is re-checked against the *effective* row — the incoming value where one
 * was supplied, the stored value otherwise — because `UpdateTenancySchema` can only
 * compare two dates when the body carries both. A partial patch moving `start_date` past
 * the stored `end_date` is rejected here with a 422 rather than reaching `0001`'s
 * `check (end_date >= start_date)`, which would surface as a less useful error.
 */
export async function updateTenancy(
  ctx: DataContext,
  tenancyId: string,
  input: UpdateTenancyInput,
): Promise<TenancyWriteResult> {
  const organizationId = ctx.membership.organization.id;

  const { data: current, error: currentError } = await ctx.supabase
    .from('tenancies')
    .select(TENANCY_SELECT)
    .eq('organization_id', organizationId)
    .eq('id', tenancyId)
    .maybeSingle();
  throwIfPostgresError(currentError);
  if (!current) throw notFoundTenancy();

  const currentRow = current as unknown as TenancyRowLike;
  const tenantId = asString(currentRow.tenant_id);

  assertAuthorized(ctx.membership, 'update', {
    type: 'tenancy',
    organizationId: asString(currentRow.organization_id),
    tenantId,
  });

  // Field by field, for the same reason as `updateTenant`: the writable set is this code
  // rather than whatever the body happened to contain. `rent_amount` is assigned the
  // canonical decimal string from `MoneyAmountSchema`, never a JSON number.
  const patch: TablesUpdate<'tenancies'> = {};
  if (input.contract_number !== undefined) patch.contract_number = input.contract_number ?? null;
  if (input.start_date !== undefined) patch.start_date = input.start_date;
  if (input.end_date !== undefined) patch.end_date = input.end_date;
  if (input.rent_amount !== undefined) patch.rent_amount = input.rent_amount;
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.status !== undefined) patch.status = input.status;

  if (Object.keys(patch).length === 0) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      message: 'Provide at least one updatable field.',
      logFields: { reason: 'tenancy_patch_empty' },
    });
  }

  const fromStatus = asTenancyStatus(String(currentRow.status));
  const toStatus = input.status ?? fromStatus;
  const { changed } = assertTenancyTransition(fromStatus, toStatus);

  const startDate = input.start_date ?? String(currentRow.start_date);
  const endDate = input.end_date ?? String(currentRow.end_date);
  if (endDate < startDate) {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'end_date must be on or after start_date.',
      logFields: { reason: 'tenancy_dates_out_of_order' },
    });
  }

  const unitId = asString(currentRow.property_unit_id);
  if (!unitId) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'tenancy_unit_missing', entity_id: tenancyId },
    });
  }

  // Overlap is re-checked whenever the result would be an active tenancy — a status
  // change into `active`, and equally a date change on one that is already active.
  if (occupiesUnit(toStatus)) {
    await assertNoOverlappingActiveTenancy(ctx, {
      propertyUnitId: unitId,
      start: startDate,
      end: endDate,
      excludeTenancyId: tenancyId,
    });
  }

  const { data, error } = await ctx.supabase
    .from('tenancies')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', tenancyId)
    .select(TENANCY_SELECT)
    .maybeSingle();
  throwIfPostgresError(error);
  if (!data) throw notFoundTenancy();

  const tenancy = serializeTenancy(data as unknown as TenancyRowLike);
  const unitStatus = changed ? await reconcileUnitOccupancy(ctx, unitId, null) : null;

  if (changed) {
    // A second audit row, in addition to the wrapper's `tenancy_updated`. The wrapper's
    // action is fixed per route, and a lifecycle transition needs its own entry carrying
    // `from_status`/`to_status` — "draft → active → expired/terminated, each audited".
    await writeAuditLog(
      ctx.supabase,
      {
        action: 'tenancy_status_changed',
        entityType: 'tenancy',
        entityId: tenancy.id,
        organizationId,
        metadata: {
          from_status: fromStatus,
          to_status: toStatus,
          unit_id: unitId,
          tenant_id: tenantId,
        },
      },
      ctx.logger,
    );
  }

  return {
    tenancy,
    unitStatus,
    transition: changed ? { from: fromStatus, to: toStatus } : null,
  };
}

/* --------------------------------------------------------------- invariants -- */

/**
 * Refuses a candidate tenancy that would overlap an existing ACTIVE one on the same unit.
 *
 * The date predicate is applied in TypeScript rather than pushed into the query. The
 * active tenancies on one unit are at most a handful — if the invariant holds, exactly
 * one — so the round trip is the cost either way, and running the check through the
 * exhaustively unit-tested `findOverlappingTenancy` means the rule that ships is the rule
 * that is tested, instead of a `lte`/`gte` pair that merely resembles it.
 */
async function assertNoOverlappingActiveTenancy(
  ctx: DataContext,
  candidate: {
    propertyUnitId: string;
    start: string;
    end: string;
    excludeTenancyId: string | null;
  },
): Promise<void> {
  const { data, error } = await ctx.supabase
    .from('tenancies')
    .select('id, property_unit_id, start_date, end_date')
    .eq('organization_id', ctx.membership.organization.id)
    .eq('property_unit_id', candidate.propertyUnitId)
    .eq('status', 'active')
    .limit(OVERLAP_SCAN_LIMIT);
  throwIfPostgresError(error);

  const existing: TenancyInterval[] = (data ?? []).map((row) => ({
    id: row.id,
    propertyUnitId: row.property_unit_id,
    start: row.start_date,
    end: row.end_date,
  }));

  const clash = findOverlappingTenancy(
    { propertyUnitId: candidate.propertyUnitId, start: candidate.start, end: candidate.end },
    existing,
    candidate.excludeTenancyId,
  );

  if (clash) {
    throw new ApiRouteError('CONFLICT', {
      message: 'That unit already has an active tenancy over part of this period.',
      logFields: {
        reason: 'tenancy_overlaps_active',
        unit_id: candidate.propertyUnitId,
        entity_type: 'tenancy',
        entity_id: clash.id,
      },
    });
  }
}

/**
 * Brings `property_units.status` back in line with whether the unit has an active
 * tenancy.
 *
 * **It never fails the request.** The write it follows has already committed, and there
 * is no transaction spanning the two: returning 500 would tell the client to retry a
 * tenancy write that succeeded, creating a duplicate lease in the name of a
 * denormalized status column. So a failure is logged at `error` level with the request's
 * correlation id and the response stands — the same reasoning, and the same trade-off,
 * as `lib/audit/write.ts` applies to a failed audit insert. `tenancies` is the source of
 * truth; this column is a cache of it.
 */
async function reconcileUnitOccupancy(
  ctx: DataContext,
  unitId: string,
  known: UnitRowLike | null,
): Promise<UnitStatus | null> {
  try {
    const unit = known ?? (await loadUnit(ctx, unitId));
    if (!unit) return null;

    const currentStatus = asUnitStatus(String(unit.status));
    if (!currentStatus) return null;

    const { data: active, error: activeError } = await ctx.supabase
      .from('tenancies')
      .select('id')
      .eq('organization_id', ctx.membership.organization.id)
      .eq('property_unit_id', unitId)
      .eq('status', 'active')
      .limit(1);
    throwIfPostgresError(activeError);

    const next = reconciledUnitStatus(currentStatus, (active ?? []).length > 0);
    if (!next) return null;

    const { error: updateError } = await ctx.supabase
      .from('property_units')
      .update({ status: next })
      .eq('organization_id', ctx.membership.organization.id)
      .eq('id', unitId);
    throwIfPostgresError(updateError);

    ctx.logger.info('unit occupancy reconciled', {
      unit_id: unitId,
      from_status: currentStatus,
      to_status: next,
      outcome: 'updated',
    });
    return next;
  } catch (thrown) {
    ctx.logger.error('unit occupancy reconciliation failed', {
      reason: 'unit_status_sync_failed',
      unit_id: unitId,
      pg_code: readPgCode(thrown),
      outcome: 'error',
    });
    return null;
  }
}

/* ----------------------------------------------------------------- lookups -- */

/**
 * The unit, or a 422.
 *
 * 422 rather than 404 because the identifier arrived in a request body as a reference,
 * not in the path as the thing being addressed: the request is well-formed and
 * semantically wrong, which is what `docs/api-contracts.md` reserves 422 for. It is also
 * the check that turns a cross-organization unit id into a clear answer instead of the
 * composite foreign key's `23503`.
 */
async function requireUnitInOrganization(ctx: DataContext, unitId: string): Promise<UnitRowLike> {
  const unit = await loadUnit(ctx, unitId);
  if (!unit) {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'That unit was not found in this organization.',
      logFields: { reason: 'tenancy_unit_not_in_organization', unit_id: unitId },
    });
  }
  return unit;
}

async function requireTenantInOrganization(ctx: DataContext, tenantId: string): Promise<void> {
  const { data, error } = await ctx.supabase
    .from('tenants')
    .select('id')
    .eq('organization_id', ctx.membership.organization.id)
    .eq('id', tenantId)
    .maybeSingle();
  throwIfPostgresError(error);

  if (!data) {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'That tenant was not found in this organization.',
      logFields: { reason: 'tenancy_tenant_not_in_organization', tenant_id: tenantId },
    });
  }
}

async function loadUnit(ctx: DataContext, unitId: string): Promise<UnitRowLike | null> {
  const { data, error } = await ctx.supabase
    .from('property_units')
    .select(UNIT_SELECT)
    .eq('organization_id', ctx.membership.organization.id)
    .eq('id', unitId)
    .maybeSingle();
  throwIfPostgresError(error);
  return (data as unknown as UnitRowLike) ?? null;
}

/** `properties.owner_member_id` for a unit, for the property-owner rules in the matrix. */
async function loadUnitOwnerMember(ctx: DataContext, unit: UnitRowLike): Promise<string | null> {
  const propertyId = asString(unit.property_id);
  if (!propertyId) return null;

  const { data, error } = await ctx.supabase
    .from('properties')
    .select('id, owner_member_id')
    .eq('organization_id', ctx.membership.organization.id)
    .eq('id', propertyId)
    .maybeSingle();
  throwIfPostgresError(error);

  return data?.owner_member_id ?? null;
}

/* ----------------------------------------------------------------- helpers -- */

function notFoundTenancy(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', {
    message: 'That tenancy was not found.',
    logFields: { reason: 'tenancy_not_visible', entity_type: 'tenancy' },
  });
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

function readPgCode(thrown: unknown): string {
  if (thrown && typeof thrown === 'object') {
    const candidate = (thrown as { logFields?: { pg_code?: unknown } }).logFields;
    if (candidate && typeof candidate.pg_code === 'string') return candidate.pg_code;
  }
  return 'unknown';
}
