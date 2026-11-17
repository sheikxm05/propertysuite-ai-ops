/**
 * Every controlled string column in `0001_initial_schema.sql` that is enforced
 * by a `check (... in (...))` constraint rather than by a Postgres enum type.
 *
 * These have no generated database enum to mirror, so the constraint lists are
 * transcribed here, column by column, and are the single source for both the
 * Zod schemas and the UI. If a migration changes a check constraint, it changes
 * here in the same wave.
 *
 * No list contains a deleted/removed state: archiving is the only removal
 * mechanism in this application and no tenant-scoped table has a DELETE path.
 */

/** `organizations.status` */
export const ORGANIZATION_STATUSES = ['active', 'suspended'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

/** `organization_members.status` — an `invited` row is a pending invitation. */
export const MEMBER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** `properties.status` — `archived` is the only removal path. */
export const PROPERTY_STATUSES = ['active', 'archived'] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** `property_units.status` */
export const UNIT_STATUSES = ['available', 'occupied', 'inactive'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

/** `tenancies.status` */
export const TENANCY_STATUSES = ['draft', 'active', 'expired', 'terminated'] as const;
export type TenancyStatus = (typeof TENANCY_STATUSES)[number];

/** `service_providers.status` */
export const SERVICE_PROVIDER_STATUSES = ['active', 'inactive'] as const;
export type ServiceProviderStatus = (typeof SERVICE_PROVIDER_STATUSES)[number];

/** `maintenance_tickets.source` */
export const TICKET_SOURCES = ['web', 'whatsapp', 'email', 'admin'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

/** `documents.verification_status` — extraction output is `pending` until a human confirms it. */
export const VERIFICATION_STATUSES = ['pending', 'verified', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * `documents.document_type` — free `text` in SQL; constrained here so that the
 * storage path and the extraction prompt agree on a controlled vocabulary.
 */
export const DOCUMENT_TYPES = [
  'tenancy_contract',
  'title_deed',
  'ejari_certificate',
  'emirates_id',
  'passport',
  'invoice',
  'maintenance_evidence',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** `ai_conversations.channel` */
export const AI_CHANNELS = ['web', 'whatsapp'] as const;
export type AiChannel = (typeof AI_CHANNELS)[number];

/** `ai_messages.sender_type` */
export const AI_SENDER_TYPES = ['user', 'assistant', 'system'] as const;
export type AiSenderType = (typeof AI_SENDER_TYPES)[number];

/** `notifications.channel` */
export const NOTIFICATION_CHANNELS = ['email', 'whatsapp', 'in_app'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** `notifications.status` */
export const NOTIFICATION_STATUSES = ['queued', 'sent', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/**
 * `maintenance_activities.activity_type` — free `text` in SQL; constrained here
 * because the immutable timeline is rendered from these values and a typo would
 * be unfixable by design (the table rejects UPDATE and DELETE).
 */
export const ACTIVITY_TYPES = [
  'ticket_created',
  'status_changed',
  'provider_assigned',
  'comment_added',
  'evidence_attached',
  'completion_confirmed',
  'ticket_cancelled',
  'priority_changed',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * `jobs.status` — transcribed from the `check` constraint on the job runner
 * table created by migration `0003`:
 * `check (status in ('queued', 'running', 'failed', 'dead', 'done'))`.
 *
 * `dead` is the dead-letter state and is terminal: a job that exhausts its
 * bounded retries lands there instead of retrying forever
 * (`docs/requirements.md` §7). `done` is terminal success. `failed` is
 * retryable — it is awaiting its next `next_run_at`.
 */
export const JOB_STATUSES = ['queued', 'running', 'failed', 'dead', 'done'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Terminal job states. Nothing re-runs out of these. */
export const TERMINAL_JOB_STATUSES = ['dead', 'done'] as const satisfies readonly JobStatus[];

/** The dead-letter state. */
export const DEAD_LETTER_JOB_STATUS = 'dead' as const satisfies JobStatus;

/** `organization_invitations.status` — added by migration `0003` (amendment A4). */
export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * `jobs.type` — the job kinds this build enqueues.
 *
 * `whatsapp_inbound` added after Wave 3. `jobs.type` carries no CHECK constraint, so its
 * absence here was invisible at runtime: `inbound-job.ts` wrote `'whatsapp_inbound' as
 * JobType`, the cast silenced the compiler, and the queue worked. A cast that asserts
 * something untrue is the failure, not the symptom -- the union is meant to be the list
 * of kinds that exist, and a reader consulting it would have been told wrongly.
 */
export const JOB_TYPES = ['document_extraction', 'whatsapp_inbound'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Application-level tenancy lifecycle, from `docs/implementation-plan.md` §5
 * Sprint 5 ("draft, active, expired, terminated").
 *
 * Advisory only: unlike the ticket state machine there is no database trigger
 * behind this, so it is enforced server-side in the tenancy service. It lives
 * here so the UI and the API cannot disagree about which transitions to offer.
 * `expired` and `terminated` are terminal.
 */
export const ALLOWED_TENANCY_TRANSITIONS: Readonly<
  Record<TenancyStatus, readonly TenancyStatus[]>
> = Object.freeze({
  draft: Object.freeze(['active', 'terminated'] as const),
  active: Object.freeze(['expired', 'terminated'] as const),
  expired: Object.freeze([] as const),
  terminated: Object.freeze([] as const),
});

export function canTransitionTenancy(from: TenancyStatus, to: TenancyStatus): boolean {
  return ALLOWED_TENANCY_TRANSITIONS[from].includes(to);
}

/**
 * Application-level unit status graph over the `property_units.status` CHECK
 * constraint in `0001`.
 *
 * Lives here, beside the tenancy graph, because two Wave 1 lanes need the same
 * rule and neither can import from the other: w1-l2 owns unit status
 * transitions, and w1-l3 must keep occupancy consistent with the active
 * tenancy, which means it writes `property_units.status` too. Implemented once
 * here, the two cannot drift.
 *
 * Like the tenancy graph and unlike the ticket graph, there is no database
 * trigger behind this — it is enforced server-side. There is no terminal state
 * and no deletion: `inactive` is the archive equivalent for a unit.
 *
 *   available -> occupied      a tenancy begins
 *   available -> inactive      taken out of service (the archive edge)
 *   occupied  -> available     the tenancy ends and the unit is released
 *   inactive  -> available     returned to service
 *
 * Two edges are deliberately absent, and both preserve the invariant
 * "`inactive` implies no active tenancy":
 *
 *  - `occupied -> inactive`. `inactive` is this table's archive state, and
 *    archiving a unit somebody is living in would strand a live tenancy behind
 *    a status that `reconcileUnitStatus` will never correct, because `inactive`
 *    is sticky. Decommissioning an occupied unit is two deliberate steps in
 *    order: end the tenancy, then archive.
 *  - `inactive -> occupied`, for the mirror reason. A unit must be returned to
 *    service before it can be let, so reactivation is always a visible,
 *    separate decision rather than a side effect of creating a tenancy.
 */
export const ALLOWED_UNIT_TRANSITIONS: Readonly<Record<UnitStatus, readonly UnitStatus[]>> =
  Object.freeze({
    available: Object.freeze(['occupied', 'inactive'] as const),
    occupied: Object.freeze(['available'] as const),
    inactive: Object.freeze(['available'] as const),
  });

export function canTransitionUnit(from: UnitStatus, to: UnitStatus): boolean {
  return ALLOWED_UNIT_TRANSITIONS[from].includes(to);
}

/**
 * What should a unit's status be, given whether it currently has an active
 * tenancy?
 *
 * This — not the edge set — is the rule both lanes actually need to share: w1-l2
 * reaches it from the unit side and w1-l3 from the tenancy side, and they must
 * agree or a unit ends up `available` while someone is living in it.
 *
 * `inactive` is sticky. It is a deliberate staff decision that a unit is not
 * lettable, so an automated reconcile never clears it — otherwise activating a
 * tenancy on a decommissioned unit would quietly put it back into service, and
 * the one status a human explicitly set would be the one the system overrode.
 * Returning a unit to service is always an explicit `inactive -> available`
 * transition.
 *
 * Pure, total and idempotent: `reconcile(x, reconcile(x, s)) === reconcile(x, s)`.
 * The result is always either `current` or a legal transition from it, so a
 * caller can apply it without separately checking `canTransitionUnit`.
 */
export function reconcileUnitStatus(hasActiveTenancy: boolean, current: UnitStatus): UnitStatus {
  if (current === 'inactive') return 'inactive';
  return hasActiveTenancy ? 'occupied' : 'available';
}
