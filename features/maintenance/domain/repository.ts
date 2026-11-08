/**
 * Every database statement this lane issues, in one file.
 *
 * The split between this module and `service.ts` is deliberate: the repository knows
 * SQL shapes and nothing about authorization, the service knows authorization and
 * nothing about PostgREST. That boundary is what makes the security-relevant decisions
 * — role scoping, transition legality, field allowlists — pure functions that can be
 * proven exhaustively without a database, while leaving the query construction thin
 * enough to read in one sitting.
 *
 * Rules that hold for every function below:
 *
 *  - The client is ALWAYS the caller-scoped `AppSupabaseClient`. Row-level security is
 *    in force on every statement. The service-role client appears nowhere in this lane:
 *    there is no maintenance operation that legitimately needs to bypass RLS, and using
 *    it to set up a row would make the second enforcement layer decorative.
 *  - `organization_id` is always pinned explicitly, even though RLS would pin it too.
 *    It comes from `membership.organization.id` — a trusted row — never from a request.
 *  - Columns are listed, never `*`. The §4 matrix grants a `service_provider` a
 *    tenant's *name only*, and a wildcard select would hand them the email and phone
 *    while every RLS test still passed.
 *  - There is no delete. A ticket is cancelled (CLAUDE.md rule 6), and
 *    `maintenance_activities` rejects UPDATE, DELETE and TRUNCATE outright.
 *  - Errors are translated by `throwIfPostgresError`, which applies the frozen
 *    SQLSTATE mapping from amendment A2: `P0001` (an illegal edge) becomes 409 and
 *    `42501` (a wrong-role edge, or an RLS write denial) becomes 403. The domain layer
 *    refuses those cases first; this is the net under it.
 */

import type { TicketPriority, TicketStatus } from '@shared/index';

import { throwIfPostgresError } from '@/lib/api/errors';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import type { PlannedActivity } from './activities';
import { decodeTicketCursor } from './cursor';
import type { TicketQueryScope } from './scope';

/* ------------------------------------------------------------- projections -- */

/** Every ticket column the API exposes. Matches `TicketSchema` in `packages/shared`. */
const TICKET_COLUMNS =
  'id,organization_id,property_id,property_unit_id,tenancy_id,tenant_id,assigned_provider_id,title,description,category,priority,status,source,created_at,updated_at';

/** Matches `ActivitySchema`. */
const ACTIVITY_COLUMNS =
  'id,organization_id,ticket_id,actor_profile_id,activity_type,description,metadata,created_at';

export interface TicketRow {
  id: string;
  organization_id: string;
  property_id: string;
  property_unit_id: string;
  tenancy_id: string | null;
  tenant_id: string;
  assigned_provider_id: string | null;
  title: string;
  description: string;
  category: string;
  priority: TicketPriority;
  status: TicketStatus;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: string;
  organization_id: string;
  ticket_id: string;
  actor_profile_id: string | null;
  activity_type: string;
  description: string;
  metadata: unknown;
  created_at: string;
}

export interface UnitRow {
  id: string;
  property_id: string;
  unit_number: string;
  status: string;
}

export interface PropertyRow {
  id: string;
  name: string;
  owner_member_id: string | null;
}

export interface TenancyRow {
  id: string;
  tenant_id: string;
  status: string;
}

export interface ProviderRow {
  id: string;
  organization_id: string;
  company_name: string;
  status: string;
}

export interface TenantNameRow {
  id: string;
  full_name: string;
}

export interface TicketPage {
  items: TicketRow[];
  hasMore: boolean;
}

export interface ActivityPage {
  items: ActivityRow[];
  hasMore: boolean;
}

/* ------------------------------------------------------------------ tickets -- */

/**
 * One ticket, or `null`.
 *
 * `maybeSingle()` rather than `single()`: an inaccessible ticket must look exactly like
 * an absent one. `single()` raises `PGRST116`, which the error mapper turns into a 404
 * anyway, but routing an expected outcome through the exception path means a genuine
 * 404 and a denied read produce different log lines. The service turns `null` into the
 * 404, and it is the same 404 either way.
 */
