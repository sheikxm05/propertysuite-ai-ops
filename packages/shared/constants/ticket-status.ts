import type { MemberRole } from './roles';

/**
 * Maintenance ticket statuses and the ticket state machine.
 *
 * `TICKET_STATUSES` and `TICKET_PRIORITIES` mirror the Postgres enums
 * `public.ticket_status` and `public.ticket_priority` from
 * `0001_initial_schema.sql`, in declaration order. `constants/enum-parity.ts`
 * fails the build if they drift from `types/database.ts`.
 *
 * `ALLOWED_TRANSITIONS` and `TRANSITION_ROLES` encode
 * `docs/implementation-plan.md` §4 "Ticket state machine", plus the
 * orchestrator's spec ruling on the two questions §4 left open (who may cancel,
 * and the rework edge) — see `TRANSITION_ROLES` below for both.
 * The UI, the API handlers, the unit tests and the RLS/state-machine suite all
 * import this one rule set, and the database trigger delivered by lane w0-l3
 * enforces the same graph. There must be exactly one place this rule lives.
 */
export const TICKET_STATUSES = [
  'open',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'completed',
  'cancelled',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Database defaults for `maintenance_tickets`. */
export const DEFAULT_TICKET_STATUS = 'open' as const satisfies TicketStatus;
export const DEFAULT_TICKET_PRIORITY = 'normal' as const satisfies TicketPriority;

/** States with no outbound transition. §4: `cancelled` is reachable only from a non-terminal state. */
export const TERMINAL_TICKET_STATUSES = [
  'completed',
  'cancelled',
] as const satisfies readonly TicketStatus[];

export type TerminalTicketStatus = (typeof TERMINAL_TICKET_STATUSES)[number];

/**
 * Comparable rank for priorities. Priorities are ordered, so compare by rank
 * rather than by string, and never persist the rank — persist the label.
 */
export const PRIORITY_RANK: Readonly<Record<TicketPriority, number>> = Object.freeze({
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
});

/**
 * The status graph:
 *
 *   open -> assigned -> in_progress -> awaiting_approval -> completed
 *                            ^________________|
 *
 * with `cancelled` reachable from any non-terminal state, and a rework edge
 * `awaiting_approval -> in_progress`.
 *
 * §4 states the linear chain and the `cancelled` rule. The rework edge comes
 * from the orchestrator's spec ruling closing a hole in §4: without it, a
 * manager who rejects the completion evidence can only cancel, which discards
 * real work and corrupts completion statistics. Lane w0-l3's trigger encodes
 * the same graph.
 *
 * Still deliberately absent: any un-assign edge (`assigned -> open`) and any
 * reopen edge out of a terminal state. Adding one is a specification change,
 * not a code change.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> =
  Object.freeze({
    open: Object.freeze(['assigned', 'cancelled'] as const),
    assigned: Object.freeze(['in_progress', 'cancelled'] as const),
    in_progress: Object.freeze(['awaiting_approval', 'cancelled'] as const),
    awaiting_approval: Object.freeze(['completed', 'in_progress', 'cancelled'] as const),
    completed: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
  });

/**
 * Which roles may drive each legal edge. Derived from the §4 policy matrix, the
 * two explicit sentences in §4's state-machine paragraph, and the
 * orchestrator's ruling on the two points §4 left silent.
 *
 * From §4:
 *  - "A service provider may only drive `assigned -> in_progress ->
 *    awaiting_approval`" — a provider can never assign, cancel, rework or
 *    complete. In particular a provider cannot approve its own work.
 *  - "only a manager or the reporting tenant may close to `completed`".
 *
 * From the ruling:
 *  - Cancellation: `organization_admin` and `property_manager` may cancel from
 *    any non-terminal state. The reporting tenant may cancel their own ticket
 *    only while it is still `open` — once a provider is assigned, work may have
 *    been scheduled and the cancellation is no longer the tenant's to make.
 *    A provider may never cancel.
 *  - Rework (`awaiting_approval -> in_progress`): staff only.
 *
 * `property_owner` is read-only on tickets in the §4 matrix and so appears on
 * no edge.
 *
 * IMPORTANT — this table answers the ROLE question only. `tenant` appearing on
 * `open -> cancelled` and on `awaiting_approval -> completed` means "a tenant
 * may drive this edge on a ticket that is theirs". Ownership is a separate
 * check: the caller must also confirm the ticket's `tenant_id` resolves to the
 * caller via `current_tenant_id(org)`. `canTransition` cannot verify that — it
 * is pure and sees no row. RLS enforces it independently as the second layer.
 */
export const TRANSITION_ROLES: Readonly<
  Record<TicketStatus, Readonly<Partial<Record<TicketStatus, readonly MemberRole[]>>>>
> = Object.freeze({
  open: Object.freeze({
    assigned: Object.freeze(['organization_admin', 'property_manager'] as const),
    // The reporting tenant may withdraw a request that nobody has started yet.
    cancelled: Object.freeze(['organization_admin', 'property_manager', 'tenant'] as const),
  }),
  assigned: Object.freeze({
    in_progress: Object.freeze([
      'organization_admin',
      'property_manager',
      'service_provider',
    ] as const),
    cancelled: Object.freeze(['organization_admin', 'property_manager'] as const),
  }),
  in_progress: Object.freeze({
    awaiting_approval: Object.freeze([
      'organization_admin',
      'property_manager',
      'service_provider',
    ] as const),
    cancelled: Object.freeze(['organization_admin', 'property_manager'] as const),
  }),
  awaiting_approval: Object.freeze({
    completed: Object.freeze(['organization_admin', 'property_manager', 'tenant'] as const),
    // Rework: the evidence was rejected, so the job goes back to the provider.
    in_progress: Object.freeze(['organization_admin', 'property_manager'] as const),
    cancelled: Object.freeze(['organization_admin', 'property_manager'] as const),
  }),
  completed: Object.freeze({}),
  cancelled: Object.freeze({}),
});

/** Roles permitted to create a ticket. §4: tenants create their own; staff create on their behalf. */
export const TICKET_CREATE_ROLES = [
  'organization_admin',
  'property_manager',
  'tenant',
] as const satisfies readonly MemberRole[];

export function isTicketStatus(value: unknown): value is TicketStatus {
  return typeof value === 'string' && (TICKET_STATUSES as readonly string[]).includes(value);
}

export function isTicketPriority(value: unknown): value is TicketPriority {
  return typeof value === 'string' && (TICKET_PRIORITIES as readonly string[]).includes(value);
}

export function isTerminalTicketStatus(status: TicketStatus): status is TerminalTicketStatus {
  return (TERMINAL_TICKET_STATUSES as readonly TicketStatus[]).includes(status);
}

/**
 * Does the edge exist in the state graph, ignoring who is asking?
 *
 * This is the question the database trigger answers. An edge that fails here
 * is a conflict with the resource's current state and maps to `409 CONFLICT`.
 */
export function isAllowedTransition(from: TicketStatus, to: TicketStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * May `role` move a ticket from `from` to `to`?
 *
 * Both questions at once: the edge must exist AND the role must be permitted to
 * drive it. `role` is required — an authorization check that is easy to forget
 * is an authorization check that gets forgotten. Use `isAllowedTransition` when
 * you genuinely mean "is this edge legal for anyone".
 *
 * Pure: no I/O, no clock, no ambient state.
 *
 * Callers distinguishing status codes should test in this order:
 *   !isAllowedTransition(from, to)        -> 409 CONFLICT
 *   !canTransition(from, to, role)        -> 403 FORBIDDEN
 */
export function canTransition(from: TicketStatus, to: TicketStatus, role: MemberRole): boolean {
  if (!isAllowedTransition(from, to)) return false;
  const permitted = TRANSITION_ROLES[from][to];
  return permitted !== undefined && permitted.includes(role);
}

/** Every status `role` may move a ticket to from `from`. Drives which buttons the UI renders. */
export function allowedTransitionsFor(
  from: TicketStatus,
  role: MemberRole,
): readonly TicketStatus[] {
  return ALLOWED_TRANSITIONS[from].filter((to) => canTransition(from, to, role));
}

/** Negative rank ordering: `-1` when `a` is lower priority than `b`, `0` equal, `1` higher. */
export function comparePriority(a: TicketPriority, b: TicketPriority): -1 | 0 | 1 {
  const left = PRIORITY_RANK[a];
  const right = PRIORITY_RANK[b];
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** The higher of two priorities. Used to apply a floor without ever downgrading. */
export function maxPriority(a: TicketPriority, b: TicketPriority): TicketPriority {
  return PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}
