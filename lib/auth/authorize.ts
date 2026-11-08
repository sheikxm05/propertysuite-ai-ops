/**
 * Application-space authorization — the second of the two enforcement layers.
 *
 * `supabase/migrations/0002_rls_hardening.sql` encodes the §4 policy matrix in
 * Postgres. This file encodes the same matrix in TypeScript. The duplication is the
 * point: **this layer must deny on the assumption that RLS has a bug**, and RLS must
 * deny on the assumption that this layer was never called. A single enforcement point
 * is one defect away from a cross-organization read.
 *
 * Three things it does that RLS structurally cannot:
 *
 *  1. **Column projection.** RLS is row-level. It can grant or deny a row; it cannot
 *     hide a column. The matrix grants a `service_provider` a tenant's *name only, via
 *     assignment* — so `fields` on the decision below carries the allowlist a route
 *     must project with. Without it a provider reads tenant email and phone while the
 *     RLS suite still looks green.
 *  2. **Deny before the query.** A denied request never reaches the database, so a
 *     probing client learns nothing from timing.
 *  3. **Name the reason.** RLS returns "zero rows"; this returns a `reason` the logger
 *     records (never the client — see `lib/api/errors.ts`).
 *
 * What it deliberately does **not** do: re-implement the ticket state machine.
 * `canTransition(from, to, role)` lives in `packages/shared` and is enforced again by
 * `0003`'s trigger. Copying it here would be a third, drifting definition.
 */

import type { MemberRole } from '@/lib/shared';

import type { Membership } from './roles';

/* -------------------------------------------------------------- vocabulary -- */

/** One per tenant-scoped table in the §4 matrix, named for the table. */
export type ResourceType =
  | 'organization'
  | 'profile'
  | 'organization_member'
  | 'property'
  | 'property_unit'
  | 'tenant'
  | 'tenancy'
  | 'service_provider'
  | 'maintenance_ticket'
  | 'maintenance_activity'
  | 'document'
  | 'ai_conversation'
  | 'ai_message'
  | 'notification'
  | 'audit_log';

/**
 * `archive` is the write that replaces delete (CLAUDE.md rule 6). `delete` exists only
 * so that a route which asks for it is answered with an explicit, tested denial rather
 * than falling through a `switch`.
 */
export type Action = 'read' | 'create' | 'update' | 'archive' | 'delete';

/**
 * The facts about a resource that the policy needs.
 *
 * Every field is something the **server** read from the database before calling
 * `authorize`. Nothing here may be copied from a request body, query string, header or
 * cookie — `organizationId` in particular. That is CLAUDE.md rule 5, and passing a
 * client-supplied value here would defeat the whole file.
 */
export interface ResourceRef {
  type: ResourceType;
  /** The row's `organization_id`, as read from the row. */
  organizationId?: string | null;
  /** `properties.owner_member_id`, for the property-owner rules. */
  ownerMemberId?: string | null;
  /** The `tenants.id` the row belongs to, or reaches through its tenancy. */
  tenantId?: string | null;
  /** The `service_providers.id` the row is assigned to. */
  providerId?: string | null;
  /** The `profiles.id` the row belongs to, for self-only rules. */
  profileId?: string | null;
}

export interface AuthorizationDecision {
  allowed: boolean;
  /**
   * Stable `snake_case` reason. Logged, never returned — a reason that distinguishes
   * "wrong organization" from "no such row" is a disclosure.
   */
  reason: string;
  /**
   * Column allowlist for the permitted action, when the matrix grants only partial
   * access to the row. `undefined` means every column the row exposes.
   *
   * On a `read` it is the projection the route must `.select()` with — a
   * `service_provider` seeing a tenant's name only. On an `update` it is the set of
   * columns the route may write — a caller editing their own profile. Both are things
   * Row Level Security structurally cannot express, because RLS is row-level.
   */
  fields?: readonly string[];
}

const ALLOW = (reason: string, fields?: readonly string[]): AuthorizationDecision =>
  fields ? { allowed: true, reason, fields } : { allowed: true, reason };
const DENY = (reason: string): AuthorizationDecision => ({ allowed: false, reason });

