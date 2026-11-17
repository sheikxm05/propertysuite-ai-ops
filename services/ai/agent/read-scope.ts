/**
 * The agent's entire access to the database — five queries, no writes.
 *
 * This file is the implementation of {@link AgentReadScope}, and the implementation is
 * where the two isolation guarantees are made concrete:
 *
 *  1. **Every query is pinned to one organization**, and that organization comes from
 *     `ctx.membership.organization.id` — a value `lib/auth/roles.ts` derived from trusted
 *     rows. It is never read from a request body and it is never read from anything the
 *     model said (CLAUDE.md rule 5). The pin is applied here, once, rather than in each
 *     tool, so a tool cannot forget it.
 *
 *  2. **Every query runs through the caller's own Supabase client**, with Row Level
 *     Security in force. The pin above is therefore belt and braces: for the agent to
 *     read another organization's row, both the explicit `.eq('organization_id', …)` and
 *     the `0002` policy matrix would have to be wrong at the same time.
 *
 * The client is held in a closure and is not a property of the returned object, so a tool
 * holding an `AgentReadScope` cannot reach the client, cannot call `.from()`, and cannot
 * call `.rpc()`. That is what makes "read tools have no write capability" a fact about
 * the program rather than a promise about the authors.
 *
 * Nothing here logs. It handles unit numbers, ticket titles and tenancy dates.
 */

import { throwIfPostgresError } from '@/lib/api/errors';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import type {
  AgentReadScope,
  ProviderSummary,
  TenancySummary,
  TicketSummary,
  UnitSummary,
} from './types';

/**
 * Hard ceiling on rows returned by any one query, whatever a tool asks for.
 *
 * Two reasons, and the second is the important one. A large result set costs tokens; and
 * a tool result is placed in the model's context, so an unbounded list is an unbounded
 * amount of other people's data sitting in a prompt. Small is the safe default.
 */
const MAX_ROWS = 10;

const clampLimit = (limit: number): number =>
  Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), MAX_ROWS) : 1;

/**
 * Builds the scope for one request.
 *
 * `organizationId` must come from `Membership`. There is no overload that takes it from
 * anywhere else, and the one call site is the route handler.
 */
export function createAgentReadScope(
  supabase: AppSupabaseClient,
  organizationId: string,
): AgentReadScope {
  return {
    organizationId,

    async findUnitsByNumber(unitNumber: string, limit: number): Promise<readonly UnitSummary[]> {
      const { data, error } = await supabase
        .from('property_units')
        .select('id, property_id, unit_number, status, bedrooms, bathrooms')
        .eq('organization_id', organizationId)
        .eq('unit_number', unitNumber)
        .order('unit_number', { ascending: true })
        .limit(clampLimit(limit));
      throwIfPostgresError(error);
      return data ?? [];
    },

    async findUnitById(unitId: string): Promise<UnitSummary | null> {
      const { data, error } = await supabase
        .from('property_units')
        .select('id, property_id, unit_number, status, bedrooms, bathrooms')
        .eq('organization_id', organizationId)
        .eq('id', unitId)
        .maybeSingle();
      throwIfPostgresError(error);
      return data ?? null;
    },

    async activeTenancyForUnit(unitId: string): Promise<TenancySummary | null> {
      // `maybeSingle` rather than `single`: a unit with no active tenancy is an ordinary
      // answer ("vacant"), not an error. `0003` already forbids two overlapping active
      // tenancies on one unit, so at most one row can come back.
      const { data, error } = await supabase
        .from('tenancies')
        .select('id, start_date, end_date, status')
        .eq('organization_id', organizationId)
        .eq('property_unit_id', unitId)
        .eq('status', 'active')
        .maybeSingle();
      throwIfPostgresError(error);
      return data ?? null;
    },

    async recentTicketsForUnit(
      unitId: string,
      limit: number,
    ): Promise<readonly { readonly ticket: TicketSummary; readonly title: string }[]> {
      const { data, error } = await supabase
        .from('maintenance_tickets')
        .select('id, category, priority, status, created_at, assigned_provider_id, title')
        .eq('organization_id', organizationId)
        .eq('property_unit_id', unitId)
        .order('created_at', { ascending: false })
        .limit(clampLimit(limit));
      throwIfPostgresError(error);

      // The title is separated from the structured fields at the earliest possible point.
      // It is tenant-authored free text; everything else is an id, an enum or a
      // timestamp. Keeping them apart in the return type means the caller has to decide
      // what to do with the hostile half, and `tools/read-tools.ts` fences it.
      return (data ?? []).map((row) => ({
        ticket: {
          id: row.id,
          category: row.category,
          priority: row.priority,
          status: row.status,
          created_at: row.created_at,
          assigned_provider_id: row.assigned_provider_id,
        },
        title: row.title,
      }));
    },

    async activeProviders(
      category: string | null,
      limit: number,
    ): Promise<readonly ProviderSummary[]> {
      const base = supabase
        .from('service_providers')
        .select('id, company_name, service_categories, status')
        .eq('organization_id', organizationId)
        .eq('status', 'active');

      // `service_categories` is `text[]`; `contains` compiles to the `@>` operator, so a
      // provider matches when the category is one of theirs. A null category means "no
      // filter", which is how the tool expresses "show me everyone eligible".
      const scoped = category ? base.contains('service_categories', [category]) : base;

      const { data, error } = await scoped
        .order('company_name', { ascending: true })
        .limit(clampLimit(limit));
      throwIfPostgresError(error);
      return data ?? [];
    },
  };
}