export async function findTicket(
  client: AppSupabaseClient,
  organizationId: string,
  ticketId: string,
): Promise<TicketRow | null> {
  const { data, error } = await client
    .from('maintenance_tickets')
    .select(TICKET_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('id', ticketId)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as TicketRow | null) ?? null;
}

/**
 * One page of tickets, newest first.
 *
 * Ordered by `(created_at desc, id desc)`, which is total because `id` is unique, and
 * paged by the matching keyset predicate. `limit + 1` rows are requested so `hasMore`
 * is a fact from the database rather than an inference from a full page.
 *
 * The scope object is applied as given. It is built by `ticketListScope()` from trusted
 * membership, so every key reaching `.eq()` originates in this lane's own code; nothing
 * here iterates over request data.
 */
export async function listTickets(
  client: AppSupabaseClient,
  scope: TicketQueryScope,
  options: { cursor?: string | undefined; limit: number },
): Promise<TicketPage> {
  if (scope.impossible) return { items: [], hasMore: false };

  let query = client.from('maintenance_tickets').select(TICKET_COLUMNS);

  for (const [column, value] of Object.entries(scope.equals)) {
    query = query.eq(column, value);
  }
  if (scope.statusIn !== null) {
    query = query.in('status', [...scope.statusIn]);
  }
  if (options.cursor !== undefined) {
    const { createdAt, id } = decodeTicketCursor(options.cursor);
    query = query.or(
      `created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt."${id}")`,
    );
  }

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(options.limit + 1);

  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as TicketRow[];
  const hasMore = rows.length > options.limit;
  return { items: hasMore ? rows.slice(0, options.limit) : rows, hasMore };
}

/**
 * Inserts a ticket.
 *
 * `status` is not a parameter. A ticket is always created `open` — the state machine's
 * entry point, enforced again by `enforce_ticket_initial_status()` in `0003` and by the
 * `status = 'open'` clause in `maintenance_tickets_insert_tenant`. Same for
 * `assigned_provider_id`: a ticket cannot be born assigned, so there is no way to
 * express it here.
 *
 * `property_id` is passed, never trusted: the service derives it from the unit row, so
 * the `(property_id, property_unit_id)` pair is consistent by construction. An
 * inconsistent pair is rejected by `unit_belongs_to_property()` inside the tenant INSERT
 * policy, which is the live defect that made this helper necessary.
 */
export async function insertTicket(
  client: AppSupabaseClient,
  values: {
    organizationId: string;
    propertyId: string;
    propertyUnitId: string;
    tenancyId: string | null;
    tenantId: string;
    title: string;
    description: string;
    category: string;
    priority: TicketPriority;
    source: string;
  },
): Promise<TicketRow> {
  const { data, error } = await client
    .from('maintenance_tickets')
    .insert({
      organization_id: values.organizationId,
      property_id: values.propertyId,
      property_unit_id: values.propertyUnitId,
      tenancy_id: values.tenancyId,
      tenant_id: values.tenantId,
      title: values.title,
      description: values.description,
      category: values.category,
      priority: values.priority,
      status: 'open',
      source: values.source,
      assigned_provider_id: null,
    })
    .select(TICKET_COLUMNS)
    .single();

  throwIfPostgresError(error);
  return data as unknown as TicketRow;
}

/** The columns an UPDATE may carry. No `organization_id`: a ticket never moves. */
export interface TicketPatch {
  title?: string;
  description?: string;
  category?: string;
  priority?: TicketPriority;
  status?: TicketStatus;
  assigned_provider_id?: string | null;
}

/**
 * Updates a ticket, returning the stored row.
 *
 * The `eq('status', expectedStatus)` guard is optimistic concurrency, not decoration.
 * The domain layer reads the ticket, decides the transition is legal, then writes — and
 * between those two statements a concurrent request may have moved it. Without the
 * guard, two managers clicking "assign" both succeed and the second silently overwrites
 * the first's provider. With it, the second update matches no row, the service raises a
 * 409, and the timeline keeps exactly one activity row per transition.
 *
 * `organization_id` is absent from `TicketPatch` by type, so the immutability that
 * `enforce_ticket_transition()` enforces with `ticket_organization_immutable` cannot
 * even be attempted from here.
 */
