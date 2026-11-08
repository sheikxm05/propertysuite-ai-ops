/**
 * Application-space authorization for properties and units.
 *
 * `lib/auth/authorize.ts` owns the §4 matrix. This file does not re-implement it and
 * does not soften it: it builds the `ResourceRef` that `authorize()` needs, from rows the
 * server has already read, and it adds the one check the matrix cannot express on its
 * own — whether a tenant or a provider has a *proven path* to the row.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS FILE EXISTS TO SOLVE
 * ---------------------------------------------------------------------------
 * The matrix says a tenant reads a property "via tenancy" and a provider reads one "via
 * assigned ticket". `authorize()` checks those cells by comparing
 * `resource.tenantId` with `membership.tenantId` and `resource.providerId` with
 * `membership.providerId`. But a `properties` row has neither column — the relationship
 * runs `properties → property_units → tenancies → tenants` and
 * `properties → maintenance_tickets → service_providers`.
 *
 * So a route cannot simply write `tenantId: membership.tenantId` when building the ref.
 * That would make the comparison trivially true and hand every tenant in the
 * organization every property in it, with `authorize()` reporting `allowed: true` and the
 * RLS suite still green — because RLS would be the only thing left doing the work, which
 * is exactly the single-layer failure CLAUDE.md goal 1 forbids.
 *
 * Instead `features/properties/scope.ts` resolves the reachable set with its own query
 * through the caller's client, and the ref builders below fill `tenantId` / `providerId`
 * **only for rows in that set**. A row outside it carries `null`, `authorize()` denies,
 * and the deny happens in application space whatever RLS did.
 *
 * ---------------------------------------------------------------------------
 * WHY A DENIED READ IS A 404 AND NOT A 403
 * ---------------------------------------------------------------------------
 * `lib/api/errors.ts` states the rule: "An RLS-denied read returns zero rows and no
 * error at all; that path is a 404, raised by the route, never a 403 — confirming a
 * record exists is itself a disclosure." A property in organization B must look exactly
 * like a property that does not exist. `assertPropertyVisible` therefore raises
 * `NOT_FOUND`, while a *write* a caller is not entitled to make on a row they can
 * legitimately see — a property owner editing their own property — is a 403, because the
 * row's existence is not news to them.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { assertAuthorized, authorize, type ResourceRef } from '@/lib/auth/authorize';
import type { Membership } from '@/lib/auth/roles';
import {
  MEMBER_ROLES,
  type MemberRole,
  type PropertyRow,
  type PropertyUnitRow,
} from '@shared/index';

/* ----------------------------------------------------------------- scope -- */

/**
 * Which rows of `properties` and `property_units` the caller has a proven path to.
 *
 * Resolved by `features/properties/scope.ts` from trusted rows, never from a request.
 * `all` is not a shortcut for "skip the check": a staff caller still goes through
 * `authorize()`, which still rejects a row from another organization.
 */
export type VisibilityScope =
  /** `organization_admin`, `property_manager` — the whole organization's portfolio. */
  | { readonly kind: 'all' }
  /** `property_owner` — rows whose `owner_member_id` is this membership. */
  | { readonly kind: 'owned'; readonly ownerMemberId: string }
  /** `tenant` — rows reached through an active tenancy of theirs. */
  | {
      readonly kind: 'tenancy';
      readonly propertyIds: readonly string[];
      readonly unitIds: readonly string[];
    }
  /** `service_provider` — rows reached through a ticket assigned to them. */
  | {
      readonly kind: 'assignment';
      readonly propertyIds: readonly string[];
      readonly unitIds: readonly string[];
    }
  /** A role whose domain identity is missing, e.g. a `tenant` with no `tenants` row. */
  | { readonly kind: 'none'; readonly reason: string };

/** The property ids a scope restricts to, or `null` for "no id restriction". */
export function scopedPropertyIds(scope: VisibilityScope): readonly string[] | null {
  return scope.kind === 'tenancy' || scope.kind === 'assignment' ? scope.propertyIds : null;
}

/** The unit ids a scope restricts to, or `null` for "no id restriction". */
export function scopedUnitIds(scope: VisibilityScope): readonly string[] | null {
  return scope.kind === 'tenancy' || scope.kind === 'assignment' ? scope.unitIds : null;
}

/* ------------------------------------------------------- resource references -- */

/**
 * The `ResourceRef` for a property row.
 *
 * Every field comes from the row or from the membership — nothing from the request. The
 * two conditional fields are the subject of the file header: they are populated only when
 * the scope proves the caller can reach this specific row.
 */
export function propertyRef(
  row: Pick<PropertyRow, 'id' | 'organization_id' | 'owner_member_id'>,
  membership: Membership,
  scope: VisibilityScope,
): ResourceRef {
  const reachable = isPropertyInScope(row.id, scope);

  return {
    type: 'property',
    organizationId: row.organization_id,
    ownerMemberId: row.owner_member_id,
    tenantId: scope.kind === 'tenancy' && reachable ? membership.tenantId : null,
    providerId: scope.kind === 'assignment' && reachable ? membership.providerId : null,
  };
}

/**
 * The `ResourceRef` for a unit row.
 *
 * `ownerMemberId` is the *parent property's* owner, which the caller must pass in: a
 * `property_units` row has no owner column, and the matrix grants an owner "R owned",
 * meaning the owner of the containing property.
 */
