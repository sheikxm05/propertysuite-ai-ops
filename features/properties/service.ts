/**
 * The properties and units data layer.
 *
 * Every function takes the **caller-scoped** Supabase client, so Row Level Security is in
 * force on every statement, and every function independently applies the application-space
 * matrix through `features/properties/authorization.ts`. That is the whole point: each
 * layer is written on the assumption that the other one has a bug.
 *
 * Four invariants hold in every function below.
 *
 *  1. **`organization_id` comes from `membership`, never from a request.** It is applied as
 *     a filter on every read and as a value on every insert (CLAUDE.md rule 5).
 *  2. **Every row that leaves here has been through `authorize()`**, with its own
 *     `organization_id` as read from the row — not the one we filtered by. A row from
 *     another organization that somehow came back is dropped, not returned.
 *  3. **There is no DELETE.** `authenticated` holds the DELETE privilege on no table in
 *     this database, so a delete would fail at the privilege level and not merely at the
 *     policy level. Removal is `properties.status = 'archived'` and
 *     `property_units.status = 'inactive'`.
 *  4. **A unit belongs to the property it claims.** Every unit statement filters on
 *     `property_id` *and* re-checks `row.property_id` in TypeScript. The one blocking
 *     defect found in Wave 0 was a unit/property pair that was never cross-checked, and
 *     `0002`'s `unit_belongs_to_property()` helper exists because of it.
 *
 * Rows are returned as the generated `PropertyRow` / `PropertyUnitRow` types from
 * `packages/shared`, with the columns named explicitly in the two `*_COLUMNS` constants
 * below, so adding a column to the table is a visible change here rather than a silent
 * widening of every API response. The frozen `PropertySchema` and `UnitSchema` are the
 * narrower *client-side* contract; database rows are not re-parsed on the way out, since
 * a response that 500s because `property_type` holds a value the enum does not know would
 * turn a data-quality problem into an outage.
 */

import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import type {
  CreatePropertyInput,
  CreateUnitInput,
  ListPropertiesQuery,
  ListUnitsQuery,
  PropertyRow,
  PropertyUnitRow,
  TablesUpdate,
  UpdatePropertyInput,
  UpdateUnitInput,
} from '@shared/index';

import {
  assertOwnerAssociable,
  assertVisible,
  assertWritable,
  isVisible,
  propertyRef,
  scopedPropertyIds,
  scopedUnitIds,
  unitRef,
  type OwnerCandidate,
  type VisibilityScope,
} from './authorization';
import { decodeCursor, keysetFilter, overFetchLimit, toPage, type Page } from './cursor';
import { sanitizeSearchTerm, searchFilter } from './filters';
import { resolveVisibilityScope } from './scope';
import { assertUnitTransition } from './unit-status';

/** `properties` columns exposed by the API, in the order the frozen `PropertySchema` lists them. */
const PROPERTY_COLUMNS =
  'id, organization_id, name, property_type, address_line, city, emirate, owner_member_id, status, created_at, updated_at' as const;

/** `property_units` columns exposed by the API, matching the frozen `UnitSchema`. */
const UNIT_COLUMNS =
  'id, organization_id, property_id, unit_number, bedrooms, bathrooms, area_sqft, status, created_at' as const;

/** `properties.status`. Archiving is the only removal path. */
const PROPERTY_ARCHIVED_STATUS = 'archived';
const PROPERTY_ACTIVE_STATUS = 'active';

/* ------------------------------------------------------------- properties -- */

/**
 * `GET /api/v1/properties?cursor=&limit=&status=&q=`
 *
 * Ordered newest-first on `(created_at, id)`; see `cursor.ts` for why that pair and not
 * `name`. The role scope narrows the query *before* it is sent — an owner's statement
 * carries `owner_member_id = <their membership>`, a tenant's carries an explicit `in.(…)`
 * of the units they lease — and then every returned row is put through `authorize()`
 * anyway. The pre-filter is a correctness and cost measure; the post-filter is the
 * security measure.
 */
