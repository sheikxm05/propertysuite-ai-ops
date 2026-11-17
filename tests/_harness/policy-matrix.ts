/**
 * The docs/implementation-plan.md §4 policy matrix, as data. Lane w0-l6.
 *
 * This file is the specification the isolation suite tests against — not migration
 * 0002. When the two disagree the document wins (CLAUDE.md, "Where the truth lives"),
 * so a divergence must show up as a failing assertion rather than as a test quietly
 * written to match whatever the SQL happens to do.
 *
 * Includes the §5.8 amendments in force at the time of writing:
 *   A6  `profiles` gains self-scoped UPDATE; creation moves to an auth.users trigger.
 *   A7  `service_provider` gains `documents` INSERT/SELECT scoped to assigned tickets.
 *   A8  `organization_admin` gains INSERT on `maintenance_activities`.
 *   A9  state-machine edges (asserted in tests/rls/state-machine.test.ts, not here).
 *
 * `policies` names the policy in the migrations expected to implement each cell. It is
 * what lets the coverage report distinguish three different situations: a matrix cell
 * no assertion exercised, a matrix cell no SQL policy implements, and an SQL policy no
 * matrix cell claims.
 */

import { MEMBER_ROLES } from '@shared/index';
import type { MemberRole } from './jwt-factory';
import { TENANT_SCOPED_TABLES, type TenantScopedTable } from './tables';

export const ROLES: readonly MemberRole[] = MEMBER_ROLES;

export const OPERATIONS = ['select', 'insert', 'update', 'delete'] as const;
export type Operation = (typeof OPERATIONS)[number];

/**
 * How much of the organization a role may read.
 *   'org'    every row in its own organization
 *   'scoped' only rows it has a specific relationship with (self, owned, leased, assigned)
 *   'none'   nothing, not even in its own organization
 */
export type ReadScope = 'org' | 'scoped' | 'none';

/** How much a role may write. `false` means no policy grants the operation at all. */
export type WriteScope = 'org' | 'scoped' | false;

export interface CellSpec {
  select: ReadScope;
  insert: WriteScope;
  update: WriteScope;
  /** Never granted. Anywhere. To anyone. §4: "No DELETE is granted on any table." */
  delete: false;
  policies?: readonly string[];
  note?: string;
}

type TableSpec = Readonly<Record<MemberRole, CellSpec>>;

const NOTHING: CellSpec = { select: 'none', insert: false, update: false, delete: false };

/** Read-only for everyone, scoped to the caller's own row(s). */
const readScoped = (policies?: readonly string[]): CellSpec => ({
  select: 'scoped',
  insert: false,
  update: false,
  delete: false,
  ...(policies ? { policies } : {}),
});

const readOrg = (policies?: readonly string[]): CellSpec => ({
  select: 'org',
  insert: false,
  update: false,
  delete: false,
  ...(policies ? { policies } : {}),
});

/** Full operational write inside the organization: the staff cell for most tables. */
const staffRW = (table: string): CellSpec => ({
  select: 'org',
  insert: 'org',
  update: 'org',
  delete: false,
  policies: [`${table}_select_staff`, `${table}_insert_staff`, `${table}_update_staff`],
});

