/**
 * Cross-layer parity: Postgres RLS against application-space authorization.
 * Lane w0-l6.
 *
 * §1 of the implementation plan requires authorization to be enforced TWICE — RLS as
 * the floor, `authorize()` as the gate — so that a defect in one layer is not
 * exploitable because the other still holds. Two independent implementations of one
 * matrix is the right design, and it has one failure mode: they drift. Three
 * matrix-drift defects reached feature lanes because nothing mechanically tied the two
 * together.
 *
 * This file is that tie. It runs in the ORDINARY unit job — no Docker, no database, no
 * `PS_RLS` — because a gate that only fires when the stack is up would have caught none
 * of them. It reads the policies out of `supabase/migrations/*.sql` and the grants out
 * of `lib/auth/authorize.ts`, and asserts they agree in both directions:
 *
 *   SQL -> app   every effective policy has a non-`NONE` cell behind it. A policy with
 *                no app-space grant is a hole in the gate: RLS would permit the write
 *                and the route would be the only thing stopping it, or nothing would.
 *   app -> SQL   every app-space grant has a policy behind it. A grant with no policy
 *                is dead on arrival — the handler authorizes the call and Postgres
 *                refuses it, which surfaces as a confusing 500 rather than a 403.
 *
 * Granularity is deliberate. The authoritative comparison is (table, command), which
 * needs no inference at all. A second, role-level pass runs only for policies whose
 * role is unambiguous from the policy name; everything else is REPORTED as
 * role-not-inferable rather than assumed covered.
 */

import { describe, expect, it } from 'vitest';
import type { MemberRole } from '@shared/index';
import {
  authorize,
  knownResourceTypes,
  knownRoles,
  type Action,
  type ResourceRef,
  type ResourceType,
} from '@/lib/auth/authorize';
import type { Membership } from '@/lib/auth/roles';
import { parsePolicies, TENANT_SCOPED_TABLES } from './tables';

/* ------------------------------------------------------------- the mapping -- */

/** Postgres table to the resource type `authorize()` names. */
const TABLE_TO_RESOURCE: Readonly<Record<string, ResourceType>> = {
  organizations: 'organization',
  profiles: 'profile',
  organization_members: 'organization_member',
  properties: 'property',
  property_units: 'property_unit',
  tenants: 'tenant',
  tenancies: 'tenancy',
  service_providers: 'service_provider',
  maintenance_tickets: 'maintenance_ticket',
  maintenance_activities: 'maintenance_activity',
  documents: 'document',
  ai_conversations: 'ai_conversation',
  ai_messages: 'ai_message',
  notifications: 'notification',
  audit_logs: 'audit_log',
};

/**
 * Tables with no counterpart in `authorize()`, and why. Listed explicitly so that a
 * table arriving in a later migration shows up as unmapped instead of being skipped.
 *
 *   organization_invitations  amendment A4. Written only by the invitation RPCs, read
 *                             by an admin. No route calls authorize() on it.
 *   objects                   storage.objects. Path-derived, not row-derived; the HTTP
 *                             storage layer is not routed through authorize().
 *   jobs                      infrastructure, service-role only, no organization_id.
 */
const INTENTIONALLY_UNMAPPED: Readonly<Record<string, string>> = {
  organization_invitations: 'amendment A4: RPC-written, admin-read; no authorize() path',
  objects: 'storage.objects: path-derived authorization, not a routed resource',
  jobs: 'service-role-only infrastructure, no tenant scope',
};

/** SQL command to the app-space actions that imply it. */
const COMMAND_TO_ACTIONS: Readonly<Record<string, readonly Action[]>> = {
  select: ['read'],
  insert: ['create'],
  update: ['update', 'archive'],
  delete: ['delete'],
};