export async function listProperties(
  client: AppSupabaseClient,
  membership: Membership,
  query: ListPropertiesQuery,
): Promise<Page<PropertyRow>> {
  const scope = await resolveVisibilityScope(client, membership);
  const limit = query.limit;

  if (scope.kind === 'none') return emptyPage(limit);

  const restrictedIds = scopedPropertyIds(scope);
  // An empty reachable set is answered without a query. `in.()` would also match nothing,
  // but not issuing the statement makes the "sees nothing" path unambiguous.
  if (restrictedIds && restrictedIds.length === 0) return emptyPage(limit);

  // Filters first, then ordering and the limit. `.order()` returns a transform builder in
  // @supabase/postgrest-js v2 and a transform builder has no filter methods, so the order
  // of these two groups is a compile-time constraint, not a style choice.
  let filtered = client
    .from('properties')
    .select(PROPERTY_COLUMNS)
    .eq('organization_id', membership.organization.id);

  if (scope.kind === 'owned') {
    filtered = filtered.eq('owner_member_id', scope.ownerMemberId);
  }
  if (restrictedIds) {
    filtered = filtered.in('id', [...restrictedIds]);
  }
  if (query.status) {
    filtered = filtered.eq('status', query.status);
  }

  const term = sanitizeSearchTerm(query.q);
  if (term) filtered = filtered.or(searchFilter(term));

  if (query.cursor) filtered = filtered.or(keysetFilter(decodeCursor(query.cursor), 'desc'));

  const { data, error } = await filtered
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(overFetchLimit(limit));
  throwIfPostgresError(error);

  const visible = (data ?? []).filter((row) =>
    isVisible(membership, propertyRef(row, membership, scope)),
  );
  return toPage(visible, limit);
}

/**
 * `GET /api/v1/properties/{propertyId}`
 *
 * Raises `NOT_FOUND` for a property that does not exist, that belongs to another
 * organization, or that this caller has no path to — all three answer identically,
 * because distinguishing them tells the caller which rows exist.
 */
export async function getProperty(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
  scope?: VisibilityScope,
): Promise<PropertyRow> {
  const resolved = scope ?? (await resolveVisibilityScope(client, membership));

  const { data, error } = await client
    .from('properties')
    .select(PROPERTY_COLUMNS)
    .eq('organization_id', membership.organization.id)
    .eq('id', propertyId)
    .maybeSingle();
  throwIfPostgresError(error);

  if (!data) throw propertyNotFound('property_row_absent');

  assertVisible(membership, propertyRef(data, membership, resolved));
  return data;
}

/**
 * `POST /api/v1/properties`
 *
 * `organization_id` is the membership's. `owner_member_id`, when supplied, is validated
 * against the caller's own organization *before* the insert — `0002`'s composite foreign
 * key would reject a foreign membership anyway (surfacing as `23503` → 422), but a
 * deliberate 422 with a stable reason in the log is a better answer than a translated
 * constraint violation, and the role restriction in `OWNER_ASSOCIABLE_ROLES` is something
 * the foreign key cannot express at all.
 */
export async function createProperty(
  client: AppSupabaseClient,
  membership: Membership,
  input: CreatePropertyInput,
): Promise<PropertyRow> {
  assertWritable(membership, 'create', {
    type: 'property',
    organizationId: membership.organization.id,
  });

  if (input.owner_member_id) {
    assertOwnerAssociable(
      membership,
      await fetchOwnerCandidate(client, membership, input.owner_member_id),
    );
  }

  const { data, error } = await client
    .from('properties')
    .insert({
      organization_id: membership.organization.id,
      name: input.name,
      property_type: input.property_type,
      address_line: input.address_line,
      city: input.city,
      emirate: input.emirate,
      owner_member_id: input.owner_member_id ?? null,
      status: PROPERTY_ACTIVE_STATUS,
    })
    .select(PROPERTY_COLUMNS)
    .single();
  throwIfPostgresError(error);

  if (!data)
    throw new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'insert_returned_no_row' } });
  return data;
}

/**
 * `PATCH /api/v1/properties/{propertyId}`
 *
 * The authorized action depends on the body: a patch that sets `status: 'archived'` is an
 * `archive`, anything else is an `update`. `lib/auth/authorize.ts` distinguishes the two,
 * and `staffWrite(true)` grants both to staff only — so a property owner editing the
 * property they own gets a 403 here, which is this lane's "owner is read-only" gate.
 *
 * An already-archived property accepts only a status change. Editing the name of an
 * archived row silently is how an archive turns into a soft-delete that still drifts.
 */