export const POLICY_MATRIX: Readonly<Record<TenantScopedTable, TableSpec>> = Object.freeze({
  // R own, for every role including the admin. §5.8 records the deliberate absence of
  // any rename path: there is no UPDATE policy for anyone.
  organizations: {
    organization_admin: readScoped(['organizations_select_member']),
    property_owner: readScoped(['organizations_select_member']),
    property_manager: readScoped(['organizations_select_member']),
    tenant: readScoped(['organizations_select_member']),
    service_provider: readScoped(['organizations_select_member']),
  },

  // Finding 2 and amendment A6. Staff and owners see fellow members; a tenant or a
  // provider sees nobody but themselves. Everyone may update their own row only, and
  // nobody may insert (0003's auth.users trigger owns creation).
  profiles: {
    organization_admin: {
      select: 'org',
      insert: false,
      update: 'scoped',
      delete: false,
      policies: ['profiles_select_self', 'profiles_select_same_org_staff', 'profiles_update_self'],
    },
    property_manager: {
      select: 'org',
      insert: false,
      update: 'scoped',
      delete: false,
      policies: ['profiles_select_self', 'profiles_select_same_org_staff', 'profiles_update_self'],
    },
    property_owner: {
      select: 'org',
      insert: false,
      update: 'scoped',
      delete: false,
      policies: ['profiles_select_self', 'profiles_select_same_org_staff', 'profiles_update_self'],
    },
    tenant: {
      select: 'scoped',
      insert: false,
      update: 'scoped',
      delete: false,
      policies: ['profiles_select_self', 'profiles_update_self'],
      note: 'R self only — the tenant-PII boundary (goal 2).',
    },
    service_provider: {
      select: 'scoped',
      insert: false,
      update: 'scoped',
      delete: false,
      policies: ['profiles_select_self', 'profiles_update_self'],
    },
  },

  // Admin RW, manager R, owner R, tenant/provider R self. INSERT is absent by design:
  // invitations route through the RPCs (finding 8).
  organization_members: {
    organization_admin: {
      select: 'org',
      insert: false,
      update: 'org',
      delete: false,
      policies: [
        'organization_members_select_self',
        'organization_members_select_staff',
        'organization_members_update_admin',
      ],
      note: 'Matrix says RW; §4 routes membership creation through an RPC, so no INSERT policy.',
    },
    property_manager: readOrg(['organization_members_select_staff']),
    property_owner: readOrg(['organization_members_select_staff']),
    tenant: readScoped(['organization_members_select_self']),
    service_provider: readScoped(['organization_members_select_self']),
  },

  properties: {
    organization_admin: staffRW('properties'),
    property_manager: staffRW('properties'),
    property_owner: readScoped(['properties_select_owner']),
    tenant: readScoped(['properties_select_tenant']),
    service_provider: readScoped(['properties_select_provider']),
  },

  property_units: {
    organization_admin: staffRW('property_units'),
    property_manager: staffRW('property_units'),
    property_owner: readScoped(['property_units_select_owner']),
    tenant: readScoped(['property_units_select_tenant']),
    service_provider: readScoped(['property_units_select_provider']),
  },

  tenants: {
    organization_admin: staffRW('tenants'),
    property_manager: staffRW('tenants'),
    property_owner: NOTHING,
    tenant: readScoped(['tenants_select_self']),
    service_provider: {
      ...readScoped(['tenants_select_provider_assigned']),
      note: 'R NAME only, via assignment. email and phone must stay unreadable.',
    },
  },

  tenancies: {
    organization_admin: staffRW('tenancies'),
    property_manager: staffRW('tenancies'),
    property_owner: readScoped(['tenancies_select_owner']),
    tenant: readScoped(['tenancies_select_own']),
    service_provider: NOTHING,
  },

  service_providers: {
    organization_admin: staffRW('service_providers'),
    property_manager: staffRW('service_providers'),
    property_owner: NOTHING,
    tenant: NOTHING,
    service_provider: readScoped(['service_providers_select_self']),
  },

  maintenance_tickets: {
    organization_admin: {
      select: 'org',
      insert: 'org',
      update: 'org',
      delete: false,
      policies: [
        'maintenance_tickets_select_staff',
        'maintenance_tickets_insert_staff',
        'maintenance_tickets_update_staff',
      ],
    },
    property_manager: {
      select: 'org',
      insert: 'org',
      update: 'org',
      delete: false,
      policies: [
        'maintenance_tickets_select_staff',
        'maintenance_tickets_insert_staff',
        'maintenance_tickets_update_staff',
      ],
    },
    property_owner: readScoped(['maintenance_tickets_select_owner']),
    tenant: {
      select: 'scoped',
      insert: 'scoped',
      update: 'scoped',
      delete: false,
      policies: [
        'maintenance_tickets_select_own_tenant',
        'maintenance_tickets_insert_tenant',
        'maintenance_tickets_update_tenant_confirm',
        'maintenance_tickets_update_tenant_cancel',
      ],
      note: 'CR own, plus confirm completion and cancel-while-open (A9).',
    },
    service_provider: {
      select: 'scoped',
      insert: false,
      update: 'scoped',
      delete: false,
      policies: [
        'maintenance_tickets_select_assigned_provider',
        'maintenance_tickets_update_assigned_provider',
      ],
      note: 'Assigned tickets only, and only the status subset assigned -> in_progress -> awaiting_approval.',
    },
  },

  // Immutable history: CR for the roles that drive transitions, R for the owner, and
  // UPDATE/DELETE for nobody — enforced by revoke plus a trigger, not by omission.
  maintenance_activities: {
    organization_admin: {
      select: 'org',
      insert: 'org',
      update: false,
      delete: false,
      policies: ['maintenance_activities_select_staff', 'maintenance_activities_insert_admin'],
      note: 'Amendment A8: without INSERT, an admin transition could write no activity row.',
    },
    property_manager: {
      select: 'org',
      insert: 'org',
      update: false,
      delete: false,
      policies: ['maintenance_activities_select_staff', 'maintenance_activities_insert_manager'],
    },
    property_owner: readScoped(['maintenance_activities_select_owner']),
    tenant: {
      select: 'scoped',
      insert: 'scoped',
      update: false,
      delete: false,
      policies: ['maintenance_activities_select_tenant', 'maintenance_activities_insert_tenant'],
    },
    service_provider: {
      select: 'scoped',
      insert: 'scoped',
      update: false,
      delete: false,
      policies: [
        'maintenance_activities_select_provider',
        'maintenance_activities_insert_provider',
      ],
    },
  },

  documents: {
    organization_admin: staffRW('documents'),
    property_manager: staffRW('documents'),
    property_owner: readScoped(['documents_select_owner']),
    tenant: readScoped(['documents_select_own_tenancy']),
    service_provider: {
      select: 'scoped',
      insert: 'scoped',
      update: false,
      delete: false,
      policies: ['documents_select_provider_assigned', 'documents_insert_provider_assigned'],
      note:
        'Amendment A7: completion evidence on an assigned ticket. Depends on ' +
        'documents.ticket_id, which 0003 adds before calling 0002`s ' +
        'ensure_document_provider_policies(). The suite probes for the column and says so ' +
        'plainly if it is missing, rather than reporting an opaque empty result.',
    },
  },

  ai_conversations: {
    organization_admin: readOrg(['ai_conversations_select_staff']),
    property_manager: readOrg(['ai_conversations_select_staff']),
    property_owner: NOTHING,
    tenant: {
      select: 'scoped',
      insert: 'scoped',
      update: false,
      delete: false,
      policies: ['ai_conversations_select_own_tenant', 'ai_conversations_insert_own_tenant'],
    },
    service_provider: NOTHING,
  },

  ai_messages: {
    organization_admin: readOrg(['ai_messages_select_staff']),
    property_manager: readOrg(['ai_messages_select_staff']),
    property_owner: NOTHING,
    tenant: {
      select: 'scoped',
      insert: 'scoped',
      update: false,
      delete: false,
      policies: ['ai_messages_select_own_tenant', 'ai_messages_insert_own_tenant'],
      note:
        "Client INSERT is restricted to sender_type = 'user'. A client that could forge an " +
        "'assistant' or 'system' turn creates a prompt-injection channel: a later request " +
        'could replay that turn as trusted instruction.',
    },
    service_provider: NOTHING,
  },

  // R own for every role. No INSERT policy at all: notifications are produced
  // server-side, so no client can fabricate one addressed to someone else.
  notifications: {
    organization_admin: readScoped(['notifications_select_own']),
    property_manager: readScoped(['notifications_select_own']),
    property_owner: readScoped(['notifications_select_own']),
    tenant: readScoped(['notifications_select_own']),
    service_provider: readScoped(['notifications_select_own']),
  },

  // Finding 7. Admin read only; INSERT/UPDATE/DELETE revoked from authenticated, so the
  // trail is append-only and written by log_audit() or the service-role client.
  audit_logs: {
    organization_admin: readOrg(['audit_logs_select_admin']),
    property_manager: NOTHING,
    property_owner: NOTHING,
    tenant: NOTHING,
    service_provider: NOTHING,
  },

  // Amendment A4. Admin SELECT only, column-limited so token_hash is unreadable by any
  // client. Writes happen only inside the invitation RPCs.
  organization_invitations: {
    organization_admin: readOrg(['organization admins can view their invitations']),
    property_manager: NOTHING,
    property_owner: NOTHING,
    tenant: NOTHING,
    service_provider: NOTHING,
  },

  /* ------------------------------------------------- migration 0004, agentic -- */
  //
  // §4 predates these four tables — 0004 is lane w3-l1's and the document describes
  // document_chunks only as future scope (implementation-plan.md line 318). So the
  // specification for the rows below is, in order of authority: CLAUDE.md rules 5
  // (never trust a client-supplied organization_id), 6 (no DELETE path) and 7 (no model
  // output reaches a mutation without a human in between), then the stated intent in
  // 0004's own header. Where that intent and the SQL could drift, the cell is written
  // from the INTENT, so the suite fails rather than ratifying whatever the SQL does —
  // which is the same contract every other row in this file is under.

  // A chunk is readable by exactly whoever may read its parent document, expressed in
  // 0004 as a bare EXISTS against public.documents. So this block is the `documents`
  // block above with the writes removed: staff organization-wide, owner by property,
  // tenant by tenancy, provider by assigned ticket. No client write path exists, by
  // policy and by revoked privilege both.
  document_chunks: {
    organization_admin: readOrg(['document_chunks_select_parent_document']),
    property_manager: readOrg(['document_chunks_select_parent_document']),
    property_owner: readScoped(['document_chunks_select_parent_document']),
    tenant: readScoped(['document_chunks_select_parent_document']),
    service_provider: {
      ...readScoped(['document_chunks_select_parent_document']),
      note:
        'Inherits amendment A7 through the parent document: a provider reads the chunks ' +
        'of its own completion evidence and nothing else. Same documents.ticket_id ' +
        'dependency as the `documents` row above.',
    },
  },

  // Staff-only read, and `scoped` rather than `org` for one specific reason: an
  // UNATTRIBUTED message (organization_id is null) belongs to no organization, and the
  // policy's `organization_id is not null` clause is the only thing keeping it out of
  // the first organization that asks. Declaring the read `org` would leave that row
  // with no negative assertion anywhere; declaring it `scoped` makes the suite prove
  // the unattributed message is invisible even to staff of the organization the sender
  // probably belongs to. Failing closed is the whole point of the nullable column.
  inbound_messages: {
    organization_admin: {
      ...readScoped(['inbound_messages_select_staff']),
      note: 'Scope boundary = the unattributed message, which is visible to NO organization.',
    },
    property_manager: {
      ...readScoped(['inbound_messages_select_staff']),
      note: 'Scope boundary = the unattributed message, which is visible to NO organization.',
    },
    property_owner: NOTHING,
    tenant: NOTHING,
    service_provider: NOTHING,
  },

  // A run is started by a human, in their own name. INSERT is `scoped`, not `org`,
  // because the policy pins actor_profile_id to current_profile_id(): a staff member
  // cannot attribute a run to a colleague, and the probe proves it by trying.
  agent_runs: {
    organization_admin: {
      select: 'org',
      insert: 'scoped',
      update: 'org',
      delete: false,
      policies: ['agent_runs_select_staff', 'agent_runs_insert_staff', 'agent_runs_update_staff'],
      note: 'UPDATE is status bookkeeping only; nothing consequential hangs off a run row.',
    },
    property_manager: {
      select: 'org',
      insert: 'scoped',
      update: 'org',
      delete: false,
      policies: ['agent_runs_select_staff', 'agent_runs_insert_staff', 'agent_runs_update_staff'],
    },
    property_owner: NOTHING,
    tenant: NOTHING,
    service_provider: NOTHING,
  },

  // The decision surface. `update: false` for EVERY role is not an omission and not a
  // conservatism — it is CLAUDE.md rule 7 expressed as a missing privilege: there is no
  // UPDATE policy and no UPDATE grant, so the only path from `pending` to `approved` is
  // approve_agent_proposal(), which is security definer and checks is_org_staff().
  // harness.test.ts asserts that absence statically; the suite asserts it live.
  //
  // INSERT is `scoped` because the policy admits a proposal only as `pending` with no
  // decision attached. The out-of-scope payload is a proposal born `approved` — the
  // exact shape of a model committing its own work — and it must be refused.
  agent_proposals: {
    organization_admin: {
      select: 'org',
      insert: 'scoped',
      update: false,
      delete: false,
      policies: ['agent_proposals_select_staff', 'agent_proposals_insert_staff'],
      note: 'A pending proposal is inert. Approval is an RPC, never a client UPDATE.',
    },
    property_manager: {
      select: 'org',
      insert: 'scoped',
      update: false,
      delete: false,
      policies: ['agent_proposals_select_staff', 'agent_proposals_insert_staff'],
    },
    property_owner: NOTHING,
    tenant: NOTHING,
    service_provider: NOTHING,
  },

  /* ----------------------------------- migration 0006, the outbound ledger -- */

  // The record of what the organization SENT a tenant. One policy, one operation, one
  // audience: staff of the owning organization may SELECT, via is_org_staff(). Every
  // other cell is `none`/`false`, and each `false` is a missing privilege rather than a
  // missing policy — harness.test.ts asserts that distinction statically, because a
  // refusal by absent policy is silent (zero rows, HTTP 200) and a refusal by absent
  // privilege is loud (42501), and only the loud one survives someone later adding a
  // well-meaning policy.
  //
  // `tenant: NOTHING` is the row most likely to be "corrected" by a future reader, so
  // it is argued rather than asserted. The tenant already HAS the message: it arrived
  // on their phone, which is the whole point of sending it. What the row adds beyond
  // the text is `drafted_by` — whether the reply they received was written by a model —
  // `sent_by_profile_id`, naming the member of staff who released it, and the delivery
  // state. Disclosing those is disclosing how the organization operates internally, to
  // the person it operates on. The ledger is staff infrastructure.
  //
  // `select: 'org'` rather than `'scoped'` for staff: unlike `inbound_messages`, there
  // is no unattributed row to be withheld. organization_id is NOT NULL here, deliberately
  // — an unattributed message is never replied to — so every row belongs to exactly one
  // organization and the only boundary is the cross-organization one.
  outbound_messages: {
    organization_admin: {
      ...readOrg(['outbound_messages_select_staff']),
      note: 'Read-only. Sending is a service-role / security-definer path, never a client INSERT.',
    },
    property_manager: {
      ...readOrg(['outbound_messages_select_staff']),
      note: 'Read-only. Sending is a service-role / security-definer path, never a client INSERT.',
    },
    property_owner: NOTHING,
    tenant: {
      ...NOTHING,
      note:
        'The recipient cannot read the record of the message we sent them. They have ' +
        'the text already; the row carries provenance and operational state instead.',
    },
    service_provider: NOTHING,
  },
} as Record<TenantScopedTable, TableSpec>);