/**
 * The projection the matrix grants a `service_provider` over a `tenants` row: enough to
 * knock on the right door, nothing else. Exported so a route and its test agree.
 */
export const PROVIDER_TENANT_FIELDS: readonly string[] = ['id', 'organization_id', 'full_name'];

/**
 * The only columns a caller may change on their own `profiles` row (§4 amendment A6).
 *
 * `id` and `auth_user_id` are absent, and that absence is the security property. `0002`'s
 * `profiles_update_self` policy pins both in its `with check`, because a caller who could
 * rewrite `auth_user_id` would point their profile at another person's `auth.users` row
 * and inherit that person's memberships, tenancies and tickets. This is the application
 * -space half of the same guard: a route builds its `UPDATE` from this list, so the two
 * dangerous columns are unreachable rather than merely rejected.
 */
export const PROFILE_SELF_MUTABLE_FIELDS: readonly string[] = ['full_name', 'email', 'phone'];

/* ---------------------------------------------------------------- policies -- */

/** A single cell of the §4 matrix. */
type Rule = (
  membership: Membership,
  resource: ResourceRef,
  action: Action,
) => AuthorizationDecision;

/** Writes nobody has. Used for every `—` and every read-only row in the matrix. */
const NONE: Rule = () => DENY('not_permitted_for_role');

const readOnly =
  (
    predicate: (m: Membership, r: ResourceRef) => boolean,
    reason: string,
    fields?: readonly string[],
  ): Rule =>
  (m, r, action) => {
    if (action !== 'read') return DENY('write_not_permitted_for_role');
    return predicate(m, r) ? ALLOW(reason, fields) : DENY(reason);
  };

const sameOrganization = (): boolean => true; // org equality is checked by the precondition

const isSelfProfile = (m: Membership, r: ResourceRef): boolean =>
  r.profileId != null && r.profileId === m.profile.id;

const isOwnedProperty = (m: Membership, r: ResourceRef): boolean =>
  r.ownerMemberId != null && r.ownerMemberId === m.memberId;

const isOwnTenant = (m: Membership, r: ResourceRef): boolean =>
  m.tenantId != null && r.tenantId != null && r.tenantId === m.tenantId;

const isOwnProvider = (m: Membership, r: ResourceRef): boolean =>
  m.providerId != null && r.providerId != null && r.providerId === m.providerId;

/** Staff write: create, update and archive within the organization; no delete, ever. */
const staffWrite =
  (allowArchive: boolean): Rule =>
  (_m, _r, action) => {
    switch (action) {
      case 'read':
      case 'create':
      case 'update':
        return ALLOW('staff_scope');
      case 'archive':
        return allowArchive ? ALLOW('staff_scope') : DENY('archive_not_supported');
      case 'delete':
        return DENY('delete_never_permitted');
    }
  };

/**
 * The matrix, as code. `Record<ResourceType, Record<MemberRole, Rule>>` is deliberate:
 * TypeScript refuses to compile a missing table or a missing role, so the table cannot
 * silently fall out of step with `docs/implementation-plan.md` §4 or with the five roles
 * in `packages/shared`.
 */
