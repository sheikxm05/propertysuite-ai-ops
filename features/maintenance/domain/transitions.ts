/**
 * The ticket state machine, third enforcement point.
 *
 * The rule set lives in THREE places that must agree exactly:
 *
 *   1. `ALLOWED_TRANSITIONS` + `TRANSITION_ROLES` + `canTransition` in `packages/shared`
 *   2. `public.enforce_ticket_transition()` — the trigger in migration `0003`
 *   3. this module, the domain service
 *
 * This lane owns only the third, and it owns it by **importing** the first. There is no
 * `switch` on status below and no role list: every verdict is produced by
 * `isAllowedTransition` and `canTransition` from `@shared/index`. A hand-rolled copy
 * would be a fourth definition and the first one to drift (CLAUDE.md rule 4).
 *
 * What this module adds that `canTransition` structurally cannot: `canTransition` is
 * pure and never sees a row, so it answers the ROLE question only. "A tenant may drive
 * `open -> cancelled`" means "on a ticket that is theirs", and "a provider may drive
 * `assigned -> in_progress`" means "on a ticket assigned to them". Those are row facts.
 * `classifyTicketTransition` binds the role verdict to the row.
 *
 * The three outcomes map to three different status codes, and the ORDER they are tested
 * in is part of the contract — it is the order `packages/shared` documents and the order
 * `0003` raises in:
 *
 *   edge does not exist in the graph  -> CONFLICT      409   (P0001 from the trigger)
 *   edge exists, role may not drive it -> FORBIDDEN     403   (42501 from the trigger)
 *   role may drive it, but not this row -> FORBIDDEN    403   (RLS: zero rows updated)
 *
 * Testing them in the other order would leak the graph to a caller who is not permitted
 * to drive any of it: a provider probing `completed -> open` would learn whether the
 * edge exists from the status code.
 */

import {
  ALLOWED_TRANSITIONS,
  TICKET_STATUSES,
  TRANSITION_ROLES,
  allowedTransitionsFor,
  canTransition,
  isAllowedTransition,
  isTerminalTicketStatus,
  type ActivityType,
  type MemberRole,
  type TicketStatus,
} from '@shared/index';

import { conflict, forbidden } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';

/**
 * The row facts a transition decision needs. A narrow projection of
 * `maintenance_tickets` on purpose: a function that accepted the whole row could
 * accidentally come to depend on a column the caller had not read.
 */
export interface TransitionSubject {
  readonly id: string;
  readonly organization_id: string;
  readonly status: TicketStatus;
  readonly tenant_id: string;
  readonly assigned_provider_id: string | null;
}

export type TransitionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'invalid_edge'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'role_forbidden'; readonly reason: string }
  | { readonly ok: false; readonly kind: 'row_forbidden'; readonly reason: string };

const OK: TransitionVerdict = { ok: true };

/* ------------------------------------------------------------ graph queries -- */

/**
 * Does the edge exist, ignoring who is asking? Delegates to the shared predicate.
 *
 * Re-exported so a caller never has to decide between "the shared one" and "the local
 * one" — there is only ever the shared one.
 */
export { isAllowedTransition, canTransition, allowedTransitionsFor };

/**
 * The statuses a `service_provider` is permitted to be involved with, DERIVED from
 * `TRANSITION_ROLES` rather than listed.
 *
 * §4 says a provider "may only drive `assigned -> in_progress -> awaiting_approval`",
 * which is a statement about edges. The provider job list needs it as a statement about
 * statuses, so it is computed: every status that appears as the source or the
 * destination of an edge a provider may drive. Deriving it means adding or removing a
 * provider edge in `packages/shared` updates the job list automatically, and the two
 * can never disagree.
 */
export const PROVIDER_JOB_STATUSES: readonly TicketStatus[] = Object.freeze(
  TICKET_STATUSES.filter((status) => providerTouchedStatuses().has(status)),
);

/**
 * Coarse route gates, read out of `TRANSITION_ROLES` rather than written out.
 *
 * `withApiHandler`'s `roles` option stops a request before its body is parsed, which is
 * why a 403 for the wrong role does not depend on a well-formed body (§5.2). It is a
 * convenience gate, not the enforcement point: `assertTicketTransition` consults the
 * same table against the actual row afterwards, and `0003`'s trigger consults its own
 * copy after that. If one of these lists were ever empty the wrapper would wave the
 * request through — and `canTransition` would then deny it, so the pair fails closed.
 */
export const TICKET_ASSIGN_ROLES: readonly MemberRole[] = TRANSITION_ROLES.open.assigned ?? [];
export const TICKET_COMPLETE_ROLES: readonly MemberRole[] =
  TRANSITION_ROLES.awaiting_approval.completed ?? [];

/**
 * Every role that may drive at least one edge, and therefore the coarse gate for PATCH.
 * `property_owner` is absent because it appears on no edge in `TRANSITION_ROLES` — the
 * §4 matrix makes an owner read-only on tickets.
 */
export const TICKET_TRANSITION_ROLES: readonly MemberRole[] = Object.freeze(rolesOnAnyEdge());

function rolesOnAnyEdge(): MemberRole[] {
  const roles = new Set<MemberRole>();
  for (const from of TICKET_STATUSES) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      for (const role of TRANSITION_ROLES[from][to] ?? []) roles.add(role);
    }
  }
  return [...roles];
}