export async function updateTicket(
  client: AppSupabaseClient,
  organizationId: string,
  ticketId: string,
  expectedStatus: TicketStatus,
  patch: TicketPatch,
): Promise<TicketRow | null> {
  const { data, error } = await client
    .from('maintenance_tickets')
    .update(patch)
    .eq('organization_id', organizationId)
    .eq('id', ticketId)
    .eq('status', expectedStatus)
    .select(TICKET_COLUMNS)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as TicketRow | null) ?? null;
}

/**
 * Other open tickets on the same unit in the same category.
 *
 * Feeds `resolvePriority()`'s `recurringOpenTickets` — a trusted escalation signal, so
 * it must come from rows rather than from a claim in a request body. `head: true` asks
 * PostgREST for the count without the rows.
 *
 * Counted through the caller's client, so it counts only tickets the caller can see.
 * For a tenant on their own unit that is their own tickets, which is the intended
 * signal; the alternative — counting with a privileged client — would leak the existence
 * of another tenant's tickets through the resulting priority.
 */
export async function countRecurringOpenTickets(
  client: AppSupabaseClient,
  organizationId: string,
  propertyUnitId: string,
  category: string,
  excludeTicketId?: string,
): Promise<number> {
  let query = client
    .from('maintenance_tickets')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('property_unit_id', propertyUnitId)
    .eq('category', category)
    .in('status', ['open', 'assigned', 'in_progress', 'awaiting_approval']);

  if (excludeTicketId !== undefined) query = query.neq('id', excludeTicketId);

  const { count, error } = await query;
  throwIfPostgresError(error);
  return count ?? 0;
}

/* ------------------------------------------------------------------- units -- */

/**
 * The unit a ticket is being raised against, or `null` when the caller cannot see it.
 *
 * This read is the first of the two layers behind "a tenant may only report on a unit
 * they are authorized for": `property_units_select_tenant` limits a tenant to leased
 * units, so a unit they do not lease returns `null` here, and
 * `maintenance_tickets_insert_tenant` would reject the insert independently through
 * `can_access_unit()`.
 *
 * `property_id` comes back from this row and is what the service writes to the ticket,
 * which is why a mismatched `(property_id, property_unit_id)` pair cannot be constructed
 * by request shape at all.
 */
export async function findUnit(
  client: AppSupabaseClient,
  organizationId: string,
  unitId: string,
): Promise<UnitRow | null> {
  const { data, error } = await client
    .from('property_units')
    .select('id,property_id,unit_number,status')
    .eq('organization_id', organizationId)
    .eq('id', unitId)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as UnitRow | null) ?? null;
}

export async function findProperty(
  client: AppSupabaseClient,
  organizationId: string,
  propertyId: string,
): Promise<PropertyRow | null> {
  const { data, error } = await client
    .from('properties')
    .select('id,name,owner_member_id')
    .eq('organization_id', organizationId)
    .eq('id', propertyId)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as PropertyRow | null) ?? null;
}

/**
 * Units the caller may raise a ticket against, for the create form's picker.
 *
 * No role branch: RLS already answers the question. `property_units_select_tenant`
 * limits a tenant to leased units, `_select_staff` gives staff the organization, and
 * `_select_provider` gives a provider the units on their assigned tickets. A picker
 * built from this list therefore offers each role exactly what the INSERT policy would
 * accept — and when it does not, `createTicket` still refuses, because the picker is
 * convenience and the service is enforcement.
 *
 * Bounded to 200 rows. A picker is not a report; a portfolio larger than this needs the
 * properties lane's search, not a longer `<select>`.
 */
export async function listReportableUnits(
  client: AppSupabaseClient,
  organizationId: string,
): Promise<UnitRow[]> {
  const { data, error } = await client
    .from('property_units')
    .select('id,property_id,unit_number,status')
    .eq('organization_id', organizationId)
    .order('unit_number', { ascending: true })
    .limit(200);

  throwIfPostgresError(error);
  return (data ?? []) as unknown as UnitRow[];
}

