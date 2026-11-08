/**
 * Read scoping for the ticket list — the server-side half of role filtering.
 *
 * Every predicate here is also a row-level security policy on `maintenance_tickets`
 * (`maintenance_tickets_select_staff`, `_select_owner`, `_select_own_tenant`,
 * `_select_assigned_provider`). That duplication is the project's central claim: this
 * layer denies on the assumption RLS has a bug, and RLS denies on the assumption this
 * function was never called.
 *
 * The function is pure. It takes the caller's trusted `Membership` and the validated
 * query and returns the filters the repository must apply — no client, no I/O, no
 * clock. That is what makes the role-filtering rules exhaustively testable without a
 * database, which matters because they are acceptance criteria 2 and 7 rather than a
 * convenience.
 *
 * Two rules worth stating because they are easy to get subtly wrong:
 *
 *  1. `organization_id` is ALWAYS pinned, for every role, from
 *     `membership.organization.id` — a value derived from trusted rows by
 *     `resolveMembership()` and never from the request (CLAUDE.md rule 5). A list route
 *     that relied on RLS alone for the organization predicate would be one policy
 *     regression away from a cross-organization read.
 *  2. A filter a caller is not entitled to does NOT widen their scope and does NOT
 *     raise an error. A provider asking for another provider's queue, or for `open`
 *     tickets they may never touch, gets an empty page — `impossible`. An error would
 *     confirm that the other provider exists; an empty page discloses nothing. This is
 *     the same choice `packages/shared` documents for `ListTicketsQuerySchema`:
 *     "Passing another provider's id returns an empty list, which discloses nothing."
 */

import type { ListTicketsQuery, TicketStatus } from '@shared/index';

import type { Membership } from '@/lib/auth/roles';

import { PROVIDER_JOB_STATUSES } from './transitions';

/** Equality filters plus an optional status set, ready for the repository to apply. */
export interface TicketQueryScope {
  /** `column -> value`, applied with `.eq()`. Always contains `organization_id`. */
  readonly equals: Readonly<Record<string, string>>;
  /** Applied with `.in('status', ...)`. `null` means no status restriction. */
  readonly statusIn: readonly TicketStatus[] | null;
  /** The caller's entitlement and their filters cannot both hold: serve an empty page. */
  readonly impossible: boolean;
  /** Stable `snake_case` reason. Logged, never returned to the client. */
  readonly reason: string;
}

/**
 * The columns a caller may filter on. Anything outside this set is already rejected by
 * `ListTicketsQuerySchema.strict()`; the map exists so the repository never interpolates
 * a key that did not come from this file.
 */
const FILTERABLE: readonly (keyof ListTicketsQuery)[] = [
  'priority',
  'category',
  'property_id',
  'property_unit_id',
];

/**
 * Builds the scope for one list request.
 *
 * Role by role, mirroring the §4 matrix:
 *
 *  - `organization_admin`, `property_manager` — the whole organization. Their filters
 *    pass through unchanged.
 *  - `property_owner` — tickets on properties they own. There is no `owner_member_id`
 *    on a ticket to filter by, so the narrowing is `owns_property()` inside
 *    `maintenance_tickets_select_owner`. This is the one role whose row scope rests on
 *    RLS alone, which is why the detail route re-checks `ownerMemberId` against the
 *    property row in application space.
 *  - `tenant` — their own reported tickets, pinned by `tenants.id` resolved from their
 *    profile. A tenant with no tenant record in this organization sees nothing.
 *  - `service_provider` — assigned work only, and only within
 *    `PROVIDER_JOB_STATUSES`, which is derived from the shared `TRANSITION_ROLES`
 *    table rather than listed here.
 */
export function ticketListScope(
  membership: Membership,
  query: Pick<
    ListTicketsQuery,
    'status' | 'priority' | 'category' | 'property_id' | 'property_unit_id' | 'assigned_provider_id'
  >,
): TicketQueryScope {
  const equals: Record<string, string> = { organization_id: membership.organization.id };

  for (const column of FILTERABLE) {
    const value = query[column as keyof typeof query];
    if (typeof value === 'string' && value.length > 0) equals[column] = value;
  }

  switch (membership.role) {
    case 'organization_admin':
    case 'property_manager':
      return staffScope(equals, query);

    case 'property_owner':
      // Owners get no extra equality predicate: ownership is a join through
      // `properties.owner_member_id`, enforced by RLS. Their filters still apply.
      return staffScope(equals, query, 'owner_scope_via_rls');

    case 'tenant':
      if (membership.tenantId === null) {
        return impossible(equals, 'tenant_without_tenant_record');
      }
      equals.tenant_id = membership.tenantId;
      return staffScope(equals, query, 'own_tickets_only');

    case 'service_provider':
      return providerScope(equals, query, membership.providerId);
  }
}

/* ---------------------------------------------------------------- per role -- */

function staffScope(
  equals: Record<string, string>,
  query: { status?: TicketStatus | undefined; assigned_provider_id?: string | undefined },
  reason = 'organization_scope',
): TicketQueryScope {
  if (query.assigned_provider_id) equals.assigned_provider_id = query.assigned_provider_id;
  return {
    equals: Object.freeze({ ...equals }),
    statusIn: query.status ? Object.freeze([query.status]) : null,
    impossible: false,
    reason,
  };
}

/**
 * Acceptance criterion 7, in application space.
 *
 * Three independent reasons a provider sees nothing, all of them empty pages rather
 * than errors: they hold no provider record in this organization; they asked for
 * someone else's queue; or they asked for a status outside the subset they may act on.
 */
function providerScope(
  equals: Record<string, string>,
  query: { status?: TicketStatus | undefined; assigned_provider_id?: string | undefined },
  providerId: string | null,
): TicketQueryScope {
  if (providerId === null) {
    return impossible(equals, 'provider_without_provider_record');
  }

  if (query.assigned_provider_id && query.assigned_provider_id !== providerId) {
    return impossible(equals, 'provider_requested_another_queue');
  }

  // Pinned from trusted membership, never from `query.assigned_provider_id`, even when
  // the two agree — so a future change to the query schema cannot widen this.
  equals.assigned_provider_id = providerId;

  if (query.status) {
    if (!PROVIDER_JOB_STATUSES.includes(query.status)) {
      return impossible(equals, 'provider_requested_unpermitted_status');
    }
    return {
      equals: Object.freeze({ ...equals }),
      statusIn: Object.freeze([query.status]),
      impossible: false,
      reason: 'assigned_work_only',
    };
  }

  return {
    equals: Object.freeze({ ...equals }),
    statusIn: PROVIDER_JOB_STATUSES,
    impossible: false,
    reason: 'assigned_work_only',
  };
}

function impossible(equals: Record<string, string>, reason: string): TicketQueryScope {
  return {
    equals: Object.freeze({ ...equals }),
    statusIn: Object.freeze([]),
    impossible: true,
    reason,
  };
}
