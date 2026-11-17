/**
 * Who sees what in the inbox.
 *
 * Three audiences, one query shape:
 *
 *   staff (organization_admin, property_manager)
 *       the whole organization's inbound queue, and nothing outside it
 *   tenant
 *       messages sent from their own number, and nothing else — a tenant reading a
 *       neighbour's maintenance complaint is exactly the role boundary this product
 *       claims to hold
 *   property_owner, service_provider
 *       nothing. An owner is a read-only stakeholder in an asset and a provider sees
 *       assigned jobs; neither is a party to the conversation that precedes a ticket
 *
 * The narrowing is a FILTER, not a 403. An empty list discloses nothing; a 403 would
 * disclose that a populated inbox exists for other people. That is the same reasoning
 * `features/maintenance` applies to its ticket list, and the two screens should not
 * disagree about what "not for you" looks like.
 *
 * This is the second of three layers. RLS on `inbound_messages` denies independently in
 * Postgres, and the route re-derives the role from `ctx.membership` on every request. If
 * this file were deleted, no row would become reachable — it decides what to *ask* for,
 * not what is *allowed*.
 */

import { STAFF_ROLES, type MemberRole } from '@shared/index';

/** What the caller's role entitles them to see. */
export type InboxAudience = 'organization' | 'own-number' | 'none';

export function audienceFor(role: MemberRole): InboxAudience {
  if ((STAFF_ROLES as readonly MemberRole[]).includes(role)) return 'organization';
  if (role === 'tenant') return 'own-number';
  return 'none';
}

/** Whether this role may push a message into the ingestion pipeline from the browser. */
export function maySimulate(role: MemberRole): boolean {
  return audienceFor(role) !== 'none';
}

/**
 * Whether this role may commit a message into a ticket.
 *
 * Staff only, here. A tenant can report an issue — `POST /api/v1/maintenance/tickets`
 * accepts them, and the AI intake flow at `/maintenance/new` is built for exactly that —
 * but the inbox commits a ticket *on behalf of* the sender, deriving the unit from the
 * matched tenancy rather than from the caller's own. That is an operator's action, and
 * `TICKET_CREATE_ROLES` would be too wide a gate for it.
 */
export function mayCommitTicket(role: MemberRole): boolean {
  return audienceFor(role) === 'organization';
}

/**
 * Whether to render the Approve and Reject buttons on an agent proposal.
 *
 * Presentation only. The decision itself is posted to lane w3-l4's endpoints, which are
 * gated on `STAFF_ROLES` and backed by a security-definer RPC that checks `is_org_staff`
 * itself. This answers "should the buttons be there", not "is this allowed" — hiding a
 * control is a courtesy, and the refusal underneath it is the boundary.
 */
export function mayDecideProposal(role: MemberRole): boolean {
  return audienceFor(role) === 'organization';
}
