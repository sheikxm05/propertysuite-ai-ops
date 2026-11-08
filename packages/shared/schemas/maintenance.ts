import { z } from 'zod';

import { MAINTENANCE_CATEGORIES } from '../constants/categories';
import { ACTIVITY_TYPES, TICKET_SOURCES } from '../constants/statuses';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '../constants/ticket-status';
import {
  ConfirmationSchema,
  DescriptionSchema,
  IsoDateTimeSchema,
  MetadataSchema,
  NoteSchema,
  PaginationQuerySchema,
  TitleSchema,
  UuidSchema,
  boundedText,
  listResponseSchema,
  optionalQueryParam,
  resourceResponseSchema,
} from './primitives';
import { TenantNameSchema } from './tenant';

/**
 * Maintenance tickets and the immutable activity timeline.
 *
 * Routes: `/api/v1/maintenance/*` (lane w1-l4).
 *
 * Server-derived, and therefore absent from every request schema here:
 * `organization_id`, `property_id`, `tenancy_id` and `tenant_id`. All four are
 * derived from `property_unit_id` plus the resolved membership. A tenant
 * creating a ticket names only the unit; the server resolves which property it
 * belongs to, which tenancy is active on it and which tenant row the caller is.
 * A body cannot assert any of them, so a cross-organization or
 * cross-tenant ticket cannot be constructed by request shape alone.
 */

