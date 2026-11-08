/**
 * The maintenance domain service — the lane's single authorization choke point.
 *
 * Every route under `app/api/v1/maintenance/**` and every dashboard page calls a
 * function in this file; none of them query a table directly. That is what makes the
 * two-layer claim checkable: if a rule is enforced here and in RLS, it is enforced
 * twice, and there is no third path that skipped one of them.
 *
 * Order of operations, identical in every mutation below, and in this order for a
 * reason:
 *
 *   1. read the row                — through the caller's client, so RLS filters first
 *   2. 404 when it is not there    — absent and inaccessible are indistinguishable
 *   3. `assertAuthorized(...)`     — the §4 matrix, against the row's own columns
 *   4. field allowlist             — which columns this role may write at all
 *   5. `assertTicketTransition()`  — the state machine, bound to the row
 *   6. write, guarded on `status`  — optimistic concurrency, so two clicks are one edge
 *   7. append the activity rows    — after the write succeeded, never before
 *
 * Step 2 before step 3 is deliberate: a denied read and a missing ticket must look the
 * same from outside, and they do, because the read is already RLS-scoped. Step 5 after
 * step 3 is also deliberate: the state machine's 409 must not be reachable by somebody
 * who is not permitted to touch the ticket at all, or the graph is discoverable.
 *
 * `organization_id` never comes from a request anywhere in this file. It is
 * `membership.organization.id`, resolved by `resolveMembership()` from trusted rows.
 */

import {
  TICKET_PRIORITIES,
  resolvePriority,
  type ActivityType,
  type AssignTicketInput,
  type CompleteTicketInput,
  type CreateActivityInput,
  type CreateTicketInput,
  type JsonValue,
  type ListActivitiesQuery,
  type ListTicketsQuery,
  type MaintenanceCategory,
  type PageInfo,
  type TicketPriority,
  type TicketStatus,
} from '@shared/index';

import { conflict, forbidden, notFound, unprocessable } from '@/lib/api/errors';
import { assertAuthorized } from '@/lib/auth/authorize';
import type { Membership } from '@/lib/auth/roles';
import type { Logger } from '@/lib/observability/logger';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import {
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  planAssignmentActivity,
  planClientActivity,
  planCompletionActivity,
  planCreationActivity,
  planPriorityActivity,
  planTransitionActivity,
  type PlannedActivity,
} from './activities';
import { isOutsideBusinessHours } from './business-hours';
import { nextCursorFor } from './cursor';
import {
  isClientPostableActivityType,
  writableTicketFields,
  type TicketField,
} from './field-policy';
import * as repository from './repository';
import type { ActivityRow, TicketRow } from './repository';
import { ticketListScope } from './scope';
import { assertTicketTransition } from './transitions';
import { normaliseCategory, toTicketDetail, type TicketDetailContext } from './view';

/**
 * What every service function needs.
 *
 * `now` is injected rather than read from `Date.now()` inside the service, for the same
 * reason `resolvePriority()` takes `outsideBusinessHours` as an input: a policy that
 * reads the clock cannot be tested deterministically, and the out-of-hours escalation
 * is a real behaviour difference.
 */
export interface MaintenanceContext {
  supabase: AppSupabaseClient;
  membership: Membership;
  logger: Logger;
  now?: Date;
}

/** A page of tickets, in the shared `{ data, page_info }` shape. */
export interface TicketPageResult {
  items: TicketRow[];
  pageInfo: PageInfo;
}

export interface ActivityPageResult {
  items: ActivityRow[];
  pageInfo: PageInfo;
}

/** A mutation's outcome: the stored row plus what was appended to the timeline. */
export interface TicketMutation {
  ticket: TicketRow;
  activities: PlannedActivity[];
}

/* ---------------------------------------------------------------- create -- */

