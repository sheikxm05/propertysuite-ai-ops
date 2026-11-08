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
 * `jobs.status` — the durable job runner table added by migration `0003`
 * (`docs/implementation-plan.md` §5, Sprint 1). `dead_letter` is terminal: a
 * job that exhausts its bounded retries lands there instead of retrying
 * forever.
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'dead_letter',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** `jobs.type` — the job kinds this build enqueues. */
export const JOB_TYPES = ['document_extraction'] as const;
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