function providerTouchedStatuses(): ReadonlySet<TicketStatus> {
  const touched = new Set<TicketStatus>();
  for (const from of TICKET_STATUSES) {
    for (const to of ALLOWED_TRANSITIONS[from]) {
      if (TRANSITION_ROLES[from][to]?.includes('service_provider')) {
        touched.add(from);
        touched.add(to);
      }
    }
  }
  return touched;
}

/* -------------------------------------------------------------- the verdict -- */

/**
 * The role-and-graph half of the question. Thin, but named, because the distinction
 * between `invalid_edge` and `role_forbidden` is the distinction between 409 and 403.
 */
export function classifyTransition(
  from: TicketStatus,
  to: TicketStatus,
  role: MemberRole,
): TransitionVerdict {
  if (from === to) {
    return { ok: false, kind: 'invalid_edge', reason: 'ticket_status_unchanged' };
  }
  if (!isAllowedTransition(from, to)) {
    return { ok: false, kind: 'invalid_edge', reason: 'ticket_status_transition_invalid' };
  }
  if (!canTransition(from, to, role)) {
    return {
      ok: false,
      kind: 'role_forbidden',
      reason: 'ticket_status_transition_forbidden_for_role',
    };
  }
  return OK;
}

/**
 * The full question: may this caller drive this ticket to `to`?
 *
 * The row binding, after the role verdict:
 *
 *  - a `tenant` may only act on the ticket they reported (`tenant_id`);
 *  - a `service_provider` may only act on a ticket assigned to their own provider
 *    record, which is also why a provider can never act on unassigned work;
 *  - staff are bound by the organization, which `authorize()` has already checked
 *    against the row's own `organization_id` before this is called.
 *
 * Both checks are repeated by RLS and by `0003`'s trigger. This layer exists so the
 * denial happens before the query and carries a reason the log can record.
 */
export function classifyTicketTransition(
  ticket: TransitionSubject,
  to: TicketStatus,
  membership: Membership,
): TransitionVerdict {
  const verdict = classifyTransition(ticket.status, to, membership.role);
  if (!verdict.ok) return verdict;

  if (membership.role === 'tenant') {
    if (membership.tenantId === null || ticket.tenant_id !== membership.tenantId) {
      return { ok: false, kind: 'row_forbidden', reason: 'not_the_reporting_tenant' };
    }
  }

  if (membership.role === 'service_provider') {
    if (
      membership.providerId === null ||
      ticket.assigned_provider_id === null ||
      ticket.assigned_provider_id !== membership.providerId
    ) {
      return { ok: false, kind: 'row_forbidden', reason: 'not_the_assigned_provider' };
    }
  }

  return OK;
}

/**
 * `classifyTicketTransition`, as an assertion.
 *
 * `conflict()` for a non-existent edge and `forbidden()` for everything else, so the two
 * reasons a transition is refused never share a status code. The public message names
 * the states for a conflict (the caller can see the ticket's status, so this discloses
 * nothing) and says nothing at all for a denial.
 */
export function assertTicketTransition(
  ticket: TransitionSubject,
  to: TicketStatus,
  membership: Membership,
): void {
  const verdict = classifyTicketTransition(ticket, to, membership);
  if (verdict.ok) return;

  if (verdict.kind === 'invalid_edge') {
    throw conflict({
      message: `A ticket cannot move from ${ticket.status} to ${to}.`,
      logFields: {
        reason: verdict.reason,
        ticket_id: ticket.id,
        from_status: ticket.status,
        to_status: to,
      },
    });
  }

  throw forbidden({
    logFields: {
      reason: verdict.reason,
      ticket_id: ticket.id,
      from_status: ticket.status,
      to_status: to,
      role: membership.role,
    },
  });
}

/* ------------------------------------------------------------- presentation -- */

/**
 * The transitions this caller may drive on this ticket, for rendering buttons.
 *
 * Computed from the same rule set the server enforces, with the same row binding, so
 * the UI cannot offer an action that the API will refuse — and, more importantly, cannot
 * hide one it would permit and thereby become the only thing enforcing a rule.
 */
export function availableTransitions(
  ticket: TransitionSubject,
  membership: Membership,
): readonly TicketStatus[] {
  if (isTerminalTicketStatus(ticket.status)) return [];
  return ALLOWED_TRANSITIONS[ticket.status].filter(
    (to) => classifyTicketTransition(ticket, to, membership).ok,
  );
}

/**
 * The single activity type that records an edge.
 *
 * Exactly one activity row is written per transition, and this decides its type. The
 * types come from `ACTIVITY_TYPES` in `packages/shared`; the mapping is here because it
 * is a presentation decision about the timeline, not part of the state machine.
 *
 * `assigned` maps to `provider_assigned` because the only edge into `assigned` is the
 * assignment itself, so a separate `status_changed` row would double-count it.
 */
export function transitionActivityType(to: TicketStatus): ActivityType {
  switch (to) {
    case 'assigned':
      return 'provider_assigned';
    case 'completed':
      return 'completion_confirmed';
    case 'cancelled':
      return 'ticket_cancelled';
    default:
      return 'status_changed';
  }
}