/**
 * Creates a ticket for a unit the caller is authorized for.
 *
 * Four columns `maintenance_tickets` requires are absent from `CreateTicketSchema` and
 * derived here, which is what makes a cross-tenant ticket unconstructable by request
 * shape:
 *
 *  - `organization_id` — from trusted membership.
 *  - `property_id` — from the unit row. The caller names only a unit, so the
 *    `(property_id, property_unit_id)` pair is consistent by construction. An
 *    inconsistent pair is also rejected by `unit_belongs_to_property()` inside
 *    `maintenance_tickets_insert_tenant`, which is the live RLS defect this derivation
 *    keeps us clear of.
 *  - `tenant_id` — for a tenant caller, their own `tenants.id` from membership; for a
 *    staff caller, the tenant on the unit's active tenancy. Never from the body.
 *  - `tenancy_id` — the active tenancy, or `null` for a vacant unit a staff member is
 *    raising work on.
 *
 * The tenant path requires an ACTIVE TENANCY linking the caller to the unit. That is the
 * application-space half of "a tenant may only report on a unit they are authorized
 * for"; `can_access_unit()` in the INSERT policy is the other half, and both must hold.
 *
 * `priority` in the body is a request, not a decision: it is fed to `resolvePriority()`
 * as a suggestion and capped by it. A tenant marking everything urgent does not make
 * anything urgent.
 */
export async function createTicket(
  context: MaintenanceContext,
  input: CreateTicketInput,
): Promise<TicketMutation> {
  const { supabase, membership } = context;
  const organizationId = membership.organization.id;

  assertAuthorized(membership, 'create', {
    type: 'maintenance_ticket',
    organizationId,
  });

  const unit = await repository.findUnit(supabase, organizationId, input.property_unit_id);
  if (!unit) {
    // 422, not 404: the unit is a field of the request, and the resource being created
    // is the ticket. It also says nothing about whether the unit exists.
    throw unprocessable({
      message: 'That unit is not one you can report maintenance for.',
      logFields: { reason: 'unit_not_accessible', unit_id: input.property_unit_id },
    });
  }

  const { tenantId, tenancyId } = await resolveReporter(context, unit.id);

  const category: MaintenanceCategory = input.category;
  const recurringOpenTickets = await repository.countRecurringOpenTickets(
    supabase,
    organizationId,
    unit.id,
    category,
  );

  const decision = resolvePriority(
    { suggested_priority: input.priority ?? null },
    {
      category,
      hasActiveTenancy: tenancyId !== null,
      recurringOpenTickets,
      outsideBusinessHours: isOutsideBusinessHours(context.now ?? new Date()),
      currentPriority: null,
    },
  );

  const ticket = await repository.insertTicket(supabase, {
    organizationId,
    propertyId: unit.property_id,
    propertyUnitId: unit.id,
    tenancyId,
    tenantId,
    title: input.title,
    description: input.description,
    category,
    priority: decision.priority,
    source: input.source,
  });

  const plan = [
    planCreationActivity({
      category,
      priority: decision.priority,
      priorityReasons: decision.reasons,
      source: input.source,
    }),
  ];
  await repository.insertActivities(
    supabase,
    { organizationId, ticketId: ticket.id, actorProfileId: membership.profile.id },
    plan,
  );

  context.logger.info('ticket created', {
    ticket_id: ticket.id,
    unit_id: unit.id,
    property_id: unit.property_id,
    priority: decision.priority,
    category,
  });

  return { ticket, activities: plan };
}

/**
 * Who the ticket is reported BY, from rows.
 *
 * For a `tenant`: themselves, and only if an active tenancy links them to the unit.
 * For staff: the tenant on the unit's active tenancy, because `tenant_id` is `NOT NULL`
 * and no request may assert it. A unit with no active tenancy therefore has no reporter
 * and cannot carry a ticket — a 422 rather than a silent `null`, since the alternative
 * would be inventing a tenant.
 */
