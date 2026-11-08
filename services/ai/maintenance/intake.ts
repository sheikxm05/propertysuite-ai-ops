/**
 * Server-side intake facts: which unit, whose tenancy, and what the deterministic
 * priority policy needs to decide.
 *
 * Everything in this file exists so that the model is never asked a question whose
 * answer is an authorization decision. The model classifies a problem; this module
 * decides *whose* problem it is, from rows, through the caller-scoped client with Row
 * Level Security in force.
 *
 * THE RULE ABOUT `property_unit_id`
 * ---------------------------------
 * A request may supply one. It is treated as a hint and then authorized: the unit must
 * carry an **active tenancy belonging to the caller's own tenant row**. A unit the caller
 * has no tenancy on is reported as absent, not as forbidden — confirming that a unit
 * exists is itself a disclosure (`lib/api/errors.ts`).
 *
 * Authorization is checked twice, deliberately, against the possibility that either layer
 * has a bug:
 *
 *   1. A `tenancies` read through the caller's client. RLS restricts it to the caller's
 *      own rows, and the query *also* filters on `membership.tenantId` explicitly, so a
 *      policy regression does not silently widen it.
 *   2. `public.can_access_unit(org, unit_id)`, the §5.3 security-definer helper, asked
 *      independently. Disagreement between the two is treated as denial.
 */

import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import {
  TERMINAL_TICKET_STATUSES,
  TICKET_STATUSES,
  resolvePriority,
  type MaintenanceCategory,
  type PriorityContext,
  type PriorityDecision,
  type TicketPriority,
  type TicketStatus,
} from '@shared/index';

import type { UnitResolution } from '../providers/types';

/**
 * Statuses that still count as live work for the repeat-failure escalation.
 *
 * Derived from the shared constants rather than transcribed: a local list of status
 * literals would be a second copy of a shared enum (CLAUDE.md rule 4) and would silently
 * stop matching the day the state machine grows a state.
 */
const LIVE_TICKET_STATUSES: readonly TicketStatus[] = TICKET_STATUSES.filter(
  (status) => !(TERMINAL_TICKET_STATUSES as readonly TicketStatus[]).includes(status),
);

/**
 * Dubai business hours, in Gulf Standard Time (UTC+4, no daylight saving).
 *
 * The working week is Monday to Friday under the 2022 UAE reform, with Saturday and
 * Sunday as the weekend. Used only as an input to `resolvePriority` — an out-of-hours
 * report of a safety-sensitive problem on an occupied unit escalates one step.
 */
export const GST_UTC_OFFSET_HOURS = 4;
export const BUSINESS_HOUR_START = 8;
export const BUSINESS_HOUR_END = 18;

/** What the server determined about the unit the message concerns. */
export interface UnitContext {
  readonly resolution: UnitResolution;
  /** The authorized unit, or `null` when unresolved. Never echoed from the request. */
  readonly unitId: string | null;
  /** Its property. Derived from the unit row, so the pair is always consistent. */
  readonly propertyId: string | null;
  readonly tenancyId: string | null;
  /** How many units the caller holds an active tenancy on. A count, never ids. */
  readonly candidateUnitCount: number;
}

/**
 * Resolves the unit from the session and, optionally, a requested unit id.
 *
 * Three outcomes, and the middle one is the reason this function is not a boolean:
 *
 *   resolved   one authorized unit — either the requested one, or the caller's only one
 *   ambiguous  the caller holds more than one tenancy and did not say which
 *   none       the caller holds no active tenancy at all
 *
 * `ambiguous` and `none` are not errors. They drive the clarification path: the draft
 * comes back asking which unit, and the confirm endpoint refuses to create anything until
 * a unit is named and authorized. An error would have thrown away a usable
 * classification.
 */
export async function resolveUnitContext(
  supabase: AppSupabaseClient,
  membership: Membership,
  requestedUnitId: string | null | undefined,
): Promise<UnitContext> {
  const organizationId = membership.organization.id;
  const tenantId = membership.tenantId;

  // Not a tenant in this organization: there is no tenancy to resolve. Staff reach the
  // AI intake only through a tenant account; §4's matrix grants `ai_conversations`
  // create to `tenant` alone.
  if (!tenantId) {
    return {
      resolution: 'none',
      unitId: null,
      propertyId: null,
      tenancyId: null,
      candidateUnitCount: 0,
    };
  }

  const { data, error } = await supabase
    .from('tenancies')
    .select('id, property_unit_id')
    .eq('organization_id', organizationId)
    .eq('tenant_id', tenantId)
    .eq('status', 'active');
  throwIfPostgresError(error);

  const tenancies = data ?? [];
  const candidateUnitCount = new Set(tenancies.map((row) => row.property_unit_id)).size;

  const chosen = requestedUnitId
    ? tenancies.find((row) => row.property_unit_id === requestedUnitId)
    : tenancies.length === 1
      ? tenancies[0]
      : undefined;

  if (!chosen) {
    // A requested unit the caller has no active tenancy on is indistinguishable, to the
    // caller, from a unit that does not exist. That is the intended disclosure boundary.
    if (requestedUnitId) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'unit_not_leased_by_caller' },
      });
    }
    return {
      resolution: candidateUnitCount > 1 ? 'ambiguous' : 'none',
      unitId: null,
      propertyId: null,
      tenancyId: null,
      candidateUnitCount,
    };
  }

  // Layer two: the database's own opinion, asked independently of the rows above.
  await assertDatabaseAgreesOnUnit(supabase, organizationId, chosen.property_unit_id);

  const propertyId = await readPropertyIdForUnit(supabase, organizationId, chosen.property_unit_id);

  return {
    resolution: 'resolved',
    unitId: chosen.property_unit_id,
    propertyId,
    tenancyId: chosen.id,
    candidateUnitCount,
  };
}