export async function updateProperty(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
  input: UpdatePropertyInput,
): Promise<PropertyRow> {
  const scope = await resolveVisibilityScope(client, membership);
  const existing = await getProperty(client, membership, propertyId, scope);

  const action = input.status === PROPERTY_ARCHIVED_STATUS ? 'archive' : 'update';
  assertWritable(membership, action, propertyRef(existing, membership, scope));

  if (existing.status === PROPERTY_ARCHIVED_STATUS && input.status === undefined) {
    throw new ApiRouteError('CONFLICT', {
      message: 'An archived property must be reactivated before it can be edited.',
      logFields: { reason: 'property_archived' },
    });
  }

  if (input.owner_member_id) {
    assertOwnerAssociable(
      membership,
      await fetchOwnerCandidate(client, membership, input.owner_member_id),
    );
  }

  // Built key by key from the validated body. Spreading the body would let a future
  // schema change introduce a column this function never agreed to write.
  const patch: TablesUpdate<'properties'> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.property_type !== undefined) patch.property_type = input.property_type;
  if (input.address_line !== undefined) patch.address_line = input.address_line;
  if (input.city !== undefined) patch.city = input.city;
  if (input.emirate !== undefined) patch.emirate = input.emirate;
  if (input.owner_member_id !== undefined) patch.owner_member_id = input.owner_member_id;
  if (input.status !== undefined) patch.status = input.status;

  return writeProperty(client, membership, propertyId, patch);
}

/**
 * `POST /api/v1/properties/{propertyId}/archive`
 *
 * The explicit archive path. It exists because "there is no delete" is easier to verify
 * on the route surface than inside a conditional in a `PATCH` handler, and because the
 * action deserves its own audit verb. It is idempotent: archiving an archived property
 * returns it unchanged rather than conflicting.
 */
export async function archiveProperty(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
): Promise<PropertyRow> {
  const scope = await resolveVisibilityScope(client, membership);
  const existing = await getProperty(client, membership, propertyId, scope);

  assertWritable(membership, 'archive', propertyRef(existing, membership, scope));

  if (existing.status === PROPERTY_ARCHIVED_STATUS) return existing;
  return writeProperty(client, membership, propertyId, { status: PROPERTY_ARCHIVED_STATUS });
}

/**
 * The single `UPDATE` statement for `properties`.
 *
 * `organization_id` is in the `WHERE` clause as well as having been checked by
 * `getProperty`, so the statement cannot touch another organization's row even if the
 * caller's membership were somehow wrong. `0002`'s `properties_update_staff` policy pins
 * the organization in both `using` and `with check` for the same reason.
 */
async function writeProperty(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
  patch: TablesUpdate<'properties'>,
): Promise<PropertyRow> {
  const { data, error } = await client
    .from('properties')
    .update(patch)
    .eq('organization_id', membership.organization.id)
    .eq('id', propertyId)
    .select(PROPERTY_COLUMNS)
    .single();
  throwIfPostgresError(error);

  if (!data) throw propertyNotFound('update_returned_no_row');
  return data;
}

/* ------------------------------------------------------------------ units -- */

/**
 * `GET /api/v1/properties/{propertyId}/units?cursor=&limit=&status=`
 *
 * The parent property is read and authorized first, which is what makes a unit list on an
 * unreachable property a 404 rather than an empty page. Ordered oldest-first on
 * `(created_at, id)` — creation order, per `cursor.ts`.
 */
export async function listUnits(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
  query: ListUnitsQuery,
): Promise<Page<PropertyUnitRow>> {
  const scope = await resolveVisibilityScope(client, membership);
  const property = await getProperty(client, membership, propertyId, scope);
  const limit = query.limit;

  const restrictedIds = scopedUnitIds(scope);
  if (restrictedIds && restrictedIds.length === 0) return emptyPage(limit);

  let filtered = client
    .from('property_units')
    .select(UNIT_COLUMNS)
    .eq('organization_id', membership.organization.id)
    .eq('property_id', propertyId);

  if (restrictedIds) filtered = filtered.in('id', [...restrictedIds]);
  if (query.status) filtered = filtered.eq('status', query.status);
  if (query.cursor) filtered = filtered.or(keysetFilter(decodeCursor(query.cursor), 'asc'));

  const { data, error } = await filtered
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(overFetchLimit(limit));
  throwIfPostgresError(error);

  const visible = (data ?? [])
    // Invariant 4. The statement already filtered on `property_id`; this asserts it.
    .filter((row) => row.property_id === propertyId)
    .filter((row) =>
      isVisible(membership, unitRef(row, property.owner_member_id, membership, scope)),
    );

  return toPage(visible, limit);
}