const POLICIES: Record<ResourceType, Record<MemberRole, Rule>> = {
  /**
   * `R own` for every role, including `organization_admin`. There is deliberately no
   * rename path: W0-L2 revoked writes on `organizations` outright, so designing an
   * update here would produce a 403 at best and a confusing 500 at worst.
   */
  organization: {
    organization_admin: readOnly(sameOrganization, 'own_organization'),
    property_manager: readOnly(sameOrganization, 'own_organization'),
    property_owner: readOnly(sameOrganization, 'own_organization'),
    tenant: readOnly(sameOrganization, 'own_organization'),
    service_provider: readOnly(sameOrganization, 'own_organization'),
  },

  /**
   * Staff read any same-organization profile; a tenant and a provider read only their
   * own. This is the row that stops a tenant enumerating the other tenants in a
   * building (acceptance criterion: no tenant sees another tenant's personal data).
   *
   * Every role may update its own row and no other (§4 amendment A6). See `profileRule`.
   */
  profile: {
    organization_admin: profileRule(sameOrganization, 'same_organization_profile'),
    property_manager: profileRule(sameOrganization, 'same_organization_profile'),
    property_owner: profileRule(sameOrganization, 'same_organization_profile'),
    tenant: profileRule(isSelfProfile, 'self_profile_only'),
    service_provider: profileRule(isSelfProfile, 'self_profile_only'),
  },

  /** Only an administrator manages membership; invitation writes go through RPCs. */
  organization_member: {
    organization_admin: (_m, _r, action) =>
      action === 'delete'
        ? DENY('delete_never_permitted')
        : action === 'archive'
          ? ALLOW('member_disable')
          : ALLOW('admin_manages_membership'),
    property_manager: readOnly(sameOrganization, 'same_organization_membership'),
    property_owner: readOnly(sameOrganization, 'same_organization_membership'),
    tenant: readOnly(isSelfProfile, 'self_membership_only'),
    service_provider: readOnly(isSelfProfile, 'self_membership_only'),
  },

  property: {
    organization_admin: staffWrite(true),
    property_manager: staffWrite(true),
    property_owner: readOnly(isOwnedProperty, 'owned_property_only'),
    tenant: readOnly(isOwnTenant, 'property_via_own_tenancy'),
    service_provider: readOnly(isOwnProvider, 'property_via_assigned_ticket'),
  },

  property_unit: {
    organization_admin: staffWrite(true),
    property_manager: staffWrite(true),
    property_owner: readOnly(isOwnedProperty, 'owned_property_only'),
    tenant: readOnly(isOwnTenant, 'unit_via_own_tenancy'),
    service_provider: readOnly(isOwnProvider, 'unit_via_assigned_ticket'),
  },

  /**
   * `service_provider` gets *name only, via assignment* — the `PROVIDER_TENANT_FIELDS`
   * projection. RLS grants the row; this grants the columns. See the file header.
   */
  tenant: {
    organization_admin: staffWrite(false),
    property_manager: staffWrite(false),
    property_owner: NONE,
    tenant: readOnly(isOwnTenant, 'self_tenant_only'),
    service_provider: readOnly(isOwnProvider, 'tenant_name_via_assignment', PROVIDER_TENANT_FIELDS),
  },

  tenancy: {
    organization_admin: staffWrite(false),
    property_manager: staffWrite(false),
    property_owner: readOnly(isOwnedProperty, 'owned_property_tenancy'),
    tenant: readOnly(isOwnTenant, 'own_tenancy_only'),
    service_provider: NONE,
  },

  service_provider: {
    organization_admin: staffWrite(false),
    property_manager: staffWrite(false),
    property_owner: NONE,
    tenant: NONE,
    service_provider: readOnly(isOwnProvider, 'self_provider_only'),
  },

  /**
   * A tenant may create a ticket and update their own (confirming completion). A
   * provider may update one assigned to them. Which *status* either may drive is
   * `canTransition` in `packages/shared` plus `0003`'s trigger — not this file.
   */
  maintenance_ticket: {
    organization_admin: staffWrite(false),
    property_manager: staffWrite(false),
    property_owner: readOnly(isOwnedProperty, 'owned_property_ticket'),
    tenant: (m, r, action) => {
      if (action === 'create') return ALLOW('tenant_reports_own_ticket');
      if (action === 'read' || action === 'update') {
        return isOwnTenant(m, r) ? ALLOW('own_ticket_only') : DENY('own_ticket_only');
      }
      return DENY('not_permitted_for_role');
    },
    service_provider: (m, r, action) => {
      if (action === 'read' || action === 'update') {
        return isOwnProvider(m, r) ? ALLOW('assigned_ticket_only') : DENY('assigned_ticket_only');
      }
      return DENY('not_permitted_for_role');
    },
  },

  /**
   * Append-only everywhere. `0003`'s `block_activity_mutation` trigger rejects UPDATE
   * and DELETE even for service-role, so an `update` grant here would be a lie.
   * `organization_admin` appends on the same terms as a manager (§4 amendment A8:
   * `0002`'s `maintenance_activities_insert_admin`); `property_owner` reads only.
   */
  maintenance_activity: {
    organization_admin: appendOnly(sameOrganization, 'admin_appends_activity'),
    property_manager: appendOnly(sameOrganization, 'manager_appends_activity'),
    property_owner: readOnly(isOwnedProperty, 'owned_property_activity'),
    tenant: appendOnly(isOwnTenant, 'own_ticket_activity'),
    service_provider: appendOnly(isOwnProvider, 'assigned_ticket_activity'),
  },

  document: {
    organization_admin: staffWrite(false),
    property_manager: staffWrite(false),
    property_owner: readOnly(isOwnedProperty, 'owned_property_document'),
    tenant: readOnly(isOwnTenant, 'own_tenancy_document'),
    service_provider: NONE,
  },

  /** A tenant starts conversations; staff read them. Nobody updates one. */
  ai_conversation: {
    organization_admin: readOnly(sameOrganization, 'staff_reads_conversation'),
    property_manager: readOnly(sameOrganization, 'staff_reads_conversation'),
    property_owner: NONE,
    tenant: appendOnly(isSelfProfile, 'own_conversation'),
    service_provider: NONE,
  },

  /**
   * A client may only insert a `sender_type = 'user'` turn — W0-L2 restricted the
   * policy to it. Assistant and system turns are written by `services/ai/**` with the
   * service-role client, so they never pass through `authorize`.
   */
  ai_message: {
    organization_admin: readOnly(sameOrganization, 'staff_reads_messages'),
    property_manager: readOnly(sameOrganization, 'staff_reads_messages'),
    property_owner: NONE,
    tenant: appendOnly(isSelfProfile, 'own_user_turn'),
    service_provider: NONE,
  },

  /**
   * Read-your-own only. `notifications` has no INSERT policy at all: delivery rows are
   * created server-side, so `create` is denied for every role here too.
   */
  notification: {
    organization_admin: readOnly(isSelfProfile, 'own_notification'),
    property_manager: readOnly(isSelfProfile, 'own_notification'),
    property_owner: readOnly(isSelfProfile, 'own_notification'),
    tenant: readOnly(isSelfProfile, 'own_notification'),
    service_provider: readOnly(isSelfProfile, 'own_notification'),
  },

  /**
   * Administrator read only. Writes go through `0003`'s security-definer `log_audit`,
   * which is why no role has `create` here — see `lib/audit/write.ts`.
   */
  audit_log: {
    organization_admin: readOnly(sameOrganization, 'admin_reads_audit'),
    property_manager: NONE,
    property_owner: NONE,
    tenant: NONE,
    service_provider: NONE,
  },
};