/**
 * App-space grants whose write path is a `security definer` RPC, not a client statement.
 *
 * An RPC runs as the table owner and so bypasses RLS entirely: the grant is real, the
 * absent policy is deliberate, and demanding one would be wrong. §4 says it outright —
 * "Onboarding and invitation writes go through RPCs, not direct policies" — and finding
 * 8 records the absent INSERT policy on `organization_members` as intentional.
 *
 * Every entry here is a hole in the app -> SQL direction of this gate, so each one names
 * the RPC that closes it. Adding an entry to silence a failure, without an RPC actually
 * existing, would turn the gate into decoration.
 */
const RPC_MEDIATED_WRITES: Readonly<Record<string, string>> = {
  'organization_member.create':
    '0003 invite_member() / accept_invitation(), both security definer. They run as the ' +
    'table owner, so no client INSERT policy exists or should (finding 8). authorize() ' +
    'still gates the route that calls them, which is why the grant is not dead.',
};

/** App-space action to the SQL command Postgres would need a policy for. */
const ACTION_TO_COMMAND: Readonly<Record<Action, string>> = {
  read: 'select',
  create: 'insert',
  update: 'update',
  archive: 'update',
  delete: 'delete',
};

/**
 * Policy-name suffixes whose role is unambiguous. Suffixes that are NOT here —
 * `_self`, `_own`, `_member` — genuinely do not name a role: `notifications_select_own`
 * is every role's own row, while `tenancies_select_own` is the tenant's. Guessing
 * between those produces a confident wrong answer, so they are reported instead.
 */
const ROLE_SUFFIXES: readonly { pattern: RegExp; roles: readonly MemberRole[] }[] = [
  { pattern: /_staff$/, roles: ['organization_admin', 'property_manager'] },
  { pattern: /_same_org_staff$/, roles: ['organization_admin', 'property_manager'] },
  { pattern: /_admin$/, roles: ['organization_admin'] },
  { pattern: /_manager$/, roles: ['property_manager'] },
  { pattern: /_owner$/, roles: ['property_owner'] },
  { pattern: /_assigned_provider$/, roles: ['service_provider'] },
  { pattern: /_provider_assigned$/, roles: ['service_provider'] },
  { pattern: /_provider$/, roles: ['service_provider'] },
  { pattern: /_own_tenant$/, roles: ['tenant'] },
  { pattern: /_own_tenancy$/, roles: ['tenant'] },
  { pattern: /_tenant_confirm$/, roles: ['tenant'] },
  { pattern: /_tenant_cancel$/, roles: ['tenant'] },
  { pattern: /_tenant$/, roles: ['tenant'] },
];

const rolesFromName = (name: string): readonly MemberRole[] | undefined =>
  ROLE_SUFFIXES.find((entry) => entry.pattern.test(name))?.roles;

/* ----------------------------------------------------- probing authorize() -- */

function membershipFor(role: MemberRole): Membership {
  return {
    memberId: 'member-self',
    role,
    status: 'active',
    profile: { id: 'profile-self', authUserId: 'auth-self', fullName: 'Parity Probe' },
    organization: { id: 'org-self', name: 'Parity Org', slug: 'parity-org', status: 'active' },
    tenantId: role === 'tenant' ? 'tenant-self' : null,
    providerId: role === 'service_provider' ? 'provider-self' : null,
  };
}

/**
 * Resource references that satisfy every scope predicate at once, so a probe answers
 * "does this role have ANY grant here?" rather than "does it have one for this
 * particular row?".
 *
 * Two shapes, because `documents` has two: provider completion evidence must carry a
 * ticket and no property or tenancy (amendment A7), while a contract is the reverse. A
 * single shape would read as `NONE` for whichever case it did not match.
 */
function probeRefs(type: ResourceType, m: Membership): ResourceRef[] {
  const base = {
    type,
    organizationId: m.organization.id,
    ownerMemberId: m.memberId,
    tenantId: m.tenantId ?? 'tenant-other',
    providerId: m.providerId ?? 'provider-other',
    profileId: m.profile.id,
    uploadedBy: m.profile.id,
  };
  return [
    { ...base, ticketId: 'ticket-self', propertyId: null, tenancyId: null },
    { ...base, ticketId: null, propertyId: 'property-self', tenancyId: 'tenancy-self' },
  ];
}