/**
 * `GET /api/v1/properties/{propertyId}/units/{unitId}`
 *
 * A unit id that exists but belongs to a different property is a `NOT_FOUND`, not a
 * success — the pair in the URL has to be true. This is the check whose absence was the
 * only blocking defect in Wave 0.
 */
export async function getUnit(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
  unitId: string,
  context?: { scope: VisibilityScope; property: PropertyRow },
): Promise<PropertyUnitRow> {
  const scope = context?.scope ?? (await resolveVisibilityScope(client, membership));
  const property = context?.property ?? (await getProperty(client, membership, propertyId, scope));

  const { data, error } = await client
    .from('property_units')
    .select(UNIT_COLUMNS)
    .eq('organization_id', membership.organization.id)
    .eq('property_id', propertyId)
    .eq('id', unitId)
    .maybeSingle();
  throwIfPostgresError(error);

  if (!data) throw unitNotFound('unit_row_absent');
  if (data.property_id !== propertyId) throw unitNotFound('unit_property_mismatch');

  assertVisible(membership, unitRef(data, property.owner_member_id, membership, scope));
  return data;
}

/**
 * `POST /api/v1/properties/{propertyId}/units`
 *
 * `property_id` is taken from the path and is deliberately absent from `CreateUnitSchema`,
 * so there is no body that can disagree with the URL. A duplicate `unit_number` inside the
 * same property violates `unique (property_id, unit_number)` from `0001` and surfaces as
 * `23505` → `CONFLICT` 409 through the wrapper's SQLSTATE mapping.
 */
export async function createUnit(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
  input: CreateUnitInput,
): Promise<PropertyUnitRow> {
  const scope = await resolveVisibilityScope(client, membership);
  const property = await getProperty(client, membership, propertyId, scope);

  // A create has no row yet, so the ref is built from the parent property rather than
  // through `unitRef`: the organization is the parent's and so is the owner association.
  assertWritable(membership, 'create', {
    type: 'property_unit',
    organizationId: property.organization_id,
    ownerMemberId: property.owner_member_id,
  });

  if (property.status === PROPERTY_ARCHIVED_STATUS) {
    throw new ApiRouteError('CONFLICT', {
      message: 'A unit cannot be added to an archived property.',
      logFields: { reason: 'property_archived' },
    });
  }

  const { data, error } = await client
    .from('property_units')
    .insert({
      organization_id: membership.organization.id,
      property_id: propertyId,
      unit_number: input.unit_number,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      area_sqft: input.area_sqft ?? null,
      ...(input.status === undefined ? {} : { status: input.status }),
    })
    .select(UNIT_COLUMNS)
    .single();
  throwIfPostgresError(error);

  if (!data)
    throw new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'insert_returned_no_row' } });
  return data;
}

/**
 * `PATCH /api/v1/properties/{propertyId}/units/{unitId}`
 *
 * Carries the unit status machine: `assertUnitTransition` rejects an illegal edge with a
 * 409 before the statement is sent. Who may drive it is still `authorize()` — an illegal
 * edge is a 409, a legal edge attempted by the wrong role is a 403, matching
 * `docs/implementation-plan.md` §4's rule for the ticket machine.
 */
export async function updateUnit(
  client: AppSupabaseClient,
  membership: Membership,
  propertyId: string,
  unitId: string,
  input: UpdateUnitInput,
): Promise<UnitUpdateResult> {
  const scope = await resolveVisibilityScope(client, membership);
  const property = await getProperty(client, membership, propertyId, scope);
  const existing = await getUnit(client, membership, propertyId, unitId, { scope, property });

  const action = input.status === 'inactive' ? 'archive' : 'update';
  assertWritable(
    membership,
    action,
    unitRef(existing, property.owner_member_id, membership, scope),
  );

  if (input.status !== undefined) assertUnitTransition(existing.status, input.status);

  const patch: TablesUpdate<'property_units'> = {};
  if (input.unit_number !== undefined) patch.unit_number = input.unit_number;
  if (input.bedrooms !== undefined) patch.bedrooms = input.bedrooms;
  if (input.bathrooms !== undefined) patch.bathrooms = input.bathrooms;
  if (input.area_sqft !== undefined) patch.area_sqft = input.area_sqft;
  if (input.status !== undefined) patch.status = input.status;

  const { data, error } = await client
    .from('property_units')
    .update(patch)
    .eq('organization_id', membership.organization.id)
    .eq('property_id', propertyId)
    .eq('id', unitId)
    .select(UNIT_COLUMNS)
    .single();
  throwIfPostgresError(error);

  if (!data) throw unitNotFound('update_returned_no_row');
  return { unit: data, previousStatus: existing.status };
}