async function resolveReporter(
  context: MaintenanceContext,
  unitId: string,
): Promise<{ tenantId: string; tenancyId: string | null }> {
  const { supabase, membership } = context;
  const organizationId = membership.organization.id;

  if (membership.role === 'tenant') {
    if (membership.tenantId === null) {
      throw forbidden({ logFields: { reason: 'tenant_without_tenant_record' } });
    }
    const tenancy = await repository.findActiveTenancy(
      supabase,
      organizationId,
      unitId,
      membership.tenantId,
    );
    if (!tenancy) {
      throw unprocessable({
        message: 'That unit is not one you can report maintenance for.',
        logFields: { reason: 'no_active_tenancy_for_caller', unit_id: unitId },
      });
    }
    return { tenantId: membership.tenantId, tenancyId: tenancy.id };
  }

  const tenancy = await repository.findActiveTenancy(supabase, organizationId, unitId);
  if (!tenancy) {
    throw unprocessable({
      message: 'That unit has no active tenancy, so there is no reporting tenant to record.',
      logFields: { reason: 'unit_has_no_active_tenancy', unit_id: unitId },
    });
  }
  return { tenantId: tenancy.tenant_id, tenancyId: tenancy.id };
}

/* ------------------------------------------------------------------ reads -- */

/**
 * A page of tickets the caller may see.
 *
 * The scope is derived from trusted membership by `ticketListScope()` and applied
 * server-side, on top of RLS. A provider's queue, a tenant's own reports and the
 * organization-wide staff view are the same query with different predicates, which is
 * why there is no separate "provider job list" function: a second query would be a
 * second place for the provider predicate to be forgotten.
 */
export async function listTicketPage(
  context: MaintenanceContext,
  query: ListTicketsQuery,
): Promise<TicketPageResult> {
  const scope = ticketListScope(context.membership, query);

  if (scope.impossible) {
    context.logger.info('ticket list scoped to empty', { reason: scope.reason });
  }

  const page = await repository.listTickets(context.supabase, scope, {
    cursor: query.cursor,
    limit: query.limit,
  });

  return {
    items: page.items,
    pageInfo: {
      next_cursor: nextCursorFor(page.items, page.hasMore),
      has_more: page.hasMore,
      limit: query.limit,
    },
  };
}

/**
 * One ticket with its context and its timeline.
 *
 * The property row is read before the authorization decision because
 * `properties.owner_member_id` is the only way to evaluate the matrix's
 * `property_owner` cell — RLS has already restricted the ticket read to owned
 * properties, and this is the application-space check that does not assume so.
 */
export async function getTicketDetail(context: MaintenanceContext, ticketId: string) {
  const { supabase, membership } = context;
  const organizationId = membership.organization.id;

  const ticket = await requireTicket(context, ticketId);
  const property = await repository.findProperty(supabase, organizationId, ticket.property_id);

  assertAuthorized(membership, 'read', {
    type: 'maintenance_ticket',
    organizationId: ticket.organization_id,
    ownerMemberId: property?.owner_member_id ?? null,
    tenantId: ticket.tenant_id,
    providerId: ticket.assigned_provider_id,
  });

  const [unit, tenant, provider, activities] = await Promise.all([
    repository.findUnit(supabase, organizationId, ticket.property_unit_id),
    repository.findTenantName(supabase, organizationId, ticket.tenant_id),
    ticket.assigned_provider_id
      ? repository.findProvider(supabase, organizationId, ticket.assigned_provider_id)
      : Promise.resolve(null),
    repository.listActivities(supabase, organizationId, ticketId, { limit: 100 }),
  ]);

  const detailContext: TicketDetailContext = {
    ticket,
    unit,
    property,
    provider,
    tenant,
    activities: activities.items,
  };

  return toTicketDetail(detailContext, membership);
}

/**
 * The timeline, paged.
 *
 * Read-only by construction: there is no update or delete counterpart anywhere in this
 * lane, because `maintenance_activities` rejects both for every caller including the
 * table owner. A mistaken entry is corrected by appending a contradicting one, never by
 * amending it.
 */