/** Roles the application layer grants `action` on `type`, by probing the real function. */
function appGrants(type: ResourceType, action: Action): MemberRole[] {
  return knownRoles().filter((role) => {
    const membership = membershipFor(role);
    return probeRefs(type, membership).some((ref) => authorize(membership, action, ref).allowed);
  });
}

/* -------------------------------------------------------------- the policies -- */

const policies = parsePolicies();

/** Policies on tables the app layer models. The rest are reported, not asserted. */
const mappedPolicies = policies.filter((p) => TABLE_TO_RESOURCE[p.table] !== undefined);

/* ------------------------------------------------------------------- tests -- */

describe('the two authorization layers describe the same tables', () => {
  it('every policy is on a table that is either mapped or explicitly unmapped', () => {
    const unaccounted = policies
      .map((p) => p.table)
      .filter(
        (table) =>
          TABLE_TO_RESOURCE[table] === undefined && INTENTIONALLY_UNMAPPED[table] === undefined,
      );

    expect(
      [...new Set(unaccounted)],
      'A policy exists on a table this parity gate knows nothing about. Map it to a ' +
        'ResourceType in TABLE_TO_RESOURCE, or record why it has no authorize() path in ' +
        'INTENTIONALLY_UNMAPPED. Leaving it out would let the two layers drift on that ' +
        'table silently, which is the one thing this file exists to prevent.',
    ).toEqual([]);
  });

  it('every resource type the app layer models has a table with policies', () => {
    const tablesWithPolicies = new Set(policies.map((p) => p.table));
    const modelled = knownResourceTypes();
    const orphans = modelled.filter((type) => {
      const table = Object.keys(TABLE_TO_RESOURCE).find((t) => TABLE_TO_RESOURCE[t] === type);
      return table === undefined || !tablesWithPolicies.has(table);
    });

    expect(
      orphans,
      'authorize() models a resource that no migration protects with a policy. Either ' +
        'RLS is missing for it, or the resource type is dead code — both are drift.',
    ).toEqual([]);
  });

  it('covers every tenant-scoped table from the migration registry', () => {
    // Keeps this file honest against tables.ts, which is itself parsed from the SQL.
    const uncovered = TENANT_SCOPED_TABLES.filter(
      (t) => TABLE_TO_RESOURCE[t] === undefined && INTENTIONALLY_UNMAPPED[t] === undefined,
    );
    expect(uncovered, 'a tenant-scoped table is absent from the parity mapping').toEqual([]);
  });
});

describe('SQL -> app: every policy has an application-space grant behind it', () => {
  for (const policy of mappedPolicies) {
    const resource = TABLE_TO_RESOURCE[policy.table] as ResourceType;
    const actions = COMMAND_TO_ACTIONS[policy.command] ?? [];

    it(`${policy.name} (${policy.table} ${policy.command})`, () => {
      expect(
        actions.length,
        `Policy ${policy.name} uses command "${policy.command}", which this gate does ` +
          'not know how to map to an app-space action.',
      ).toBeGreaterThan(0);

      const granted = actions.flatMap((action) => appGrants(resource, action));

      expect(
        [...new Set(granted)],
        `RLS policy ${policy.name} permits ${policy.command} on ${policy.table}, but ` +
          `authorize() grants no role any of [${actions.join(', ')}] on "${resource}". ` +
          'The second layer is missing: either add the cell to lib/auth/authorize.ts, or ' +
          'drop the policy. Enforcement is required twice (implementation-plan.md §1).',
      ).not.toEqual([]);
    });
  }
});