export interface MatrixCell {
  table: TenantScopedTable;
  role: MemberRole;
  operation: Operation;
  /** 'allow' for an operation the role may perform somewhere in its own organization. */
  expectation: 'allow' | 'deny';
  scope: ReadScope | WriteScope;
  policies: readonly string[];
  note?: string;
}

/** Every (table, role, operation) triple the §4 matrix speaks about. */
export function matrixCells(): MatrixCell[] {
  const cells: MatrixCell[] = [];
  for (const table of TENANT_SCOPED_TABLES) {
    for (const role of ROLES) {
      const spec = POLICY_MATRIX[table][role];
      for (const operation of OPERATIONS) {
        const scope = spec[operation];
        cells.push({
          table,
          role,
          operation,
          expectation: scope === 'none' || scope === false ? 'deny' : 'allow',
          scope,
          policies: spec.policies ?? [],
          ...(spec.note ? { note: spec.note } : {}),
        });
      }
    }
  }
  return cells;
}

export const cellKey = (table: string, role: string, operation: string, dimension: string) =>
  `${dimension}:${table}.${role}.${operation}`;

/**
 * Scoped grants where no in-organization negative can exist, so the coverage gate must
 * not demand one. An organization has exactly one `organizations` row: "R own" has no
 * sibling row to be refused, and the real boundary is the cross-organization case,
 * which is asserted for every role.
 */
export const NO_IN_ORG_NEGATIVE: ReadonlySet<string> = new Set(
  ROLES.map((role) => `organizations.${role}.select`),
);