/**
 * Asks `can_access_unit` and refuses on anything but a clear yes.
 *
 * A thrown error here means the two enforcement layers disagree, which is a defect
 * somewhere — so it fails closed and is logged with a distinct reason rather than being
 * folded into the ordinary not-found path.
 */
async function assertDatabaseAgreesOnUnit(
  supabase: AppSupabaseClient,
  organizationId: string,
  unitId: string,
): Promise<void> {
  const { data, error } = await supabase.rpc('can_access_unit', {
    org: organizationId,
    unit_id: unitId,
  });
  throwIfPostgresError(error);

  if (data !== true) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'unit_access_layers_disagree', unit_id: unitId },
    });
  }
}

/**
 * The unit's property.
 *
 * Read rather than accepted, because `maintenance_tickets` carries a composite foreign
 * key on `(organization_id, property_id)` and `(organization_id, property_unit_id)`:
 * an inconsistent pair is rejected by the database, and the only way to be consistent is
 * to derive one from the other.
 */
async function readPropertyIdForUnit(
  supabase: AppSupabaseClient,
  organizationId: string,
  unitId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('property_units')
    .select('property_id')
    .eq('organization_id', organizationId)
    .eq('id', unitId)
    .maybeSingle();
  throwIfPostgresError(error);
  return data?.property_id ?? null;
}

/* ------------------------------------------------------------------- priority -- */

/**
 * Gathers the trusted facts `resolvePriority` needs, then calls it.
 *
 * Note what is passed and what is not. `classification.suggested_priority` goes in as a
 * suggestion. The request body contributes nothing: there is no parameter here for a
 * client-supplied priority, which is what stops a tenant marking everything urgent and
 * what stops an injected message doing the same. `unitUninhabitable` is left unset
 * because it is a staff determination and this path has no staff actor.
 */
export async function decidePriority(
  supabase: AppSupabaseClient,
  options: {
    organizationId: string;
    category: MaintenanceCategory;
    unit: UnitContext;
    suggestedPriority: TicketPriority | null;
    now?: Date;
  },
): Promise<PriorityDecision> {
  const recurringOpenTickets = options.unit.unitId
    ? await countOpenTicketsForUnit(
        supabase,
        options.organizationId,
        options.unit.unitId,
        options.category,
      )
    : 0;

  const context: PriorityContext = {
    category: options.category,
    hasActiveTenancy: options.unit.resolution === 'resolved',
    recurringOpenTickets,
    outsideBusinessHours: isOutsideBusinessHours(options.now ?? new Date()),
  };

  return resolvePriority({ suggested_priority: options.suggestedPriority }, context);
}

/** Open tickets on the same unit in the same category. Read through RLS, like everything. */
async function countOpenTicketsForUnit(
  supabase: AppSupabaseClient,
  organizationId: string,
  unitId: string,
  category: MaintenanceCategory,
): Promise<number> {
  const { count, error } = await supabase
    .from('maintenance_tickets')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('property_unit_id', unitId)
    .eq('category', category)
    .in('status', [...LIVE_TICKET_STATUSES]);
  throwIfPostgresError(error);
  return count ?? 0;
}

/**
 * Is `instant` outside Dubai business hours?
 *
 * Pure, and takes the clock as an argument, because `resolvePriority` is documented as
 * deterministic and the caller reads the clock. Computed by shifting to GST rather than
 * by relying on the host's time zone — a server in another region must reach the same
 * answer.
 */
export function isOutsideBusinessHours(instant: Date): boolean {
  const gst = new Date(instant.getTime() + GST_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const day = gst.getUTCDay();
  const hour = gst.getUTCHours();

  // 0 = Sunday, 6 = Saturday. The UAE working week is Monday to Friday.
  if (day === 0 || day === 6) return true;
  return hour < BUSINESS_HOUR_START || hour >= BUSINESS_HOUR_END;
}

/*
 * The clarification questions themselves live in `./draft.ts`, which has no server-side
 * imports and is therefore reachable from the review form in `features/ai-intake/**`.
 * Keeping them there means the client and the server render the same question from the
 * same constant.
 */