export function unitRef(
  row: Pick<PropertyUnitRow, 'id' | 'organization_id'>,
  parentOwnerMemberId: string | null,
  membership: Membership,
  scope: VisibilityScope,
): ResourceRef {
  const reachable = isUnitInScope(row.id, scope);

  return {
    type: 'property_unit',
    organizationId: row.organization_id,
    ownerMemberId: parentOwnerMemberId,
    tenantId: scope.kind === 'tenancy' && reachable ? membership.tenantId : null,
    providerId: scope.kind === 'assignment' && reachable ? membership.providerId : null,
  };
}

function isPropertyInScope(propertyId: string, scope: VisibilityScope): boolean {
  switch (scope.kind) {
    case 'all':
    case 'owned':
      return true;
    case 'tenancy':
    case 'assignment':
      return scope.propertyIds.includes(propertyId);
    case 'none':
      return false;
  }
}

function isUnitInScope(unitId: string, scope: VisibilityScope): boolean {
  switch (scope.kind) {
    case 'all':
    case 'owned':
      return true;
    case 'tenancy':
    case 'assignment':
      return scope.unitIds.includes(unitId);
    case 'none':
      return false;
  }
}

/* ------------------------------------------------------------- assertions -- */

/**
 * Is this row readable? Raises `NOT_FOUND` if not — see the file header on 404 vs 403.
 *
 * Called on **every** row of a list as well as on a single read. Filtering a list by
 * scope and then not checking each row would mean trusting the filter; this is the layer
 * that assumes the filter has a bug.
 */
export function assertVisible(membership: Membership, ref: ResourceRef): void {
  const decision = authorize(membership, 'read', ref);
  if (decision.allowed) return;

  throw new ApiRouteError('NOT_FOUND', {
    logFields: { reason: decision.reason, resource_type: ref.type, action: 'read' },
  });
}

/** `assertVisible`, as a predicate, for filtering a list without throwing per row. */
export function isVisible(membership: Membership, ref: ResourceRef): boolean {
  return authorize(membership, 'read', ref).allowed;
}

/**
 * Is this caller allowed to create, update or archive? Raises 403 if not.
 *
 * Delegates straight to `assertAuthorized`, which throws `AuthorizationDeniedError`;
 * `withApiHandler` maps that to a 403 with the reason in the log and not on the wire.
 * A property owner hits this on every write attempt — the matrix gives them `R owned`
 * and nothing else, which is the "owner is read-only" assertion in this lane's exit gate.
 */
export function assertWritable(
  membership: Membership,
  action: 'create' | 'update' | 'archive',
  ref: ResourceRef,
): void {
  assertAuthorized(membership, action, ref);
}

/* ----------------------------------------------------- owner association -- */

/**
 * Roles that may be recorded as a property's `owner_member_id`.
 *
 * Derived from `MEMBER_ROLES` by exclusion rather than retyped, so a new role in
 * `packages/shared` cannot quietly become eligible (CLAUDE.md rule 4 — this is a
 * projection of the frozen enum, not a second copy of it).
 *
 * WHY `tenant` AND `service_provider` ARE EXCLUDED. `0002`'s `owns_property(org,
 * property_id)` grants a SELECT on the property, on all of its units, on its tenancies
 * and on its documents to whoever holds the membership named in `owner_member_id` — it
 * checks the membership is active, not what role it has. So naming a tenant as the owner
 * of the building they live in would hand them owner-scoped visibility of every other
 * unit and every other tenancy in it, through a column that looks like an ordinary
 * association. The database cannot refuse that; this list is where it is refused.
 */
export const OWNER_ASSOCIABLE_ROLES: readonly MemberRole[] = MEMBER_ROLES.filter(
  (role) => role !== 'tenant' && role !== 'service_provider',
);

/** The `organization_members` columns needed to validate an owner association. */
export interface OwnerCandidate {
  id: string;
  organization_id: string;
  role: string;
  status: string;
}

/**
 * Validates a proposed `owner_member_id` against the caller's own organization.
 *
 * `0002`'s composite foreign key `(organization_id, owner_member_id) →
 * organization_members(organization_id, id)` already makes a cross-organization owner
 * structurally impossible, and the wrapper surfaces the resulting `23503` as
 * `UNPROCESSABLE` 422. This is the server-side half of the same guard, and it runs first
 * so that the common case is a deliberate 422 with a stable reason in the log rather than
 * a foreign-key violation translated after the fact.
 *
 * `candidate` must have been read with `.eq('organization_id', membership.organization.id)`
 * applied; the redundant comparison below is the assertion that it was.
 */
export function assertOwnerAssociable(
  membership: Membership,
  candidate: OwnerCandidate | null,
): void {
  // Annotated as a variable, not just as an arrow return type: TypeScript only uses a
  // call to a never-returning function for control-flow narrowing when the callee is a
  // function declaration or a `const` with an explicit type annotation.
  const reject: (reason: string) => never = (reason) => {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'The requested owner is not a valid member of this organization.',
      logFields: { reason },
    });
  };

  if (!candidate) reject('owner_member_not_found');

  if (candidate.organization_id !== membership.organization.id) {
    reject('owner_member_cross_organization');
  }
  if (candidate.status !== 'active') reject('owner_member_not_active');
  if (!(OWNER_ASSOCIABLE_ROLES as readonly string[]).includes(candidate.role)) {
    reject('owner_member_role_not_associable');
  }
}