export async function listTicketActivities(
  context: MaintenanceContext,
  ticketId: string,
  query: ListActivitiesQuery,
): Promise<ActivityPageResult> {
  const ticket = await requireTicket(context, ticketId);

  assertAuthorized(context.membership, 'read', {
    type: 'maintenance_activity',
    organizationId: ticket.organization_id,
    tenantId: ticket.tenant_id,
    providerId: ticket.assigned_provider_id,
    ownerMemberId: await ownerMemberIdFor(context, ticket),
  });

  const page = await repository.listActivities(
    context.supabase,
    context.membership.organization.id,
    ticketId,
    { cursor: query.cursor, limit: query.limit },
  );

  return {
    items: page.items,
    pageInfo: {
      next_cursor: nextCursorFor(page.items, page.hasMore),
      has_more: page.hasMore,
      limit: query.limit,
    },
  };
}

/* ------------------------------------------------------------------ patch -- */

/**
 * Updates a ticket's fields and/or drives one transition.
 *
 * `status` and the content fields travel in one `UpdateTicketSchema` body, so a single
 * request can do both. The activity plan keeps them distinguishable: AT MOST ONE row
 * carries `from_status`/`to_status` and therefore counts as the transition, and a
 * priority change gets its own `priority_changed` row that does not.
 *
 * A category change re-runs `resolvePriority()` unless the caller supplied a priority
 * explicitly. The policy never lowers a priority a human already set (`currentPriority`
 * is a floor), so re-deciding is safe and keeps the stored priority consistent with the
 * category it is derived from.
 */
export async function patchTicket(
  context: MaintenanceContext,
  ticketId: string,
  input: {
    title?: string | undefined;
    description?: string | undefined;
    category?: MaintenanceCategory | undefined;
    priority?: TicketPriority | undefined;
    status?: TicketStatus | undefined;
  },
): Promise<TicketMutation> {
  const { supabase, membership } = context;
  const organizationId = membership.organization.id;

  const ticket = await requireTicket(context, ticketId);

  assertAuthorized(membership, 'update', {
    type: 'maintenance_ticket',
    organizationId: ticket.organization_id,
    tenantId: ticket.tenant_id,
    providerId: ticket.assigned_provider_id,
  });

  const nextStatus =
    input.status !== undefined && input.status !== ticket.status ? input.status : null;
  if (nextStatus !== null) {
    assertTicketTransition(subjectOf(ticket), nextStatus, membership);
  }

  const patch: repository.TicketPatch = {};
  const plan: PlannedActivity[] = [];

  /* 4. field allowlist ------------------------------------------------------ */
  const requested = requestedFields(input);
  const writable = writableTicketFields(membership.role, ticket.status);
  const refused = requested.filter((field) => !writable.includes(field));
  if (refused.length > 0) {
    throw forbidden({
      logFields: {
        reason: 'ticket_field_not_writable_for_role',
        ticket_id: ticket.id,
        role: membership.role,
        status: ticket.status,
        // Field NAMES only — never their values, which are user text.
        count: refused.length,
      },
    });
  }

  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;

  const nextCategory = input.category ?? normaliseCategory(ticket.category);
  if (input.category !== undefined) patch.category = input.category;

  /* priority: either an authorized staff override, or the deterministic policy ---- */
  let priorityPlan: PlannedActivity | null = null;
  if (input.priority !== undefined) {
    if (input.priority !== ticket.priority) {
      patch.priority = input.priority;
      priorityPlan = planPriorityActivity({
        from: ticket.priority,
        to: input.priority,
        reasons: ['staff_override'],
        decidedBy: 'staff_override',
      });
    }
  } else if (
    input.category !== undefined &&
    input.category !== normaliseCategory(ticket.category)
  ) {
    const recurringOpenTickets = await repository.countRecurringOpenTickets(
      supabase,
      organizationId,
      ticket.property_unit_id,
      nextCategory,
      ticket.id,
    );
    const decision = resolvePriority(null, {
      category: nextCategory,
      hasActiveTenancy: ticket.tenancy_id !== null,
      recurringOpenTickets,
      outsideBusinessHours: isOutsideBusinessHours(context.now ?? new Date()),
      currentPriority: ticket.priority,
    });
    if (decision.priority !== ticket.priority) {
      patch.priority = decision.priority;
      priorityPlan = planPriorityActivity({
        from: ticket.priority,
        to: decision.priority,
        reasons: decision.reasons,
        decidedBy: 'policy',
      });
    }
  }

  if (nextStatus !== null) {
    patch.status = nextStatus;
    plan.push(planTransitionActivity(ticket.status, nextStatus));
  }
  if (priorityPlan) plan.push(priorityPlan);

  if (Object.keys(patch).length === 0) {
    // Nothing to do: the body matched the stored row field for field. Returning the row
    // unchanged is correct and writes no activity, because nothing happened.
    return { ticket, activities: [] };
  }

  const updated = await repository.updateTicket(
    supabase,
    organizationId,
    ticketId,
    ticket.status,
    patch,
  );
  if (!updated) throw staleTicket(ticket);

  await repository.insertActivities(
    supabase,
    { organizationId, ticketId, actorProfileId: membership.profile.id },
    plan,
  );

  context.logger.info('ticket updated', {
    ticket_id: ticketId,
    from_status: ticket.status,
    to_status: updated.status,
    priority: updated.priority,
  });

  return { ticket: updated, activities: plan };
}