/**
 * The `profiles` row (§4 amendment A6).
 *
 * Read scope varies by role — staff and owners see any same-organization profile, a
 * tenant and a provider see only their own. Update scope does not vary: **every role may
 * update only its own row**, and only the columns in `PROFILE_SELF_MUTABLE_FIELDS`.
 *
 * Creation is denied for all five roles with no exception. `0003` creates the row from an
 * `auth.users` AFTER INSERT trigger; `0002` deliberately has no client INSERT policy,
 * because a client that could insert its own profile could choose its own `id` and
 * pre-empt a pending invitation.
 */
function profileRule(
  readPredicate: (m: Membership, r: ResourceRef) => boolean,
  readReason: string,
): Rule {
  return (m, r, action) => {
    if (action === 'read') {
      return readPredicate(m, r) ? ALLOW(readReason) : DENY(readReason);
    }
    if (action === 'update') {
      return isSelfProfile(m, r)
        ? ALLOW('self_profile_update', PROFILE_SELF_MUTABLE_FIELDS)
        : DENY('self_profile_update_only');
    }
    // Includes `create`: profile rows are never created by a client.
    return DENY('profile_write_not_permitted');
  };
}

/** Create and read, never update, archive or delete. For immutable tables. */
function appendOnly(predicate: (m: Membership, r: ResourceRef) => boolean, reason: string): Rule {
  return (m, r, action) => {
    if (action !== 'read' && action !== 'create') return DENY('append_only_resource');
    return predicate(m, r) ? ALLOW(reason) : DENY(reason);
  };
}