describe('app -> SQL: every application-space grant has a policy behind it', () => {
  const commandsByTable = new Map<string, Set<string>>();
  for (const policy of policies) {
    const set = commandsByTable.get(policy.table) ?? new Set<string>();
    set.add(policy.command);
    commandsByTable.set(policy.table, set);
  }

  const tableFor = (type: ResourceType) =>
    Object.keys(TABLE_TO_RESOURCE).find((t) => TABLE_TO_RESOURCE[t] === type);

  for (const type of knownResourceTypes()) {
    for (const action of ['read', 'create', 'update', 'archive', 'delete'] as const) {
      const granted = appGrants(type, action);
      if (granted.length === 0) continue;

      it(`${type}.${action} granted to [${granted.join(', ')}]`, () => {
        const table = tableFor(type);
        expect(table, `no table mapped for resource "${type}"`).toBeDefined();

        const needed = ACTION_TO_COMMAND[action];
        const available = commandsByTable.get(String(table)) ?? new Set<string>();
        const rpcReason = RPC_MEDIATED_WRITES[`${type}.${action}`];

        // `delete` must never be granted anywhere, by either layer (§4, finding 5).
        if (action === 'delete') {
          expect(
            granted,
            `authorize() grants DELETE on "${type}" to [${granted.join(', ')}]. No ` +
              'tenant-scoped table may grant delete to anyone; business records are ' +
              'archived and financial history is append-only.',
          ).toEqual([]);
          return;
        }

        if (rpcReason !== undefined) {
          // Recorded exception, not a silent skip: the absent policy is the design.
          expect(
            available.has(needed) || available.has('all'),
            `${type}.${action} is listed as RPC-mediated, but public.${String(table)} now ` +
              `HAS a ${needed.toUpperCase()} policy. If the write moved to a client ` +
              'statement, remove the entry from RPC_MEDIATED_WRITES so the gate asserts ' +
              'it properly.',
          ).toBe(false);
          return;
        }

        expect(
          available.has(needed) || available.has('all'),
          `authorize() grants ${action} on "${type}" to [${granted.join(', ')}], but ` +
            `no policy on public.${String(table)} permits ${needed.toUpperCase()}. The ` +
            'route would authorize the call and Postgres would then refuse it, which ' +
            'surfaces as a 500 rather than a 403. If the write is meant to go through a ' +
            'security-definer RPC, record it in RPC_MEDIATED_WRITES with the RPC name.',
        ).toBe(true);
      });
    }
  }
});

describe('role-level parity, where the policy name names a role', () => {
  const inferable = mappedPolicies.filter((p) => rolesFromName(p.name) !== undefined);

  it('reports the policies whose role cannot be inferred from their name', () => {
    const notInferable = mappedPolicies
      .filter((p) => rolesFromName(p.name) === undefined)
      .map((p) => p.name);

    // Not a failure. `_self`, `_own` and `_member` describe a relationship, not a role,
    // and the (table, command) assertions above already cover them. Printed so the
    // blind spot is visible rather than implicit.
    if (notInferable.length > 0) {
      console.log(
        `role-level parity skipped for ${notInferable.length} policy name(s) that ` +
          `describe a relationship rather than a role:\n  ${notInferable.join('\n  ')}`,
      );
    }
    expect(
      inferable.length,
      'no policy name yielded a role — the suffix map is broken',
    ).toBeGreaterThan(20);
  });

  for (const policy of inferable) {
    const resource = TABLE_TO_RESOURCE[policy.table] as ResourceType;
    const roles = rolesFromName(policy.name) as readonly MemberRole[];
    const actions = COMMAND_TO_ACTIONS[policy.command] ?? [];

    it(`${policy.name} -> ${resource} for [${roles.join(', ')}]`, () => {
      for (const role of roles) {
        const membership = membershipFor(role);
        const allowed = actions.some((action) =>
          probeRefs(resource, membership).some((ref) => authorize(membership, action, ref).allowed),
        );
        expect(
          allowed,
          `RLS policy ${policy.name} grants ${policy.command} on ${policy.table} to ` +
            `${role}, but authorize() denies that role every one of ` +
            `[${actions.join(', ')}] on "${resource}". One layer permits what the other ` +
            'forbids, so the matrices have drifted.',
        ).toBe(true);
      }
    });
  }
});