/* ----------------------------------------------------------------- assign -- */

/**
 * Manager triage: set the provider and drive `open -> assigned`.
 *
 * Assignment is its own route, not a field on PATCH, because it is its own
 * authorization decision and its own audit action. Three things it establishes:
 *
 *  - The provider is in the CALLER'S OWN ORGANIZATION. Checked here against the row,
 *    enforced by RLS on the `service_providers` read, asserted again by
 *    `assert_ticket_provider_organization()` in `0003`, and made structurally
 *    impossible by the composite foreign key.
 *  - The provider is `active`. Assigning work to a deactivated provider would create a
 *    ticket nobody can see, because `current_provider_id()` returns `null` for one.
 *  - Priority is re-decided by `resolvePriority()` at triage, never taken from the
 *    request — `AssignTicketSchema` has no priority field at all. The policy's
 *    `currentPriority` floor means triage can raise a priority and never lower one.
 *
 * Reassignment is not a modelled edge: `assigned -> assigned` is not in
 * `ALLOWED_TRANSITIONS`, so a second assign attempt is a 409. Changing an assignee is a
 * specification change, not a code change.
 */
export async function assignTicket(
  context: MaintenanceContext,
  ticketId: string,
  input: AssignTicketInput,
): Promise<TicketMutation> {
  const { supabase, membership } = context;
  const organizationId = membership.organization.id;

  const ticket = await requireTicket(context, ticketId);

  assertAuthorized(membership, 'update', {
    type: 'maintenance_ticket',
    organizationId: ticket.organization_id,
    tenantId: ticket.tenant_id,
    providerId: ticket.assigned_provider_id,
  });

  assertTicketTransition(subjectOf(ticket), 'assigned', membership);

  const provider = await repository.findProvider(supabase, organizationId, input.provider_id);
  if (!provider || provider.organization_id !== organizationId) {
    throw unprocessable({
      message: 'That service provider is not available in your organization.',
      logFields: { reason: 'provider_not_in_organization', provider_id: input.provider_id },
    });
  }
  if (provider.status !== 'active') {
    throw unprocessable({
      message: 'That service provider is not active.',
      logFields: { reason: 'provider_not_active', provider_id: provider.id },
    });
  }

  const recurringOpenTickets = await repository.countRecurringOpenTickets(
    supabase,
    organizationId,
    ticket.property_unit_id,
    ticket.category,
    ticket.id,
  );
  const decision = resolvePriority(null, {
    category: normaliseCategory(ticket.category),
    hasActiveTenancy: ticket.tenancy_id !== null,
    recurringOpenTickets,
    outsideBusinessHours: isOutsideBusinessHours(context.now ?? new Date()),
    currentPriority: ticket.priority,
  });

  const updated = await repository.updateTicket(supabase, organizationId, ticketId, ticket.status, {
    assigned_provider_id: provider.id,
    status: 'assigned',
    priority: decision.priority,
  });
  if (!updated) throw staleTicket(ticket);

  const plan: PlannedActivity[] = [
    planAssignmentActivity({
      from: ticket.status,
      providerId: provider.id,
      priority: decision.priority,
      priorityChanged: decision.priority !== ticket.priority,
      priorityReasons: decision.reasons,
    }),
  ];
  if (input.note !== undefined) {
    plan.push(
      planClientActivity({
        activityType: 'comment_added',
        description: input.note,
        metadata: { provider_id: provider.id },
      }),
    );
  }

  await repository.insertActivities(
    supabase,
    { organizationId, ticketId, actorProfileId: membership.profile.id },
    plan,
  );

  context.logger.info('ticket assigned', {
    ticket_id: ticketId,
    provider_id: provider.id,
    from_status: ticket.status,
    to_status: 'assigned',
    priority: decision.priority,
  });

  return { ticket: updated, activities: plan };
}

