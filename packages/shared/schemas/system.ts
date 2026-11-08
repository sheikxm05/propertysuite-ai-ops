import { z } from 'zod';

import { JOB_STATUSES, NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES } from '../constants/statuses';
import {
  IsoDateTimeSchema,
  MetadataSchema,
  PaginationQuerySchema,
  UuidSchema,
  boundedText,
  listResponseSchema,
  optionalQueryParam,
  resourceResponseSchema,
} from './primitives';

/**
 * Surfaces that are in scope but own no §5.5 route prefix of their own:
 * in-app notifications, the audit log view, the job queue and the health check.
 *
 * They live here because the lanes that will build them — `/api/health` is
 * W2-L4, the audit review is W2-L3, notifications sit with the dashboards in
 * W2-L5 — cannot add an export to this package once Wave 0 has merged. Defining
 * them now costs little and removes a Wave 2 blocker.
 */

export const NotificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export const NotificationStatusSchema = z.enum(NOTIFICATION_STATUSES);

/* -------------------------------------------------------------------------- */
/* Notifications                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A notification. Every role reads only its own (§4: `notifications` is
 * `R own` for all five roles).
 *
 * `payload` is bounded metadata, not message content: a notification carries
 * the identifiers needed to build a link, so that rendering it re-reads the
 * underlying row through RLS rather than trusting a snapshot taken when the
 * notification was queued. A payload that embedded the ticket description would
 * survive a later permission change.
 */
export const NotificationSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    recipient_profile_id: UuidSchema.nullable(),
    channel: NotificationChannelSchema,
    event_type: boundedText(1, 80),
    payload: MetadataSchema,
    status: NotificationStatusSchema,
    retry_count: z.number().int().min(0),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Notification = z.infer<typeof NotificationSchema>;

/** `GET /api/v1/notifications?cursor=&limit=&status=&channel=` */
export const ListNotificationsQuerySchema = PaginationQuerySchema.extend({
  status: optionalQueryParam(NotificationStatusSchema),
  channel: optionalQueryParam(NotificationChannelSchema),
}).strict();

export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

export const NotificationResponseSchema = resourceResponseSchema(NotificationSchema);
export const NotificationListResponseSchema = listResponseSchema(NotificationSchema);

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An audit row as an organization administrator sees it. §4 restricts
 * `audit_logs` reads to `organization_admin` and grants no other role any
 * access at all.
 *
 * Append-only: there is no create or update schema here, because nothing but
 * `log_audit()` writes this table.
 */
export const AuditLogSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    actor_profile_id: UuidSchema.nullable(),
    action: boundedText(1, 80),
    entity_type: boundedText(1, 80),
    entity_id: UuidSchema.nullable(),
    metadata: MetadataSchema,
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type AuditLog = z.infer<typeof AuditLogSchema>;

/** `GET /api/v1/audit-logs?cursor=&limit=&action=&entity_type=&entity_id=` */
export const ListAuditLogsQuerySchema = PaginationQuerySchema.extend({
  action: optionalQueryParam(boundedText(1, 80)),
  entity_type: optionalQueryParam(boundedText(1, 80)),
  entity_id: optionalQueryParam(UuidSchema),
}).strict();

export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;

export const AuditLogListResponseSchema = listResponseSchema(AuditLogSchema);

/* -------------------------------------------------------------------------- */
/* Job queue                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A job row, for the runner and for an operational view.
 *
 * The `jobs` table has RLS enabled with no policies, so it is reachable only by
 * the service role. `last_error` is a diagnostic string and must never contain
 * document text — the extraction worker is responsible for truncating and
 * sanitising what it writes there.
 */
export const JobSchema = z
  .object({
    id: UuidSchema,
    type: boundedText(1, 80),
    payload: MetadataSchema,
    idempotency_key: boundedText(1, 200).nullable(),
    attempts: z.number().int().min(0),
    next_run_at: IsoDateTimeSchema.nullable(),
    status: z.enum(JOB_STATUSES),
    last_error: boundedText(1, 2000).nullable(),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Job = z.infer<typeof JobSchema>;

/* -------------------------------------------------------------------------- */
/* Health                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `GET /api/health` (W2-L4).
 *
 * Deliberately uninformative to an unauthenticated caller: a status, a
 * timestamp and a build identifier. No version strings for dependencies, no
 * database hostname, no migration state, no error detail — a health endpoint is
 * the most-scanned route on any deployment and must not become a
 * reconnaissance surface.
 */
export const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    timestamp: IsoDateTimeSchema,
    build: boundedText(1, 40).optional(),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