export const MaintenanceCategorySchema = z.enum(MAINTENANCE_CATEGORIES);
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export const TicketSourceSchema = z.enum(TICKET_SOURCES);
export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES);

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/maintenance/tickets`
 *
 * Matches the create-ticket example in `docs/api-contracts.md` field for field:
 *
 * ```json
 * {
 *   "property_unit_id": "uuid",
 *   "title": "Air conditioning not cooling",
 *   "description": "The AC is running but not cooling the room.",
 *   "category": "hvac",
 *   "priority": "normal",
 *   "source": "web"
 * }
 * ```
 *
 * `priority` is a REQUEST, not a decision. The stored priority is whatever
 * `resolvePriority()` returns; this field is one of its inputs. A tenant
 * marking everything `urgent` therefore does not make everything urgent. Staff
 * can still override afterwards through `UpdateTicketSchema`, which is an
 * authorized human action and writes an audit row.
 *
 * `category` defaults to `unknown` — the database default — so a tenant who
 * cannot classify their own problem is not forced to guess.
 */
export const CreateTicketSchema = z
  .object({
    property_unit_id: UuidSchema,
    title: TitleSchema,
    description: DescriptionSchema,
    category: MaintenanceCategorySchema.default('unknown'),
    priority: TicketPrioritySchema.optional(),
    source: TicketSourceSchema.default('web'),
  })
  .strict();

export type CreateTicketInput = z.infer<typeof CreateTicketSchema>;

/**
 * `PATCH /api/v1/maintenance/tickets/{ticketId}`
 *
 * `status` here is the general transition path and must be checked against
 * `canTransition(current, next, role)` before the write — an illegal edge is a
 * 409, an edge the caller's role may not drive is a 403. The database trigger
 * from lane w0-l3 enforces the same graph independently.
 *
 * `assigned_provider_id` is deliberately NOT updatable here. Assignment is its
 * own route (`/assign`) because it is its own authorization decision and its
 * own audit action.
 */
export const UpdateTicketSchema = z
  .object({
    title: TitleSchema.optional(),
    description: DescriptionSchema.optional(),
    category: MaintenanceCategorySchema.optional(),
    priority: TicketPrioritySchema.optional(),
    status: TicketStatusSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>;

/**
 * `POST /api/v1/maintenance/tickets/{ticketId}/assign`
 *
 * `provider_id` is a `service_providers.id` in the caller's own organization,
 * written to `maintenance_tickets.assigned_provider_id`. The composite foreign
 * key `(organization_id, assigned_provider_id)` makes a cross-organization
 * assignment structurally impossible; the handler checks it as well.
 *
 * Assignment drives `open -> assigned`, so only `organization_admin` and
 * `property_manager` may call this (`TRANSITION_ROLES`).
 */
export const AssignTicketSchema = z
  .object({
    provider_id: UuidSchema,
    note: NoteSchema.optional(),
  })
  .strict();

export type AssignTicketInput = z.infer<typeof AssignTicketSchema>;

/**
 * `POST /api/v1/maintenance/tickets/{ticketId}/complete`
 *
 * Drives `awaiting_approval -> completed`, which per §4 only a manager or the
 * reporting tenant may do — a provider cannot approve its own work.
 *
 * `confirmed: true` is required and is a literal, so the close cannot happen by
 * an empty or default-valued body. Completion is the terminal state of a
 * financial-adjacent workflow and there is no reopen edge, so it must be an
 * explicit act.
 */
export const CompleteTicketSchema = z
  .object({
    resolution_summary: boundedText(10, 2000),
    /** Identifiers of already-uploaded evidence documents. Never file content. */
    evidence_document_ids: z.array(UuidSchema).max(10).optional(),
    confirmed: ConfirmationSchema,
  })
  .strict();

export type CompleteTicketInput = z.infer<typeof CompleteTicketSchema>;

/**
 * `POST /api/v1/maintenance/tickets/{ticketId}/activities`
 *
 * `maintenance_activities` is append-only — `0002` revokes UPDATE and DELETE
 * and adds a block trigger, so a row written here can never be edited or
 * removed, not even by the service role. Validate accordingly: there is no
 * correcting a mistake later.
 *
 * `actor_profile_id` is not an input; it is the authenticated caller. An
 * activity row that could name its own author would make the timeline
 * worthless as evidence.
 */
export const CreateActivitySchema = z
  .object({
    activity_type: ActivityTypeSchema,
    description: boundedText(1, 1000),
    metadata: MetadataSchema.optional(),
  })
  .strict();

export type CreateActivityInput = z.infer<typeof CreateActivitySchema>;

/**
 * `GET /api/v1/maintenance/tickets?cursor=&limit=&status=&priority=&category=&property_id=&assigned_provider_id=`
 *
 * A service provider calling this gets only their assigned tickets regardless
 * of the filters, per §4 ("R + U assigned only") — acceptance criterion 7.
 * Passing another provider's id returns an empty list, which discloses nothing.
 */
export const ListTicketsQuerySchema = PaginationQuerySchema.extend({
  status: optionalQueryParam(TicketStatusSchema),
  priority: optionalQueryParam(TicketPrioritySchema),
  category: optionalQueryParam(MaintenanceCategorySchema),
  property_id: optionalQueryParam(UuidSchema),
  property_unit_id: optionalQueryParam(UuidSchema),
  assigned_provider_id: optionalQueryParam(UuidSchema),
}).strict();

export type ListTicketsQuery = z.infer<typeof ListTicketsQuerySchema>;

export const TicketPathParamsSchema = z.object({ ticketId: UuidSchema }).strict();

export type TicketPathParams = z.infer<typeof TicketPathParamsSchema>;

/** `GET /api/v1/maintenance/tickets/{ticketId}/activities?cursor=&limit=` */
export const ListActivitiesQuerySchema = PaginationQuerySchema.strict();

export type ListActivitiesQuery = z.infer<typeof ListActivitiesQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export const TicketSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    property_id: UuidSchema,
    property_unit_id: UuidSchema,
    tenancy_id: UuidSchema.nullable(),
    tenant_id: UuidSchema,
    assigned_provider_id: UuidSchema.nullable(),
    title: TitleSchema,
    description: DescriptionSchema,
    category: MaintenanceCategorySchema,
    priority: TicketPrioritySchema,
    status: TicketStatusSchema,
    source: TicketSourceSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export type Ticket = z.infer<typeof TicketSchema>;

export const ActivitySchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    ticket_id: UuidSchema,
    actor_profile_id: UuidSchema.nullable(),
    activity_type: ActivityTypeSchema,
    description: boundedText(1, 1000),
    metadata: MetadataSchema,
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Activity = z.infer<typeof ActivitySchema>;

/**
 * A ticket with its timeline and context.
 *
 * `tenant` is `TenantNameSchema`, not `TenantSchema`: the detail view is the
 * one a service provider reads, and §4 grants a provider the tenant's name
 * only. Embedding the narrow shape means a handler cannot leak a tenant's email
 * or phone to a provider by omission.
 *
 * `available_transitions` is computed server-side from
 * `allowedTransitionsFor(status, role)` so the UI renders exactly the actions
 * the caller may actually take, from the same rule set the server enforces.
 */
export const TicketDetailSchema = TicketSchema.extend({
  tenant: TenantNameSchema.nullable().optional(),
  unit_number: boundedText(1, 40).optional(),
  property_name: boundedText(1, 160).optional(),
  provider_company_name: boundedText(1, 200).nullable().optional(),
  activities: z.array(ActivitySchema).optional(),
  available_transitions: z.array(TicketStatusSchema).optional(),
}).strict();

export type TicketDetail = z.infer<typeof TicketDetailSchema>;

export const TicketResponseSchema = resourceResponseSchema(TicketDetailSchema);
export const TicketListResponseSchema = listResponseSchema(TicketSchema);
export const ActivityResponseSchema = resourceResponseSchema(ActivitySchema);
export const ActivityListResponseSchema = listResponseSchema(ActivitySchema);