/* --------------------------------------------------------------- complete -- */

/**
 * Closes `awaiting_approval -> completed`.
 *
 * Only a manager, an organization admin or the reporting tenant may drive this edge —
 * a provider cannot approve its own work — and `assertTicketTransition` is where that is
 * decided, from the shared `TRANSITION_ROLES` table.
 *
 * `confirmed: true` is a `z.literal` in `CompleteTicketSchema`, so the close cannot
 * happen on an empty or default-valued body. That literal is the contract-level half of
 * "AI drafts, humans commit": this is a terminal state in a workflow with no reopen
 * edge, reachable only by an explicit authenticated act.
 *
 * Evidence is verified, not created. Lane w1-l6 owns `documents`; every id named here
 * must ALREADY be a document row whose `ticket_id` is this ticket, so one ticket's
 * completion can never cite another's evidence.
 */
export async function completeTicket(
  context: MaintenanceContext,
  ticketId: string,
  input: CompleteTicketInput,
): Promise<TicketMutation> {
  const { supabase, membership } = context;
  const organizationId = membership.organization.id;

  const ticket = await requireTicket(context, ticketId);

  assertAuthorized(membership, 'update', {
    type: 'maintenance_ticket',
    organizationId: ticket.organization_id,
    tenantId: ticket.tenant_id,
    providerId: ticket.assigned_provider_id,
  });

  assertTicketTransition(subjectOf(ticket), 'completed', membership);

  // Belt and braces since amendment A20 lowered `CompleteTicketSchema` to 1000 to match
  // `CreateActivitySchema.description`: the schema now rejects an over-long summary as a
  // 400 before this runs. The guard stays because the service is callable from outside a
  // route — and because rejecting is the only safe answer. `maintenance_activities` can
  // never be amended, so a silently truncated resolution note would be permanent.
  if (input.resolution_summary.length > ACTIVITY_DESCRIPTION_MAX_LENGTH) {
    throw unprocessable({
      message: `The resolution summary must be ${ACTIVITY_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
      logFields: { reason: 'resolution_summary_too_long_for_timeline', ticket_id: ticketId },
    });
  }

  const evidenceIds = input.evidence_document_ids ?? [];
  if (evidenceIds.length > 0) {
    const unique = [...new Set(evidenceIds)];
    const found = await repository.countTicketEvidence(supabase, organizationId, ticketId, unique);
    if (found !== unique.length) {
      throw unprocessable({
        message: 'One or more evidence documents are not attached to this ticket.',
        logFields: {
          reason: 'evidence_not_attached_to_ticket',
          ticket_id: ticketId,
          count: unique.length - found,
        },
      });
    }
  }

  const updated = await repository.updateTicket(supabase, organizationId, ticketId, ticket.status, {
    status: 'completed',
  });
  if (!updated) throw staleTicket(ticket);

  const plan: PlannedActivity[] = [
    planCompletionActivity({
      from: ticket.status,
      resolutionSummary: input.resolution_summary,
      evidenceDocumentIds: [...new Set(evidenceIds)],
    }),
  ];

  await repository.insertActivities(
    supabase,
    { organizationId, ticketId, actorProfileId: membership.profile.id },
    plan,
  );

  context.logger.info('ticket completed', {
    ticket_id: ticketId,
    from_status: ticket.status,
    to_status: 'completed',
    count: evidenceIds.length,
  });

  return { ticket: updated, activities: plan };
}

/* ------------------------------------------------------------- activities -- */

/**
 * Appends one human note or evidence pointer to the timeline.
 *
 * `activity_type` is restricted to `CLIENT_ACTIVITY_TYPES`. The transition types are
 * written only by the mutation paths above, because a client that could POST
 * `status_changed` could manufacture a second transition row and make the timeline lie
 * without ever changing a ticket — and the table cannot be corrected afterwards.
 *
 * `actor_profile_id` is the authenticated caller's profile, set by the repository. Every
 * INSERT policy on the table pins it to `current_profile_id()`, so a forged author is
 * refused by the database too.
 */
export async function appendActivity(
  context: MaintenanceContext,
  ticketId: string,
  input: CreateActivityInput,
): Promise<ActivityRow> {
  const { supabase, membership } = context;
  const organizationId = membership.organization.id;

  const ticket = await requireTicket(context, ticketId);

  assertAuthorized(membership, 'create', {
    type: 'maintenance_activity',
    organizationId: ticket.organization_id,
    tenantId: ticket.tenant_id,
    providerId: ticket.assigned_provider_id,
  });

  if (!isClientPostableActivityType(input.activity_type as ActivityType)) {
    throw unprocessable({
      message: 'That activity type is recorded by the system and cannot be posted directly.',
      logFields: {
        reason: 'activity_type_server_written',
        ticket_id: ticketId,
        event: input.activity_type,
      },
    });
  }

  const plan = [
    planClientActivity({
      activityType: input.activity_type,
      description: input.description,
      metadata: (input.metadata ?? {}) as Record<string, JsonValue>,
    }),
  ];

  const [row] = await repository.insertActivities(
    supabase,
    { organizationId, ticketId, actorProfileId: membership.profile.id },
    plan,
  );

  if (!row) {
    throw conflict({
      message: 'The activity could not be recorded.',
      logFields: { reason: 'activity_insert_returned_no_row', ticket_id: ticketId },
    });
  }

  return row;
}

/* ------------------------------------------------------------ form options -- */

/** One entry in the create form's unit picker. */
export interface UnitOption {
  id: string;
  label: string;
}

/**
 * Units the caller may report against, labelled "Property — Unit".
 *
 * Convenience, never authorization. The list comes back RLS-scoped, so each role sees a
 * different set, but `createTicket` re-derives the authorization from an active tenancy
 * regardless of what the picker offered. A picker that was wrong would produce a 422,
 * not an unauthorized ticket.
 */
export async function listReportableUnits(context: MaintenanceContext): Promise<UnitOption[]> {
  const organizationId = context.membership.organization.id;
  const units = await repository.listReportableUnits(context.supabase, organizationId);
  const properties = await repository.listPropertyNames(
    context.supabase,
    organizationId,
    units.map((unit) => unit.property_id),
  );
  const names = new Map(properties.map((property) => [property.id, property.name]));

  return units.map((unit) => ({
    id: unit.id,
    label: `${names.get(unit.property_id) ?? 'Property'} — ${unit.unit_number}`,
  }));
}

/** One entry in the assign form's provider picker. */
export interface ProviderOption {
  id: string;
  label: string;
}

export async function listAssignableProviders(
  context: MaintenanceContext,
): Promise<ProviderOption[]> {
  const providers = await repository.listActiveProviders(
    context.supabase,
    context.membership.organization.id,
  );
  return providers.map((provider) => ({ id: provider.id, label: provider.company_name }));
}

/* ----------------------------------------------------------------- widget -- */

/**
 * Open tickets by priority for the dashboard widget, scoped exactly like the list.
 *
 * Reuses `ticketListScope()` so the widget cannot show a count the list would not show.
 * A widget that counted rows a role may not open would be a disclosure with no route
 * attached to it.
 */
export async function countOpenByPriority(
  context: MaintenanceContext,
): Promise<Record<TicketPriority, number>> {
  const scope = ticketListScope(context.membership, {});
  const counts = await repository.countOpenTicketsByPriority(
    context.supabase,
    scope,
    TICKET_PRIORITIES,
  );

  const result = {} as Record<TicketPriority, number>;
  for (const priority of TICKET_PRIORITIES) result[priority] = counts[priority] ?? 0;
  return result;
}

/* --------------------------------------------------------------- internals -- */

/** The ticket, or a 404. An inaccessible ticket is indistinguishable from an absent one. */
async function requireTicket(context: MaintenanceContext, ticketId: string): Promise<TicketRow> {
  const ticket = await repository.findTicket(
    context.supabase,
    context.membership.organization.id,
    ticketId,
  );
  if (!ticket) {
    throw notFound({
      logFields: { reason: 'ticket_not_found_or_not_visible', ticket_id: ticketId },
    });
  }
  return ticket;
}

/** `properties.owner_member_id`, read only when the caller's role needs it. */
async function ownerMemberIdFor(
  context: MaintenanceContext,
  ticket: TicketRow,
): Promise<string | null> {
  if (context.membership.role !== 'property_owner') return null;
  const property = await repository.findProperty(
    context.supabase,
    context.membership.organization.id,
    ticket.property_id,
  );
  return property?.owner_member_id ?? null;
}

function subjectOf(ticket: TicketRow) {
  return {
    id: ticket.id,
    organization_id: ticket.organization_id,
    status: ticket.status,
    tenant_id: ticket.tenant_id,
    assigned_provider_id: ticket.assigned_provider_id,
  };
}

/**
 * The guarded UPDATE matched no row.
 *
 * Two causes, both a 409. Either a concurrent request already moved the ticket — the
 * optimistic-concurrency case the `eq('status', ...)` guard exists for — or RLS refused
 * the write through a `using` clause, which returns zero rows rather than an error. The
 * second would mean this layer and RLS disagree, so it is logged with its own reason for
 * exactly that reason.
 */
function staleTicket(ticket: TicketRow) {
  return conflict({
    message: 'The ticket changed while this request was in flight. Reload and try again.',
    logFields: {
      reason: 'ticket_update_matched_no_row',
      ticket_id: ticket.id,
      from_status: ticket.status,
    },
  });
}

/** The non-status fields present in a PATCH body. Names only — never values. */
function requestedFields(input: {
  title?: string | undefined;
  description?: string | undefined;
  category?: string | undefined;
  priority?: string | undefined;
}): readonly TicketField[] {
  const fields: TicketField[] = [];
  if (input.title !== undefined) fields.push('title');
  if (input.description !== undefined) fields.push('description');
  if (input.category !== undefined) fields.push('category');
  if (input.priority !== undefined) fields.push('priority');
  return fields;
}