/** Property names for the units above, so the picker reads "Marina Residence — 1203". */
export async function listPropertyNames(
  client: AppSupabaseClient,
  organizationId: string,
  propertyIds: readonly string[],
): Promise<PropertyRow[]> {
  if (propertyIds.length === 0) return [];

  const { data, error } = await client
    .from('properties')
    .select('id,name,owner_member_id')
    .eq('organization_id', organizationId)
    .in('id', [...new Set(propertyIds)]);

  throwIfPostgresError(error);
  return (data ?? []) as unknown as PropertyRow[];
}

/**
 * Active providers in the caller's organization, for the assign form's picker.
 *
 * `service_providers` is RW for staff and `R self` for a provider in the §4 matrix, so a
 * provider calling this sees only themselves and a tenant sees nothing — the picker is
 * empty rather than forbidden, and the assign route refuses them regardless.
 */
export async function listActiveProviders(
  client: AppSupabaseClient,
  organizationId: string,
): Promise<ProviderRow[]> {
  const { data, error } = await client
    .from('service_providers')
    .select('id,organization_id,company_name,status')
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('company_name', { ascending: true })
    .limit(200);

  throwIfPostgresError(error);
  return (data ?? []) as unknown as ProviderRow[];
}

/**
 * The active tenancy on a unit, optionally pinned to one tenant.
 *
 * Supplying `tenantId` is how a tenant-created ticket proves the unit is theirs from a
 * row rather than from the request. Omitting it is how staff raise a ticket on a
 * tenant's behalf: `maintenance_tickets.tenant_id` is `NOT NULL` and
 * `CreateTicketSchema` has no `tenant_id` field, so for a staff caller the reporting
 * tenant is *derived* from the unit's active tenancy. A unit with no active tenancy
 * therefore cannot have a ticket raised on it — see the service's `422`.
 */
export async function findActiveTenancy(
  client: AppSupabaseClient,
  organizationId: string,
  propertyUnitId: string,
  tenantId?: string,
): Promise<TenancyRow | null> {
  let query = client
    .from('tenancies')
    .select('id,tenant_id,status')
    .eq('organization_id', organizationId)
    .eq('property_unit_id', propertyUnitId)
    .eq('status', 'active');

  if (tenantId !== undefined) query = query.eq('tenant_id', tenantId);

  const { data, error } = await query
    .order('start_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as TenancyRow | null) ?? null;
}

/* --------------------------------------------------------------- providers -- */

/**
 * A service provider in the caller's own organization.
 *
 * `organization_id` is filtered here AND asserted by the service AND asserted by
 * `assert_ticket_provider_organization()` in `0003`, which raises
 * `ticket_provider_organization_mismatch` (`P0001` -> 409) on an insert or update that
 * names a provider from another organization. The composite foreign key
 * `(organization_id, assigned_provider_id)` makes it structurally impossible as well.
 * Four layers for one rule, because a cross-organization assignment would be the exact
 * failure this project exists to prevent.
 */
export async function findProvider(
  client: AppSupabaseClient,
  organizationId: string,
  providerId: string,
): Promise<ProviderRow | null> {
  const { data, error } = await client
    .from('service_providers')
    .select('id,organization_id,company_name,status')
    .eq('organization_id', organizationId)
    .eq('id', providerId)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as ProviderRow | null) ?? null;
}

/**
 * A tenant's NAME ONLY.
 *
 * The §4 matrix grants a `service_provider` "R name only, via assignment", and the
 * detail view is the one a provider reads. The projection is hard-coded to `id` and
 * `full_name` for every role rather than branching on the caller, so there is no
 * code path on which a provider could receive a tenant's email or phone. Staff who need
 * the full record read it from `/api/v1/tenants` (lane w1-l3), which is authorized for
 * that purpose.
 */
export async function findTenantName(
  client: AppSupabaseClient,
  organizationId: string,
  tenantId: string,
): Promise<TenantNameRow | null> {
  const { data, error } = await client
    .from('tenants')
    .select('id,full_name')
    .eq('organization_id', organizationId)
    .eq('id', tenantId)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as TenantNameRow | null) ?? null;
}

/* -------------------------------------------------------------- activities -- */

