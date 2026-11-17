/**
 * Every database read and write the inbox performs. One file, so there is one list of
 * them.
 *
 * Reads go through the caller-scoped client, so Row Level Security applies as the
 * signed-in user. Writes do not — and cannot. Migration `0004` revokes INSERT, UPDATE
 * and DELETE on `inbound_messages` from `authenticated` outright, with the reasoning
 * written into the migration: *"A client that could edit `from_identifier` or `body`
 * could forge the evidence an AI classification was based on."* So the two status
 * transitions this lane performs take a service-role client explicitly, and the routes
 * that call them are the privileged variant. The asymmetry is the design, not a
 * workaround.
 *
 * Nothing here takes an `organization_id` from anywhere but `ctx.membership`, which is
 * itself derived from trusted rows by `resolveMembership()` (CLAUDE.md rule 5). There is
 * no DELETE in this file and no path to one (rule 6).
 *
 * `tenants.email` and `tenants.phone` are not selectable by `authenticated` after `0004`
 * §1 — a column grant, not a policy, because RLS filters rows and cannot withhold a
 * column. Phone numbers therefore come from `tenant_contact()`, which answers for staff
 * and for the tenant themselves and raises 42501 for everyone else.
 */

import { ApiRouteError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { Logger } from '@/lib/observability/logger';
import type { AppSupabaseClient, PrivilegedSupabaseClient } from '@/lib/supabase/types';

import { audienceFor } from './scope';
import { indexByPhone, phoneKey, type TenantDirectoryEntry } from './view';
import { waveThree, type InboundMessageRow } from './wave-three';

export interface InboxContext {
  readonly supabase: AppSupabaseClient;
  readonly membership: Membership;
  readonly logger: Logger;
}

/**
 * The three fields of `withApiHandler`'s context the domain actually needs.
 *
 * Structural, so a route handler's context satisfies it without a cast and without the
 * domain depending on the wrapper's generics. Note what it does not accept: a request, a
 * body or a query — the domain cannot read client input even by accident.
 */
export function inboxContextFrom(ctx: InboxContext): InboxContext {
  return { supabase: ctx.supabase, membership: ctx.membership, logger: ctx.logger };
}

/** Columns this lane reads from `inbound_messages`. Written out, never `*`. */
const MESSAGE_COLUMNS =
  'id, organization_id, provider, external_message_id, from_identifier, body, received_at, status, ticket_id';

export interface MessagePage {
  readonly items: readonly InboundMessageRow[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

/* ------------------------------------------------------------------ cursor -- */

/**
 * Keyset cursor over `(received_at desc, id desc)` — the order
 * `idx_inbound_messages_org` is built for.
 *
 * Opaque to the client and validated on the way back in: a cursor is a position, and a
 * position that does not parse is a 400 rather than a silently ignored parameter. An
 * ignored cursor would quietly re-serve page one forever.
 */
export function encodeCursor(row: InboundMessageRow): string {
  return Buffer.from(`${row.received_at}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { receivedAt: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'inbox_cursor_unreadable' },
    });
  }

  const separator = decoded.lastIndexOf('|');
  const receivedAt = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (separator < 0 || receivedAt.length === 0 || id.length === 0) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'inbox_cursor_malformed' },
    });
  }
  return { receivedAt, id };
}

/* -------------------------------------------------------------- contacts -- */

/**
 * Phone numbers for the tenants the caller may see, from `tenant_contact()`.
 *
 * A single round trip for the whole organization — which is why the function returns a
 * set rather than a scalar. Failure is not fatal: a directory with no phone numbers
 * resolves no senders, which means every message renders as unmatched. That is a
 * degraded screen, not a wrong one, and it fails in the safe direction.
 */
async function contactsByTenant(ctx: InboxContext): Promise<Map<string, string | null>> {
  const byTenant = new Map<string, string | null>();

  const { data, error } = await waveThree(ctx.supabase).rpc('tenant_contact', {
    p_organization_id: ctx.membership.organization.id,
  });

  if (error || !data) {
    // 42501 for a role the function refuses, which is a correct answer rather than a
    // fault. Logged as a reason code; the database's own message is never surfaced.
    ctx.logger.info('tenant contact details not available to this caller', {
      reason: 'tenant_contact_denied',
    });
    return byTenant;
  }

  for (const row of data) byTenant.set(row.tenant_id, row.phone);
  return byTenant;
}

/**
 * The caller's own comparable phone number, or `null`.
 *
 * Only meaningful for a tenant. `null` fails closed: a tenant whose record carries no
 * phone number matches no inbound message, which is the correct answer rather than a
 * reason to widen the query.
 */
async function ownPhoneKey(ctx: InboxContext): Promise<string | null> {
  if (!ctx.membership.tenantId) return null;

  const { data, error } = await waveThree(ctx.supabase).rpc('tenant_contact', {
    p_organization_id: ctx.membership.organization.id,
    p_tenant_id: ctx.membership.tenantId,
  });

  if (error || !data || data.length === 0) return null;
  return phoneKey(data[0]?.phone ?? null);
}

/* ------------------------------------------------------------------- reads -- */

/**
 * A page of inbound messages, newest first.
 *
 * The role decides the filter and nothing else — there is one query, so a role cannot
 * accidentally get a differently-shaped projection. A role with no entitlement returns
 * an empty page without touching the database at all.
 *
 * Worth knowing while reading this: `0004`'s only SELECT policy on `inbound_messages` is
 * `inbound_messages_select_staff`. A tenant therefore sees **zero rows** however this
 * function is written. The `own-number` branch is kept because the application layer must
 * not depend on a policy's current shape to be correct — if a tenant read policy is added
 * later, this code already narrows to their own messages rather than suddenly showing
 * them the organization's queue.
 */
export async function listMessages(
  ctx: InboxContext,
  query: { cursor?: string | undefined; limit: number },
): Promise<MessagePage> {
  const audience = audienceFor(ctx.membership.role);
  const empty: MessagePage = { items: [], nextCursor: null, hasMore: false, limit: query.limit };
  if (audience === 'none') return empty;

  let builder = waveThree(ctx.supabase)
    .from('inbound_messages')
    .select(MESSAGE_COLUMNS)
    .eq('organization_id', ctx.membership.organization.id)
    .order('received_at', { ascending: false })
    .order('id', { ascending: false })
    // One more than asked for. `has_more` must come from the query, not be guessed at
    // from whether the page came back full.
    .limit(query.limit + 1);

  if (audience === 'own-number') {
    const key = await ownPhoneKey(ctx);
    if (!key) return empty;
    // The national significant number, matched as a substring. The exact comparison is
    // re-applied in `view.ts` against the same key, so a looser SQL predicate cannot
    // widen what is actually shown.
    builder = builder.ilike('from_identifier', `%${key}%`);
  }

  if (query.cursor) {
    const { receivedAt, id } = decodeCursor(query.cursor);
    builder = builder.or(
      `received_at.lt.${receivedAt},and(received_at.eq.${receivedAt},id.lt.${id})`,
    );
  }

  const { data, error } = await builder;
  if (error) throw readFailure(ctx, 'inbound_messages_read_failed');

  const rows = (data ?? []) as InboundMessageRow[];
  const hasMore = rows.length > query.limit;
  const items = hasMore ? rows.slice(0, query.limit) : rows;
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
    limit: query.limit,
  };
}

/**
 * One message, or `null`.
 *
 * `null` rather than a throw, so the caller decides between a 404 and an empty screen. A
 * row the caller may not read comes back as `null` from RLS, which is why an absent row
 * and a forbidden row are indistinguishable here — deliberately, and the same way
 * `NOT_FOUND` and `FORBIDDEN` are phrased alike in the frozen envelope.
 */
export async function readMessage(
  ctx: InboxContext,
  messageId: string,
): Promise<InboundMessageRow | null> {
  const audience = audienceFor(ctx.membership.role);
  if (audience === 'none') return null;

  const { data, error } = await waveThree(ctx.supabase)
    .from('inbound_messages')
    .select(MESSAGE_COLUMNS)
    .eq('id', messageId)
    .eq('organization_id', ctx.membership.organization.id)
    .maybeSingle();

  if (error) throw readFailure(ctx, 'inbound_message_read_failed');
  const row = (data ?? null) as InboundMessageRow | null;
  if (!row) return null;

  // A tenant may read their own messages only. RLS has already decided this; checking it
  // here as well is the point of defence in depth, and it costs one comparison on a row
  // we have already paid to fetch.
  if (audience === 'own-number') {
    const key = await ownPhoneKey(ctx);
    if (!key || phoneKey(row.from_identifier) !== key) return null;
  }

  return row;
}

/* --------------------------------------------------------------- directory -- */

/**
 * The tenants this caller may already see, with the unit they currently occupy.
 *
 * Used for two things: resolving a sender to a tenant, and populating the simulator's
 * "send as" list. Both are the same question — "whose number is this?" — and both must be
 * answered from rows the caller is entitled to read, so that the inbox cannot become a
 * way to confirm that a phone number belongs to somebody in another organization.
 *
 * A tenant caller gets a directory of exactly one entry: themselves.
 */
export async function tenantDirectory(ctx: InboxContext): Promise<TenantDirectoryEntry[]> {
  const audience = audienceFor(ctx.membership.role);
  if (audience === 'none') return [];

  // `full_name` only. `email` and `phone` are not in the column grant after `0004` §1,
  // and selecting them here would be a 42501 rather than a leak — but it would also be a
  // query that cannot succeed, which is worse than one that is simply correct.
  let tenantQuery = ctx.supabase
    .from('tenants')
    .select('id, full_name')
    .eq('organization_id', ctx.membership.organization.id)
    .order('full_name', { ascending: true })
    .limit(200);

  if (audience === 'own-number') {
    if (!ctx.membership.tenantId) return [];
    tenantQuery = tenantQuery.eq('id', ctx.membership.tenantId);
  }

  const { data: tenants, error } = await tenantQuery;
  if (error) throw readFailure(ctx, 'tenant_directory_read_failed');
  if (!tenants || tenants.length === 0) return [];

  const [phones, unitByTenant] = await Promise.all([
    contactsByTenant(ctx),
    activeUnitByTenant(
      ctx,
      tenants.map((tenant) => tenant.id),
    ),
  ]);

  return tenants.map((tenant) => ({
    id: tenant.id,
    fullName: tenant.full_name,
    phone: phones.get(tenant.id) ?? null,
    unit: unitByTenant.get(tenant.id) ?? null,
  }));
}

/** `tenantDirectory`, indexed for matching. */
export async function senderDirectory(
  ctx: InboxContext,
): Promise<ReadonlyMap<string, TenantDirectoryEntry>> {
  return indexByPhone(await tenantDirectory(ctx));
}

/**
 * The unit each tenant currently occupies, where exactly one active tenancy exists.
 *
 * A tenant with two active tenancies is deliberately left unresolved rather than guessed:
 * the unit decides which property a ticket lands on, and a guess there is a ticket raised
 * against somebody else's home. The operator picks in that case.
 */
async function activeUnitByTenant(
  ctx: InboxContext,
  tenantIds: readonly string[],
): Promise<Map<string, { id: string; label: string }>> {
  const resolved = new Map<string, { id: string; label: string }>();
  if (tenantIds.length === 0) return resolved;

  const { data: tenancies, error } = await ctx.supabase
    .from('tenancies')
    .select('id, tenant_id, property_unit_id, status')
    .eq('organization_id', ctx.membership.organization.id)
    .eq('status', 'active')
    .in('tenant_id', [...tenantIds]);

  if (error) throw readFailure(ctx, 'tenancy_read_failed');
  if (!tenancies || tenancies.length === 0) return resolved;

  const unitIdsByTenant = new Map<string, string[]>();
  for (const tenancy of tenancies) {
    const existing = unitIdsByTenant.get(tenancy.tenant_id) ?? [];
    existing.push(tenancy.property_unit_id);
    unitIdsByTenant.set(tenancy.tenant_id, existing);
  }

  const labels = await unitLabels(ctx, [
    ...new Set(tenancies.map((tenancy) => tenancy.property_unit_id)),
  ]);

  for (const [tenantId, units] of unitIdsByTenant) {
    if (units.length !== 1) continue;
    const unitId = units[0] as string;
    const label = labels.get(unitId);
    if (label) resolved.set(tenantId, { id: unitId, label });
  }

  return resolved;
}

/** `Marina Heights · Unit 1204`, for every unit id the caller may read. */
async function unitLabels(
  ctx: InboxContext,
  unitIds: readonly string[],
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (unitIds.length === 0) return labels;

  const { data: units, error } = await ctx.supabase
    .from('property_units')
    .select('id, unit_number, property_id')
    .in('id', [...unitIds]);

  if (error) throw readFailure(ctx, 'unit_read_failed');
  if (!units || units.length === 0) return labels;

  const { data: properties, error: propertyError } = await ctx.supabase
    .from('properties')
    .select('id, name')
    .in('id', [...new Set(units.map((unit) => unit.property_id))]);

  if (propertyError) throw readFailure(ctx, 'property_read_failed');

  const propertyNames = new Map((properties ?? []).map((property) => [property.id, property.name]));
  for (const unit of units) {
    const property = propertyNames.get(unit.property_id);
    labels.set(
      unit.id,
      property ? `${property} · Unit ${unit.unit_number}` : `Unit ${unit.unit_number}`,
    );
  }
  return labels;
}

/**
 * Every unit in the caller's organization, labelled for a picker.
 *
 * The operator chooses which unit a ticket lands on, so the list has to be the whole
 * organization rather than only the sender's — an unmatched sender has no tenancy to
 * narrow it, and that is exactly the case where a human has to decide. RLS scopes the
 * read, and the commit route re-authorizes whichever id comes back, so a stale or
 * tampered option is refused on submit rather than trusted here.
 */
export async function organizationUnits(
  ctx: InboxContext,
): Promise<{ id: string; label: string }[]> {
  if (audienceFor(ctx.membership.role) !== 'organization') return [];

  const { data: units, error } = await ctx.supabase
    .from('property_units')
    .select('id, unit_number, property_id')
    .eq('organization_id', ctx.membership.organization.id)
    .order('unit_number', { ascending: true })
    .limit(300);

  if (error) throw readFailure(ctx, 'unit_list_read_failed');
  if (!units || units.length === 0) return [];

  const labels = await unitLabels(
    ctx,
    units.map((unit) => unit.id),
  );
  return units.map((unit) => ({
    id: unit.id,
    label: labels.get(unit.id) ?? `Unit ${unit.unit_number}`,
  }));
}

/* ------------------------------------------------------------------ writes -- */

/**
 * Records that a human turned this message into a ticket.
 *
 * `linked`, which is one of the five values `0004`'s check constraint admits — not
 * `ticket_created`, which Postgres would refuse.
 *
 * Service-role, because `authenticated` holds no UPDATE privilege on this table at all.
 * The organization filter is still applied even though RLS is bypassed: it comes from
 * `ctx.membership`, and it is the only thing standing between a privileged client and
 * another organization's row. A privileged query without its own scope clause is the
 * defect this comment exists to prevent.
 *
 * Called only after `POST /api/v1/maintenance/tickets` has already returned a ticket, so
 * the link can never point at a ticket that does not exist.
 */
export async function linkMessageToTicket(
  ctx: InboxContext,
  serviceRole: PrivilegedSupabaseClient,
  messageId: string,
  ticketId: string,
): Promise<void> {
  const { error } = await waveThree(serviceRole)
    .from('inbound_messages')
    .update({ ticket_id: ticketId, status: 'linked' })
    .eq('id', messageId)
    .eq('organization_id', ctx.membership.organization.id);

  if (error) {
    ctx.logger.warn('inbound message could not be linked to its ticket', {
      reason: 'inbound_message_link_failed',
      ticket_id: ticketId,
    });
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'inbound_message_link_failed' },
    });
  }
}

/**
 * Marks a message as classified — a draft exists and a human has not yet decided.
 *
 * Best effort by design. A classification creates nothing, so failing the request because
 * a status chip could not be updated would deny the operator a draft they are entitled to
 * over a cosmetic concern. A message that is already `linked` is left alone: the
 * `ticket_id is null` filter is what stops a re-classification from walking a committed
 * message backwards.
 */
export async function markClassified(
  ctx: InboxContext,
  serviceRole: PrivilegedSupabaseClient | undefined,
  messageId: string,
): Promise<void> {
  if (!serviceRole) return;

  const { error } = await waveThree(serviceRole)
    .from('inbound_messages')
    .update({ status: 'classified' })
    .eq('id', messageId)
    .eq('organization_id', ctx.membership.organization.id)
    .is('ticket_id', null);

  if (error) {
    ctx.logger.info('classified status not recorded', { reason: 'inbound_status_update_skipped' });
  }
}

/* ----------------------------------------------------------------- errors -- */

/**
 * A failed read, reported without the database's own message.
 *
 * PostgREST error text can quote a row value or a policy name, and both are exactly what
 * CLAUDE.md rule 8 keeps out of a log. The reason code is ours and is enough to find the
 * query.
 */
function readFailure(ctx: InboxContext, reason: string): ApiRouteError {
  ctx.logger.warn('inbox read failed', { reason });
  return new ApiRouteError('INTERNAL_ERROR', { logFields: { reason } });
}
