/**
 * Database rows to API/UI shapes.
 *
 * The response shapes are `Ticket`, `Activity` and `TicketDetail` from
 * `packages/shared` — this module declares none of its own (CLAUDE.md rule 4). Its job
 * is the two narrowings a `select` cannot express:
 *
 *  1. **`category` is `text`, not an enum.** §5.9 records this as a known gap owned by
 *     `w2-l3`: `maintenance_tickets.category` has no `check` constraint yet, so a direct
 *     database write could leave an arbitrary string in the column. Every application
 *     path validates it (`CreateTicketSchema`, `UpdateTicketSchema`, the AI prompt
 *     contract), but a reader must still cope. An unrecognised value is surfaced as
 *     `unknown` — "not yet classified" — rather than passed through, so a bad row cannot
 *     break a client that switches on the enum.
 *  2. **`metadata` is `jsonb`, so it arrives as `unknown`.** It is narrowed to a plain
 *     object or replaced with `{}`. A timeline entry whose metadata is a string is a
 *     corrupt row, and the timeline must still render.
 *
 * Nothing here widens a projection. `tenant` carries `id` and `full_name` only, which is
 * what the §4 matrix grants a `service_provider` and therefore what every caller gets.
 */

import {
  isMaintenanceCategory,
  type Activity,
  type JsonValue,
  type MaintenanceCategory,
  type Ticket,
  type TicketDetail,
  type TicketStatus,
} from '@shared/index';

import type { Membership } from '@/lib/auth/roles';

import type {
  ActivityRow,
  PropertyRow,
  ProviderRow,
  TenantNameRow,
  TicketRow,
  UnitRow,
} from './repository';
import { availableTransitions } from './transitions';

/** Coerces the `text` category column into the controlled vocabulary. See header. */
export function normaliseCategory(value: string): MaintenanceCategory {
  return isMaintenanceCategory(value) ? value : 'unknown';
}

export function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    organization_id: row.organization_id,
    property_id: row.property_id,
    property_unit_id: row.property_unit_id,
    tenancy_id: row.tenancy_id,
    tenant_id: row.tenant_id,
    assigned_provider_id: row.assigned_provider_id,
    title: row.title,
    description: row.description,
    category: normaliseCategory(row.category),
    priority: row.priority,
    status: row.status,
    // `source` is `check (source in (...))` in `0001` and validated by
    // `TicketSourceSchema` on the way in, so a stored value outside the list would be a
    // direct database write. Cast rather than silently relabel: unlike `category` there
    // is no "unclassified" member to fall back to.
    source: row.source as Ticket['source'],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    organization_id: row.organization_id,
    ticket_id: row.ticket_id,
    actor_profile_id: row.actor_profile_id,
    activity_type: row.activity_type as Activity['activity_type'],
    description: row.description,
    metadata: asMetadata(row.metadata),
    created_at: row.created_at,
  };
}

/** Everything the detail view and the detail page need, assembled from narrow reads. */
export interface TicketDetailContext {
  ticket: TicketRow;
  unit: UnitRow | null;
  property: PropertyRow | null;
  provider: ProviderRow | null;
  tenant: TenantNameRow | null;
  activities: readonly ActivityRow[];
}

/**
 * Builds the `TicketDetail` response.
 *
 * `available_transitions` is computed from the shared rule set with the row bound in —
 * `availableTransitions(ticket, membership)` — so the buttons a client renders are
 * exactly the actions the server would accept. It is a convenience, never an
 * authorization boundary: every transition is re-checked on its own request and again by
 * `0003`'s trigger.
 */
export function toTicketDetail(context: TicketDetailContext, membership: Membership): TicketDetail {
  const transitions: readonly TicketStatus[] = availableTransitions(
    {
      id: context.ticket.id,
      organization_id: context.ticket.organization_id,
      status: context.ticket.status,
      tenant_id: context.ticket.tenant_id,
      assigned_provider_id: context.ticket.assigned_provider_id,
    },
    membership,
  );

  return {
    ...toTicket(context.ticket),
    tenant: context.tenant ? { id: context.tenant.id, full_name: context.tenant.full_name } : null,
    unit_number: context.unit?.unit_number ?? undefined,
    property_name: context.property?.name ?? undefined,
    provider_company_name: context.provider?.company_name ?? null,
    activities: context.activities.map(toActivity),
    available_transitions: [...transitions],
  };
}

/* ---------------------------------------------------------------- internals -- */

function asMetadata(value: unknown): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}
