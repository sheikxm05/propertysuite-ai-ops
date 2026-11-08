/**
 * Which ticket fields each role may write, and which activity types a client may post.
 *
 * `authorize()` in `lib/auth/authorize.ts` answers "may this role update a ticket at
 * all". `canTransition()` answers "may this role drive this edge". Neither answers "may
 * a service provider rewrite the description", and nothing in RLS answers it either:
 * `maintenance_tickets_update_assigned_provider` bounds the *statuses* a provider may
 * write but not the *columns*, because row-level security is row-level. That gap is
 * this module.
 *
 * Both tables below are column and value allowlists, never denylists. A new column on
 * `maintenance_tickets` is unwritable by every role until it is added here, which is
 * the direction a mistake should fail in.
 */

import {
  ACTIVITY_TYPES,
  type ActivityType,
  type MemberRole,
  type TicketStatus,
} from '@shared/index';

/** The subset of `UpdateTicketSchema` keys that are not the status transition. */
export type TicketField = 'title' | 'description' | 'category' | 'priority';

/**
 * Staff own triage: the text, the classification and the priority.
 *
 * A staff `priority` write is taken literally rather than passed through
 * `resolvePriority()`. That is deliberate and is what `CreateTicketSchema` describes:
 * "Staff can still override afterwards through `UpdateTicketSchema`, which is an
 * authorized human action and writes an audit row." The deterministic policy exists to
 * stop *untrusted* input choosing a priority — a manager is not untrusted input.
 */
const STAFF_FIELDS: readonly TicketField[] = ['title', 'description', 'category', 'priority'];

/**
 * The reporting tenant may correct their own report while nobody has started work.
 *
 * Not `priority`: a tenant's view of urgency is an input to `resolvePriority()`, never a
 * decision (`CreateTicketSchema`: "a tenant marking everything `urgent` therefore does
 * not make everything urgent"). Letting a tenant PATCH `priority` would hand them
 * exactly the control the deterministic policy is built to withhold.
 */
const TENANT_FIELDS_WHILE_OPEN: readonly TicketField[] = ['title', 'description', 'category'];

/**
 * A provider writes no ticket fields at all. Their contribution to the record is the
 * status they drive and the activity rows they append, both of which are evidential.
 * Allowing them to edit the description would let them rewrite the complaint they are
 * being judged against.
 */
const PROVIDER_FIELDS: readonly TicketField[] = [];

/**
 * The ticket fields `role` may write, given the ticket's current status.
 *
 * Status is a parameter because the tenant's permission is state-dependent, the same way
 * their cancel permission is: once a provider is assigned, the report is no longer the
 * tenant's to reword.
 */
export function writableTicketFields(
  role: MemberRole,
  currentStatus: TicketStatus,
): readonly TicketField[] {
  switch (role) {
    case 'organization_admin':
    case 'property_manager':
      return STAFF_FIELDS;
    case 'tenant':
      return currentStatus === 'open' ? TENANT_FIELDS_WHILE_OPEN : [];
    case 'service_provider':
      return PROVIDER_FIELDS;
    case 'property_owner':
      // Read-only on tickets in the §4 matrix.
      return [];
  }
}

/**
 * Activity types a mutation route writes, and that a client therefore may NOT post.
 *
 * `maintenance_activities` is append-only — `0002` revokes UPDATE and DELETE and
 * `0003`'s trigger binds even the table owner, so a forged row can never be corrected,
 * only contradicted by a later one. The exit gate for this lane is "exactly one activity
 * row per transition", and a client that could POST `status_changed` could manufacture a
 * second one and make the timeline lie without ever changing a ticket.
 *
 * Derived by subtraction from `ACTIVITY_TYPES` so that a new shared activity type is
 * client-postable only if it is deliberately added to `CLIENT_ACTIVITY_TYPES`.
 */
export const SERVER_WRITTEN_ACTIVITY_TYPES: readonly ActivityType[] = Object.freeze([
  'ticket_created',
  'status_changed',
  'provider_assigned',
  'completion_confirmed',
  'ticket_cancelled',
  'priority_changed',
]);

/** What a human may add to the timeline directly: a note, or a pointer to evidence. */
export const CLIENT_ACTIVITY_TYPES: readonly ActivityType[] = Object.freeze(
  ACTIVITY_TYPES.filter((type) => !SERVER_WRITTEN_ACTIVITY_TYPES.includes(type)),
);

export function isClientPostableActivityType(type: ActivityType): boolean {
  return CLIENT_ACTIVITY_TYPES.includes(type);
}