/**
 * The result of a unit update.
 *
 * `previousStatus` is returned so the route can write `from_status` / `to_status` into the
 * audit row. Both names are on the logger's allowlist, and a status transition whose
 * origin is not recorded is an audit row that cannot answer "what changed".
 */
export interface UnitUpdateResult {
  unit: PropertyUnitRow;
  previousStatus: string;
}

/* -------------------------------------------------------------- portfolio -- */

/** What the dashboard widget shows. Every number is scoped to the caller's visible set. */
export interface PortfolioCounts {
  properties: number;
  archivedProperties: number;
  units: number;
  occupiedUnits: number;
  availableUnits: number;
}

/**
 * Aggregate counts for `features/properties/widget.tsx`.
 *
 * These are `count: 'exact', head: true` queries, which RLS filters exactly as it filters
 * a `SELECT`, so each number is a count of rows *this caller may read*. That is not the
 * total-count the pagination rule forbids: §5.7 bans an offset/total over a paged list
 * because `?offset=50` returning nothing reveals how many rows exist for someone else.
 * A caller counting their own visible set reveals nothing they could not get by reading it.
 */
export async function portfolioCounts(
  client: AppSupabaseClient,
  membership: Membership,
): Promise<PortfolioCounts> {
  const scope = await resolveVisibilityScope(client, membership);
  const empty: PortfolioCounts = {
    properties: 0,
    archivedProperties: 0,
    units: 0,
    occupiedUnits: 0,
    availableUnits: 0,
  };
  if (scope.kind === 'none') return empty;

  const propertyIds = scopedPropertyIds(scope);
  const unitIds = scopedUnitIds(scope);
  if ((propertyIds && propertyIds.length === 0) || (unitIds && unitIds.length === 0)) return empty;

  const countProperties = async (status: string): Promise<number> => {
    let statement = client
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', membership.organization.id)
      .eq('status', status);
    if (scope.kind === 'owned') statement = statement.eq('owner_member_id', scope.ownerMemberId);
    if (propertyIds) statement = statement.in('id', propertyIds);

    const { count, error } = await statement;
    throwIfPostgresError(error);
    return count ?? 0;
  };

  const countUnits = async (status?: string): Promise<number> => {
    let statement = client
      .from('property_units')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', membership.organization.id);
    if (status) statement = statement.eq('status', status);
    if (unitIds) statement = statement.in('id', unitIds);

    const { count, error } = await statement;
    throwIfPostgresError(error);
    return count ?? 0;
  };

  const [properties, archivedProperties, units, occupiedUnits, availableUnits] = await Promise.all([
    countProperties(PROPERTY_ACTIVE_STATUS),
    countProperties(PROPERTY_ARCHIVED_STATUS),
    countUnits(),
    countUnits('occupied'),
    countUnits('available'),
  ]);

  return { properties, archivedProperties, units, occupiedUnits, availableUnits };
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Reads a candidate `owner_member_id` from the caller's own organization.
 *
 * `organization_members` is readable by every role in the matrix (admin RW, everyone else
 * R, a tenant and a provider only their own row), so a non-staff caller simply finds no
 * candidate — and never reaches here anyway, because `assertWritable` has already refused.
 */
async function fetchOwnerCandidate(
  client: AppSupabaseClient,
  membership: Membership,
  memberId: string,
): Promise<OwnerCandidate | null> {
  const { data, error } = await client
    .from('organization_members')
    .select('id, organization_id, role, status')
    .eq('organization_id', membership.organization.id)
    .eq('id', memberId)
    .maybeSingle();
  throwIfPostgresError(error);
  return data ?? null;
}

/** A page with no rows, for the roles whose reachable set is empty. */
function emptyPage<T>(limit: number): Page<T> {
  return { rows: [], nextCursor: null, hasMore: false, limit };
}

/** 404, with the real reason in the log and nothing but "not found" on the wire. */
function propertyNotFound(reason: string): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', { logFields: { reason, resource_type: 'property' } });
}

function unitNotFound(reason: string): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', { logFields: { reason, resource_type: 'property_unit' } });
}