/**
 * Appends activity rows.
 *
 * `actor_profile_id` is a parameter the service always fills from
 * `membership.profile.id` and never from a request. Every INSERT policy on the table
 * pins it to `current_profile_id()`, so a forged author is rejected by the database as
 * well — "an activity row that could name its own author would make the timeline
 * worthless as evidence".
 *
 * Rows are inserted in one statement so a multi-row plan is atomic: a partially written
 * timeline could never be repaired, because the table rejects UPDATE and DELETE.
 */
export async function insertActivities(
  client: AppSupabaseClient,
  context: { organizationId: string; ticketId: string; actorProfileId: string },
  plan: readonly PlannedActivity[],
): Promise<ActivityRow[]> {
  if (plan.length === 0) return [];

  const { data, error } = await client
    .from('maintenance_activities')
    .insert(
      plan.map((activity) => ({
        organization_id: context.organizationId,
        ticket_id: context.ticketId,
        actor_profile_id: context.actorProfileId,
        activity_type: activity.activity_type,
        description: activity.description,
        metadata: { ...activity.metadata },
      })),
    )
    .select(ACTIVITY_COLUMNS);

  throwIfPostgresError(error);
  return (data ?? []) as unknown as ActivityRow[];
}

/**
 * The timeline, oldest first.
 *
 * Ascending, unlike the ticket list: a timeline is read as a narrative. The cursor
 * keyset is therefore `>` rather than `<`, which is why the two list functions do not
 * share a pager.
 */
export async function listActivities(
  client: AppSupabaseClient,
  organizationId: string,
  ticketId: string,
  options: { cursor?: string | undefined; limit: number },
): Promise<ActivityPage> {
  let query = client
    .from('maintenance_activities')
    .select(ACTIVITY_COLUMNS)
    .eq('organization_id', organizationId)
    .eq('ticket_id', ticketId);

  if (options.cursor !== undefined) {
    const { createdAt, id } = decodeTicketCursor(options.cursor);
    query = query.or(
      `created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt."${id}")`,
    );
  }

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(options.limit + 1);

  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as ActivityRow[];
  const hasMore = rows.length > options.limit;
  return { items: hasMore ? rows.slice(0, options.limit) : rows, hasMore };
}

/* --------------------------------------------------------------- documents -- */

/**
 * How many of `documentIds` are evidence already attached to this ticket.
 *
 * This lane does not write to `documents` — amendment A7 gives a `service_provider`
 * INSERT on `documents` scoped to assigned tickets, and the upload itself belongs to
 * lane w1-l6's `POST /api/v1/documents/upload-url`. Completion therefore *verifies* a
 * linkage it did not create: every id named in a completion must already be a document
 * row whose `ticket_id` is this ticket, in this organization. A mismatch is a 422, so
 * one ticket's completion can never cite another ticket's evidence.
 */
export async function countTicketEvidence(
  client: AppSupabaseClient,
  organizationId: string,
  ticketId: string,
  documentIds: readonly string[],
): Promise<number> {
  if (documentIds.length === 0) return 0;

  const { count, error } = await client
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('ticket_id', ticketId)
    .in('id', [...documentIds]);

  throwIfPostgresError(error);
  return count ?? 0;
}

/**
 * Open tickets by priority, for the dashboard widget.
 *
 * Four head-only counts rather than a `group by`: PostgREST cannot aggregate without a
 * database view, `supabase/migrations/**` belongs to another lane, and a widget is not
 * worth a planning defect. Each count runs through the caller's client, so each role's
 * widget counts exactly the rows that role may see.
 */
export async function countOpenTicketsByPriority(
  client: AppSupabaseClient,
  scope: TicketQueryScope,
  priorities: readonly TicketPriority[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (scope.impossible) {
    for (const priority of priorities) counts[priority] = 0;
    return counts;
  }

  for (const priority of priorities) {
    let query = client.from('maintenance_tickets').select('id', { count: 'exact', head: true });
    for (const [column, value] of Object.entries(scope.equals)) {
      query = query.eq(column, value);
    }
    query = query.eq('priority', priority);
    query = query.in('status', [
      ...(scope.statusIn ?? ['open', 'assigned', 'in_progress', 'awaiting_approval']),
    ]);

    const { count, error } = await query;
    throwIfPostgresError(error);
    counts[priority] = count ?? 0;
  }

  return counts;
}