/* --------------------------------------------------------------- entrypoint -- */

/**
 * Decides whether `membership` may perform `action` on `resource`.
 *
 * Preconditions are checked before the matrix, in this order, because each is a harder
 * stop than the one after it:
 *
 *  1. `delete` — refused for every role on every table (CLAUDE.md rule 6).
 *  2. Membership status — a disabled or still-invited member is not a member.
 *  3. Organization status — a suspended organization is read-only to nobody.
 *  4. Organization match — the row's `organization_id` must equal the membership's.
 *     This is the cross-tenant stop, and it runs before any per-role rule so that no
 *     future matrix cell can accidentally bypass it.
 */
export function authorize(
  membership: Membership,
  action: Action,
  resource: ResourceRef,
): AuthorizationDecision {
  if (action === 'delete') return DENY('delete_never_permitted');

  if (membership.status !== 'active') return DENY('membership_not_active');
  if (membership.organization.status !== 'active') return DENY('organization_not_active');

  if (resource.organizationId != null && resource.organizationId !== membership.organization.id) {
    return DENY('cross_organization');
  }

  const table = POLICIES[resource.type];
  if (!table) return DENY('unknown_resource_type');

  const rule = table[membership.role];
  if (!rule) return DENY('unknown_role');

  return rule(membership, resource, action);
}

/**
 * `authorize`, as an assertion. The route gets a 403 and the reason goes to the log
 * only — `lib/api/errors.ts` never puts it on the wire.
 */
export function assertAuthorized(
  membership: Membership,
  action: Action,
  resource: ResourceRef,
): AuthorizationDecision {
  const decision = authorize(membership, action, resource);
  if (!decision.allowed) {
    throw new AuthorizationDeniedError(decision.reason, resource.type, action);
  }
  return decision;
}

/**
 * Thrown by `assertAuthorized`. Translated to a 403 by `withApiHandler`; the reason is
 * carried in `logFields`, which the logger filters through its allowlist.
 */
export class AuthorizationDeniedError extends Error {
  readonly reason: string;
  readonly resourceType: ResourceType;
  readonly action: Action;

  constructor(reason: string, resourceType: ResourceType, action: Action) {
    super(`authorization denied: ${reason}`);
    this.name = 'AuthorizationDeniedError';
    this.reason = reason;
    this.resourceType = resourceType;
    this.action = action;
  }
}

/**
 * The column allowlist for a permitted read, or `null` for "every column".
 *
 * A route calls this and passes the result straight to `.select()`. It is the only
 * mechanism that enforces the matrix's partial-visibility cells, because RLS cannot.
 */
export function projectionFor(
  membership: Membership,
  resource: ResourceRef,
): readonly string[] | null {
  const decision = authorize(membership, 'read', resource);
  if (!decision.allowed) return [];
  return decision.fields ?? null;
}

/**
 * The column allowlist for a permitted update, or `null` for "every writable column".
 *
 * Returns `[]` when the update is denied outright. A route building an `UPDATE` from this
 * list cannot write a column the matrix withheld — which is how `profiles.auth_user_id`
 * stays immutable in application space as well as in `0002`'s `with check`.
 */
export function writableFieldsFor(
  membership: Membership,
  resource: ResourceRef,
): readonly string[] | null {
  const decision = authorize(membership, 'update', resource);
  if (!decision.allowed) return [];
  return decision.fields ?? null;
}

/**
 * The five roles, derived from the policy table rather than restated.
 *
 * The table is typed `Record<ResourceType, Record<MemberRole, Rule>>`, so these keys
 * are exactly the roles `packages/shared` declares — this is a projection of the frozen
 * enum, not a second copy of it (CLAUDE.md rule 4). Used by the unit tests to prove
 * every role is covered for every table.
 */
export function knownRoles(): readonly MemberRole[] {
  return Object.keys(POLICIES.organization) as MemberRole[];
}

/** Every table the matrix covers. Used by the unit tests for the same reason. */
export function knownResourceTypes(): readonly ResourceType[] {
  return Object.keys(POLICIES) as ResourceType[];
}
