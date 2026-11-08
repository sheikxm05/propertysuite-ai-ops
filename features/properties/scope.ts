/**
 * Resolving the caller's reachable set of properties and units.
 *
 * `features/properties/authorization.ts` explains why this exists: the §4 matrix grants a
 * tenant a property "via tenancy" and a provider one "via assigned ticket", but a
 * `properties` row carries neither a tenant nor a provider column, so the relationship
 * has to be resolved with a query before `authorize()` can be asked anything meaningful
 * about it. Without this module the only honest options would be to deny tenants and
 * providers any property read at all, or to let RLS be the sole enforcement — and
 * CLAUDE.md goal 1 rules the second one out.
 *
 * Everything here runs through the **caller-scoped** client, so Row Level Security
 * applies to the scope resolution itself. The service-role client is not imported and
 * must never be: a scope resolved with RLS bypassed would be a scope that proves nothing.
 *
 * `membership` supplies the organization. Nothing in this file accepts an
 * `organization_id` from a caller (CLAUDE.md rule 5).
 */

import { throwIfPostgresError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import type { VisibilityScope } from './authorization';

/**
 * Hard cap on how many reachable ids are collected.
 *
 * The ids become a PostgREST `in.(…)` list, so an unbounded set is an unbounded query
 * string. A tenant with more than 200 active tenancies, or a provider with more than 200
 * assigned tickets, is not a case this MVP needs to page through — and the cap fails
 * *narrow* (fewer rows visible), never wide.
 */
export const MAX_SCOPE_IDS = 200;

/**
 * The caller's reachable set, derived entirely from trusted rows.
 *
 * - `organization_admin`, `property_manager` → `all`. The matrix gives staff RWA over
 *   the organization's portfolio; the organization filter on every query is the bound.
 * - `property_owner` → `owned`, keyed by `organization_members.id`, which is what
 *   `properties.owner_member_id` references and what `0002`'s `owns_property` compares.
 * - `tenant` → the units they hold an **active** tenancy on, and those units' properties.
 *   A draft, expired or terminated tenancy grants nothing, matching `can_access_unit`.
 * - `service_provider` → the units and properties behind tickets assigned to them,
 *   matching the `assigned_provider_id` predicate in `0002`'s provider policies.
 * - A tenant with no `tenants` row, or a provider with no `service_providers` row, gets
 *   `none` and sees nothing. That is the fail-closed direction.
 */
export async function resolveVisibilityScope(
  client: AppSupabaseClient,
  membership: Membership,
): Promise<VisibilityScope> {
  switch (membership.role) {
    case 'organization_admin':
    case 'property_manager':
      return { kind: 'all' };

    case 'property_owner':
      return { kind: 'owned', ownerMemberId: membership.memberId };

    case 'tenant':
      return membership.tenantId
        ? await tenancyScope(client, membership.organization.id, membership.tenantId)
        : { kind: 'none', reason: 'caller_has_no_tenant_record' };

    case 'service_provider':
      return membership.providerId
        ? await assignmentScope(client, membership.organization.id, membership.providerId)
        : { kind: 'none', reason: 'caller_has_no_provider_record' };
  }
}

/**
 * Units under an active tenancy of this tenant, plus their properties.
 *
 * Two round trips rather than one embedded select: `tenancies` and `property_units` have
 * different policies for a tenant (own tenancy; leased unit), and a nested select would
 * make a single policy failure look like an empty relationship rather than an empty set.
 * Two explicit queries keep which layer denied what legible.
 */
async function tenancyScope(
  client: AppSupabaseClient,
  organizationId: string,
  tenantId: string,
): Promise<VisibilityScope> {
  const { data: tenancies, error: tenancyError } = await client
    .from('tenancies')
    .select('property_unit_id')
    .eq('organization_id', organizationId)
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .limit(MAX_SCOPE_IDS);
  throwIfPostgresError(tenancyError);

  const unitIds = unique((tenancies ?? []).map((row) => row.property_unit_id));
  if (unitIds.length === 0) {
    return { kind: 'tenancy', propertyIds: [], unitIds: [] };
  }

  const { data: units, error: unitError } = await client
    .from('property_units')
    .select('id, property_id')
    .eq('organization_id', organizationId)
    .in('id', unitIds)
    .limit(MAX_SCOPE_IDS);
  throwIfPostgresError(unitError);

  // Intersected with what the unit query actually returned, not with what the tenancy
  // query claimed. If a unit row is unreadable the unit drops out of the scope rather
  // than being asserted into it.
  return {
    kind: 'tenancy',
    unitIds: unique((units ?? []).map((row) => row.id)),
    propertyIds: unique((units ?? []).map((row) => row.property_id)),
  };
}

/** Units and properties behind tickets assigned to this provider. */
async function assignmentScope(
  client: AppSupabaseClient,
  organizationId: string,
  providerId: string,
): Promise<VisibilityScope> {
  const { data, error } = await client
    .from('maintenance_tickets')
    .select('property_id, property_unit_id')
    .eq('organization_id', organizationId)
    .eq('assigned_provider_id', providerId)
    .limit(MAX_SCOPE_IDS);
  throwIfPostgresError(error);

  return {
    kind: 'assignment',
    propertyIds: unique((data ?? []).map((row) => row.property_id)),
    unitIds: unique((data ?? []).map((row) => row.property_unit_id)),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
