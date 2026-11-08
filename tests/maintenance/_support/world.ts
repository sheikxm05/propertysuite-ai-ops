/**
 * The responder the service tests drive the fake PostgREST with.
 *
 * It answers by TABLE and CARDINALITY only — never by evaluating a filter. That is the
 * deliberate limitation described in `fake-postgrest.ts`: because the answer does not
 * depend on the predicates, a test can only prove that the right predicate was built by
 * asserting the recorded statement, so a missing `.eq('assigned_provider_id', ...)` can
 * never pass by coincidence.
 */

import { TICKET_ID } from './fixtures';
import type { Responder } from './fake-postgrest';
import type {
  ActivityRow,
  PropertyRow,
  ProviderRow,
  TenancyRow,
  TenantNameRow,
  TicketRow,
  UnitRow,
} from '@/features/maintenance/domain';

export interface World {
  /** What `findTicket` returns (a `maybeSingle` select). */
  ticket?: TicketRow | null;
  /** What `listTickets` returns (a many select). */
  ticketList?: TicketRow[];
  /** What `updateTicket` returns. Defaults to the ticket with the patch applied. */
  updated?: TicketRow | null;
  /** What `insertTicket` returns. */
  insertedTicket?: TicketRow;
  unit?: UnitRow | null;
  unitList?: UnitRow[];
  property?: PropertyRow | null;
  propertyList?: PropertyRow[];
  tenancy?: TenancyRow | null;
  provider?: ProviderRow | null;
  providerList?: ProviderRow[];
  tenant?: TenantNameRow | null;
  activities?: ActivityRow[];
  /** `countRecurringOpenTickets`. */
  recurringCount?: number;
  /** `countTicketEvidence`. */
  evidenceCount?: number;
  /** Set to force an error result on one table, to exercise the SQLSTATE mapping. */
  errorOn?: { table: string; error: { code: string; message: string } };
}

export function worldResponder(world: World): Responder {
  return (statement) => {
    if (world.errorOn && world.errorOn.table === statement.table) {
      return { error: world.errorOn.error };
    }

    switch (statement.table) {
      case 'maintenance_tickets': {
        if (statement.kind === 'insert') {
          if (world.insertedTicket) return { data: world.insertedTicket };
          // The database assigns the primary key, so the double has to as well: the
          // service reads `ticket.id` back to write the activity row and the Location
          // header, and a row with no id would make those assertions vacuous.
          return {
            data: {
              id: TICKET_ID,
              created_at: '2026-11-02T06:00:00.000+00:00',
              updated_at: '2026-11-02T06:00:00.000+00:00',
              ...statement.values[0],
            },
          };
        }
        if (statement.kind === 'update') {
          if (world.updated !== undefined) return { data: world.updated };
          return { data: applied(world.ticket, statement.patch) };
        }
        if (statement.counted) return { count: world.recurringCount ?? 0 };
        if (statement.cardinality === 'many') return { data: world.ticketList ?? [] };
        return { data: world.ticket ?? null };
      }

      case 'property_units':
        return statement.cardinality === 'many'
          ? { data: world.unitList ?? [] }
          : { data: world.unit ?? null };

      case 'properties':
        return statement.cardinality === 'many'
          ? { data: world.propertyList ?? [] }
          : { data: world.property ?? null };

      case 'tenancies':
        return { data: world.tenancy ?? null };

      case 'service_providers':
        return statement.cardinality === 'many'
          ? { data: world.providerList ?? [] }
          : { data: world.provider ?? null };

      case 'tenants':
        return { data: world.tenant ?? null };

      case 'documents':
        return { count: world.evidenceCount ?? 0 };

      case 'maintenance_activities': {
        if (statement.kind === 'insert') {
          return {
            data: statement.values.map((values, index) => ({
              id: `activity-${index}`,
              created_at: '2026-11-02T06:00:00.000+00:00',
              ...values,
            })),
          };
        }
        return { data: world.activities ?? [] };
      }

      default:
        return { data: null };
    }
  };
}

function applied(
  base: TicketRow | null | undefined,
  patch: Record<string, unknown> | null | undefined,
): unknown {
  if (!base) return patch ?? null;
  return { ...base, ...(patch ?? {}) };
}
