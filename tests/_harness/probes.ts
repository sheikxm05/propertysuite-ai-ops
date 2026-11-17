/**
 * Per-table probes: which row a role is in scope for, which row inside the same
 * organization it is not, a structurally valid INSERT payload, and a patch.
 * Lane w0-l6.
 *
 * This is what lets the cross-organization and cross-role suites be generated from the
 * table list rather than hand-written table by table — the lane brief is explicit that
 * the tables come from the migration, not from whichever ones felt important.
 *
 * On INSERT payloads: Postgres evaluates NOT NULL and CHECK constraints BEFORE the RLS
 * `with check` clause, and foreign keys AFTER it. So every payload below satisfies the
 * NOT NULLs and CHECKs exactly, which means a rejection can only be an authorization
 * refusal — and `expectInsertDenied` insists on seeing that specific SQLSTATE. Where a
 * row's foreign keys are real they are real anyway, so the allowed cases work too.
 */

import { randomUUID } from 'node:crypto';
import type { MemberRole } from './jwt-factory';
import type { OrgFixture } from './fixtures';
import { SHARED_SHAPE } from './fixtures';
import { TENANT_SCOPED_TABLES, type TenantScopedTable } from './tables';
import { keyForRole } from './world';

export interface ProbeContext {
  f: OrgFixture;
  role: MemberRole;
  /** The acting principal's profile id in `f`'s organization, or in its own. */
  actorProfileId: string;
  /** Schema features the suite probed for rather than assumed. See fixtures.ts. */
  capabilities: { documentsHasTicketId: boolean };
}

export interface TableProbe {
  /** A row that exists in this organization. The cross-organization target. */
  anyRow(f: OrgFixture): string;
  /** A row a role with organization-wide read should see but has no personal tie to. */
  orgRow?(f: OrgFixture, role: MemberRole): string;
  /** A row this role is specifically entitled to, or null when the concept is moot. */
  inScope(f: OrgFixture, role: MemberRole): string | null;
  /** A row in the SAME organization this role must not READ, or null. */
  outOfScope(f: OrgFixture, role: MemberRole): string | null;
  /**
   * A row in the same organization this role must not WRITE, when that differs from
   * what it must not read. Staff may read a colleague's profile but never update it.
   */
  writeOutOfScope?(f: OrgFixture, role: MemberRole): string | null;
  insertRow(ctx: ProbeContext): Record<string, unknown>;
  /**
   * A payload that is valid in every structural respect but outside the role's scope —
   * a tenant filing a ticket against another tenant's unit, a provider attaching
   * evidence to a ticket that is not theirs. Present only where the role has a scoped
   * INSERT grant to test the edge of.
   */
  insertOutOfScope?(ctx: ProbeContext): Record<string, unknown>;
  /** A patch that changes something, plus the column to read back. */
  patch: { patch: Record<string, unknown>; column: string };
  /** A patch that is semantically a no-op, for exercising an ALLOWED update safely. */
  noopPatch?: { patch: Record<string, unknown>; column: string };
  /** Explicit column list, for tables with column-level grants. */
  columns?: string;
}

const TAMPERED = 'TAMPERED BY A CALLER WITH NO POLICY';

const ownProfile = (f: OrgFixture, role: MemberRole) => f.profiles[keyForRole(f.key, role)] ?? null;
const ownMember = (f: OrgFixture, role: MemberRole) => f.members[keyForRole(f.key, role)] ?? null;
const ownNotification = (f: OrgFixture, role: MemberRole) =>
  f.notifications[keyForRole(f.key, role)] ?? null;

const secondaryTenantKey = (f: OrgFixture) => `${f.key.toLowerCase()}_tenant2`;

export const PROBES: Readonly<Record<TenantScopedTable, TableProbe>> = {
  organizations: {
    anyRow: (f) => f.organizationId,
    inScope: (f) => f.organizationId,
    outOfScope: () => null, // One organization row per organization; the negative is cross-org.
    insertRow: () => ({
      id: randomUUID(),
      name: 'Injected Organization',
      slug: `injected-${randomUUID()}`,
      status: 'active',
    }),
    patch: { patch: { name: TAMPERED }, column: 'name' },
  },

  profiles: {
    anyRow: (f) => f.profiles[secondaryTenantKey(f)] ?? '',
    orgRow: (f) => f.profiles[secondaryTenantKey(f)] ?? '',
    inScope: ownProfile,
    outOfScope: (f, role) =>
      role === 'tenant' || role === 'service_provider'
        ? (f.profiles[`${f.key.toLowerCase()}_admin`] ?? null)
        : null,
    // Staff may READ a colleague's profile (R self + same-org) but never UPDATE it.
    writeOutOfScope: (f) => f.profiles[secondaryTenantKey(f)] ?? null,
    insertRow: () => ({
      id: randomUUID(),
      // A random auth user: the foreign key is checked after RLS, so this payload can
      // only fail on authorization.
      auth_user_id: randomUUID(),
      full_name: 'Injected Person',
      email: `injected-${randomUUID()}@example.test`,
    }),
    patch: { patch: { phone: '+971599999999' }, column: 'phone' },
    noopPatch: { patch: { phone: '+971500000000' }, column: 'phone' },
  },

  organization_members: {
    anyRow: (f) => f.members[secondaryTenantKey(f)] ?? '',
    orgRow: (f) => f.members[secondaryTenantKey(f)] ?? '',
    inScope: ownMember,
    outOfScope: (f, role) =>
      role === 'tenant' || role === 'service_provider'
        ? (f.members[`${f.key.toLowerCase()}_admin`] ?? null)
        : null,
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      profile_id: randomUUID(),
      role: 'property_manager',
      status: 'active',
    }),
    patch: { patch: { status: 'disabled' }, column: 'status' },
    // Re-asserting the current value: exercises the policy without disabling anyone.
    noopPatch: { patch: { status: 'active' }, column: 'status' },
  },

  properties: {
    anyRow: (f) => f.properties.p1,
    inScope: (f) => f.properties.p1,
    outOfScope: (f) => f.properties.p2,
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      name: 'Injected Tower',
      property_type: 'apartment_building',
      address_line: 'Plot 1, Nowhere',
      city: 'Dubai',
      emirate: 'Dubai',
      status: 'active',
    }),
    patch: { patch: { name: TAMPERED }, column: 'name' },
    noopPatch: { patch: { status: 'active' }, column: 'status' },
  },

  property_units: {
    anyRow: (f) => f.units.p1u1,
    inScope: (f) => f.units.p1u1,
    // The owner owns P1 entirely, so their negative must be in P2. A tenant leases only
    // 1204, so 1808 in the same building is the sharper negative; same for a provider,
    // whose assigned ticket is on 1204.
    outOfScope: (f, role) => (role === 'property_owner' ? f.units.p2u1 : f.units.p1u2),
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      property_id: f.properties.p1,
      unit_number: `X-${randomUUID().slice(0, 8)}`,
      status: 'available',
    }),
    patch: { patch: { status: 'inactive' }, column: 'status' },
    noopPatch: { patch: { status: 'occupied' }, column: 'status' },
  },

  tenants: {
    anyRow: (f) => f.tenants.t1,
    inScope: (f) => f.tenants.t1,
    outOfScope: (f) => f.tenants.t2,
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      full_name: 'Injected Resident',
      email: `injected-${randomUUID()}@example.test`,
    }),
    // NOT `phone`, and not `email` either, since migration 0004.
    //
    // 0004 revoked SELECT on tenants.email and tenants.phone from EVERY client role,
    // staff included — row level security filters rows, not columns, and all five
    // application roles share the one Postgres role `authenticated`. Staff read them
    // through the tenant_contact(p_organization_id, p_tenant_id) RPC instead.
    //
    // The write helpers read the patched column back through a principal entitled to
    // see the row, to prove a refused UPDATE changed nothing. With `phone` here that
    // verification read now returns 42501, and `readColumn` correctly raises — the
    // harness being unable to check the row, reported as a harness fault rather than
    // mistaken for a security finding. `full_name` is both writable and readable, so
    // the assertion means the same thing it always did.
    patch: { patch: { full_name: TAMPERED }, column: 'full_name' },
    noopPatch: { patch: { full_name: SHARED_SHAPE.tenantNames[0] }, column: 'full_name' },
  },

  tenancies: {
    anyRow: (f) => f.tenancies.tc1,
    inScope: (f) => f.tenancies.tc1,
    outOfScope: (f, role) => (role === 'property_owner' ? f.tenancies.tc3 : f.tenancies.tc2),
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      property_unit_id: f.units.p2u2,
      tenant_id: f.tenants.t1,
      contract_number: `EJARI-INJECTED-${randomUUID().slice(0, 8)}`,
      start_date: '2026-06-01',
      end_date: '2027-05-31',
      rent_amount: '1.00',
      currency: 'AED',
      status: 'draft',
    }),
    patch: { patch: { status: 'terminated' }, column: 'status' },
    noopPatch: { patch: { status: 'active' }, column: 'status' },
  },

  service_providers: {
    anyRow: (f) => f.providers.sp1,
    inScope: (f) => f.providers.sp1,
    outOfScope: (f) => f.providers.sp2,
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      company_name: 'Injected Contracting',
      service_categories: ['hvac'],
      status: 'active',
    }),
    patch: { patch: { status: 'inactive' }, column: 'status' },
    noopPatch: { patch: { status: 'active' }, column: 'status' },
  },

  maintenance_tickets: {
    anyRow: (f) => f.tickets.k1,
    inScope: (f) => f.tickets.k1,
    // The owner's negative is the ticket on the building they do not own; the tenant's
    // is the other tenant's ticket; the provider's is the unassigned ticket on the very
    // unit they are working in — the hardest case for an assignment policy.
    outOfScope: (f, role) => {
      if (role === 'property_owner') return f.tickets.k4;
      if (role === 'service_provider') return f.tickets.k2;
      return f.tickets.k3;
    },
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      property_id: f.properties.p1,
      property_unit_id: f.units.p1u1,
      tenancy_id: f.tenancies.tc1,
      tenant_id: f.tenants.t1,
      title: SHARED_SHAPE.ticketTitles[0],
      description: 'Injected by the isolation suite.',
      category: 'hvac',
      priority: 'normal',
      status: 'open',
      source: 'web',
    }),
    // A tenant filing a ticket against the OTHER tenant's unit, in their own
    // organization. Structurally perfect; must still be refused.
    insertOutOfScope: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      property_id: f.properties.p1,
      property_unit_id: f.units.p1u2,
      tenancy_id: f.tenancies.tc2,
      tenant_id: f.tenants.t2,
      title: SHARED_SHAPE.ticketTitles[0],
      description: 'Filed against a unit the caller does not lease.',
      category: 'hvac',
      priority: 'normal',
      status: 'open',
      source: 'web',
    }),
    patch: { patch: { priority: 'urgent' }, column: 'priority' },
    noopPatch: { patch: { priority: 'normal' }, column: 'priority' },
  },

  maintenance_activities: {
    anyRow: (f) => f.activities.a1,
    inScope: (f) => f.activities.a1,
    outOfScope: (f, role) => {
      if (role === 'property_owner') return f.activities.a4;
      if (role === 'service_provider') return f.activities.a2;
      return f.activities.a3;
    },
    insertRow: ({ f, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      ticket_id: f.tickets.k1,
      actor_profile_id: actorProfileId,
      activity_type: 'note',
      description: 'Injected by the isolation suite.',
      metadata: {},
    }),
    // A tenant writing history onto another tenant's ticket; a provider writing onto a
    // ticket nobody assigned them.
    insertOutOfScope: ({ f, role, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      ticket_id: role === 'service_provider' ? f.tickets.k2 : f.tickets.k3,
      actor_profile_id: actorProfileId,
      activity_type: 'note',
      description: 'Written onto a ticket outside the caller’s scope.',
      metadata: {},
    }),
    patch: { patch: { description: TAMPERED }, column: 'description' },
  },

  documents: {
    anyRow: (f) => f.documents.d1,
    inScope: (f, role) => (role === 'service_provider' ? f.documents.evidence : f.documents.d1),
    outOfScope: (f, role) => (role === 'service_provider' ? f.documents.d1 : f.documents.d2),
    insertRow: ({ f, role, actorProfileId, capabilities }) => {
      const isProvider = role === 'service_provider';
      return {
        id: randomUUID(),
        organization_id: f.organizationId,
        // A provider's evidence must be ticket-scoped and NOTHING else:
        // documents_insert_provider_assigned forces property_id and tenancy_id null,
        // because a row stapled to an arbitrary tenancy or property would become
        // visible to that tenancy's tenant and that property's owner.
        property_id: isProvider ? null : f.properties.p1,
        tenancy_id: isProvider ? null : f.tenancies.tc1,
        document_type: isProvider ? 'completion_evidence' : 'tenancy_contract',
        storage_path: `${f.organizationId}/${isProvider ? 'tickets' : 'tenancies'}/${randomUUID()}.pdf`,
        verification_status: 'pending',
        // documents_insert_staff requires uploaded_by = current_profile_id().
        uploaded_by: actorProfileId,
        // Amendment A7 scopes a provider's evidence to the assigned ticket.
        ...(isProvider && capabilities.documentsHasTicketId ? { ticket_id: f.tickets.k1 } : {}),
      };
    },
    // A provider attaching evidence to a ticket assigned to somebody else.
    insertOutOfScope: ({ f, actorProfileId, capabilities }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      property_id: null,
      tenancy_id: null,
      document_type: 'completion_evidence',
      storage_path: `${f.organizationId}/tickets/${randomUUID()}.pdf`,
      verification_status: 'pending',
      uploaded_by: actorProfileId,
      ...(capabilities.documentsHasTicketId ? { ticket_id: f.tickets.k3 } : {}),
    }),
    patch: { patch: { verification_status: 'verified' }, column: 'verification_status' },
    noopPatch: { patch: { verification_status: 'pending' }, column: 'verification_status' },
  },

  ai_conversations: {
    anyRow: (f) => f.conversations.c1,
    inScope: (f) => f.conversations.c1,
    outOfScope: (f) => f.conversations.c2,
    insertRow: ({ f, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      user_profile_id: actorProfileId,
      channel: 'web',
      status: 'active',
    }),
    // A conversation opened in another person's name — the shape of an impersonation.
    insertOutOfScope: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      user_profile_id: f.profiles[secondaryTenantKey(f)],
      channel: 'web',
      status: 'active',
    }),
    patch: { patch: { status: 'closed' }, column: 'status' },
  },

  ai_messages: {
    anyRow: (f) => f.messages.m1,
    inScope: (f) => f.messages.m1,
    outOfScope: (f) => f.messages.m2,
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      conversation_id: f.conversations.c1,
      sender_type: 'user',
      content: 'Injected by the isolation suite.',
      metadata: {},
    }),
    // A turn written into another tenant's conversation.
    insertOutOfScope: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      conversation_id: f.conversations.c2,
      sender_type: 'user',
      content: 'Written into a conversation the caller does not own.',
      metadata: {},
    }),
    patch: { patch: { content: TAMPERED }, column: 'content' },
  },

  notifications: {
    anyRow: (f) => f.notifications[`${f.key.toLowerCase()}_admin`] ?? '',
    inScope: ownNotification,
    outOfScope: (f, role) =>
      role === 'organization_admin'
        ? (f.notifications[`${f.key.toLowerCase()}_manager`] ?? null)
        : (f.notifications[`${f.key.toLowerCase()}_admin`] ?? null),
    insertRow: ({ f, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      recipient_profile_id: actorProfileId,
      channel: 'in_app',
      event_type: 'injected.event',
      payload: {},
      status: 'queued',
      retry_count: 0,
    }),
    patch: { patch: { status: 'sent' }, column: 'status' },
  },

  audit_logs: {
    anyRow: (f) => f.auditLogs.al1,
    inScope: (f, role) => (role === 'organization_admin' ? f.auditLogs.al1 : null),
    outOfScope: () => null,
    insertRow: ({ f, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      actor_profile_id: actorProfileId,
      action: 'injected.action',
      entity_type: 'property',
      entity_id: f.properties.p1,
      metadata: {},
    }),
    patch: { patch: { action: TAMPERED }, column: 'action' },
  },

  organization_invitations: {
    anyRow: (f) => f.invitations.inv1,
    inScope: (f, role) => (role === 'organization_admin' ? f.invitations.inv1 : null),
    outOfScope: () => null,
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      email: `injected-${randomUUID()}@example.test`,
      role: 'organization_admin',
      token_hash: `injected-${randomUUID()}`,
      status: 'pending',
      expires_at: '2030-01-01T00:00:00.000Z',
    }),
    patch: { patch: { status: 'revoked' }, column: 'status' },
    // token_hash is deliberately not granted to any client role, so `select *` fails.
    columns: 'id,organization_id,email,role,status,expires_at',
  },

  /* ------------------------------------------------- migration 0004, agentic -- */

  // A chunk is readable by exactly whoever may read its parent document, so every row
  // below is chosen by which DOCUMENT it hangs off, mirroring the `documents` probe:
  //   d1       -> property P1 + tenancy TC1  : staff, the owner of P1, tenant T1
  //   d2       -> property P2 + tenancy TC3  : staff, tenant T2
  //   evidence -> ticket K1 only             : staff, the assigned provider SP1
  // The negatives are therefore the sharpest available: the owner is refused the chunk
  // of the building they do not own, the tenant the chunk of the other tenant's
  // contract, the provider the chunk of a contract they have no business reading.
  document_chunks: {
    anyRow: (f) => f.documentChunks.d1,
    orgRow: (f) => f.documentChunks.d2,
    inScope: (f, role) =>
      role === 'service_provider' ? f.documentChunks.evidence : f.documentChunks.d1,
    outOfScope: (f, role) =>
      role === 'service_provider' ? f.documentChunks.d1 : f.documentChunks.d2,
    // No client INSERT policy and no INSERT privilege: chunks are derived data written
    // by the embedding worker under the service role. A client that could write a chunk
    // could poison retrieval for its own organization, which is the one injection
    // vector a RAG store has. Structurally valid so the refusal can only be
    // authorization: a real parent document, a chunk_index that satisfies `>= 0`, and
    // an index far from the seeded 0 so a unique violation cannot masquerade as one.
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      document_id: f.documents.d1,
      chunk_index: 900 + Math.floor(Math.random() * 90),
      content: 'Injected by the isolation suite.',
      token_count: 8,
    }),
    patch: { patch: { content: TAMPERED }, column: 'content' },
  },

  // Staff read their own organization's inbox. The in-organization negative is the
  // UNATTRIBUTED message — organization_id null, status `unmatched` — which belongs to
  // no organization and must be visible to none. That row is the whole reason the
  // column is nullable: a sender we cannot map to exactly one tenant is left
  // unattributed rather than guessed into an organization, and guessing wrong would
  // cross the exact boundary this project exists to defend.
  inbound_messages: {
    anyRow: (f) => f.inboundMessages.im1,
    orgRow: (f) => f.inboundMessages.im1,
    inScope: (f, role) =>
      role === 'organization_admin' || role === 'property_manager' ? f.inboundMessages.im1 : null,
    outOfScope: (f) => f.inboundMessages.unattributed,
    // Service-role only: no INSERT policy, INSERT revoked. A client that could write
    // here could forge the evidence an AI classification was based on.
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      provider: 'whatsapp',
      external_message_id: `wamid.injected.${randomUUID()}`,
      from_identifier: SHARED_SHAPE.tenantPhones[0],
      body: 'Injected by the isolation suite.',
      status: 'received',
    }),
    patch: { patch: { body: TAMPERED }, column: 'body' },
  },

  agent_runs: {
    anyRow: (f) => f.agentRuns.ar1,
    orgRow: (f) => f.agentRuns.ar1,
    inScope: (f, role) =>
      role === 'organization_admin' || role === 'property_manager' ? f.agentRuns.ar1 : null,
    outOfScope: () => null, // Staff read organization-wide; the negative is cross-org.
    insertRow: ({ f, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      // agent_runs_insert_staff pins this to current_profile_id().
      actor_profile_id: actorProfileId,
      input: 'Injected by the isolation suite.',
      status: 'running',
    }),
    // A run attributed to a COLLEAGUE: same organization, structurally perfect, and
    // refused. Without this the `actor_profile_id = current_profile_id()` clause could
    // be deleted and every assertion would still pass.
    insertOutOfScope: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      actor_profile_id: f.profiles[secondaryTenantKey(f)],
      input: 'Started in somebody else`s name.',
      status: 'running',
    }),
    patch: { patch: { status: 'cancelled' }, column: 'status' },
    noopPatch: { patch: { status: 'running' }, column: 'status' },
  },

  // The decision surface. There is no UPDATE policy and no UPDATE privilege, so every
  // role's UPDATE probe below asserts the absence that makes "the model proposes, a
  // human commits" structural (CLAUDE.md rule 7) — the patch is the transition a
  // compromised client would most want, and it must fail with 42501.
  agent_proposals: {
    anyRow: (f) => f.agentProposals.ap1,
    orgRow: (f) => f.agentProposals.ap1,
    inScope: (f, role) =>
      role === 'organization_admin' || role === 'property_manager' ? f.agentProposals.ap1 : null,
    outOfScope: () => null, // Staff read organization-wide; the negative is cross-org.
    insertRow: ({ f }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      run_id: f.agentRuns.ar1,
      tool_name: SHARED_SHAPE.proposalTool,
      arguments: { property_unit_id: f.units.p1u1, category: 'hvac' },
      rationale: 'Injected by the isolation suite.',
      status: 'pending',
      decided_by: null,
      decided_at: null,
    }),
    // A proposal BORN APPROVED — the shape of a model committing its own work without a
    // human in between. It satisfies agent_proposals_decision_consistent exactly (a
    // decided row names its decider and when), so the only thing that can refuse it is
    // the policy's `status = 'pending' and decided_by is null` clause.
    insertOutOfScope: ({ f, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      run_id: f.agentRuns.ar1,
      tool_name: SHARED_SHAPE.proposalTool,
      arguments: { property_unit_id: f.units.p1u1, category: 'hvac' },
      rationale: 'Approved by nobody.',
      status: 'approved',
      decided_by: actorProfileId,
      decided_at: '2026-06-01T00:00:00.000Z',
    }),
    patch: { patch: { status: 'approved' }, column: 'status' },
  },

  /* ----------------------------------- migration 0006, the outbound ledger -- */

  // What we SENT a tenant. Staff of the owning organization read it; NOBODY else does,
  // and the role that is most surprising to refuse is the tenant the message was
  // addressed to. They already have the text — it arrived on their phone. What the row
  // adds is `drafted_by` (was this reply written by the model?), `sent_by_profile_id`
  // (which member of staff released it) and the delivery state, none of which is the
  // tenant's to see. So the matrix gives tenant, owner and provider `none`, and the
  // generated suite proves it with `expectNothingVisible` against a fixture whose rows
  // are addressed to that very tenant's phone number.
  //
  // `outOfScope` is null on purpose: staff read organization-wide, so there is no
  // in-organization negative for them, and the boundary that matters is the
  // cross-organization one — asserted for every role, in both directions for staff, by
  // cross-organization.test.ts.
  outbound_messages: {
    anyRow: (f) => f.outboundMessages.om1,
    orgRow: (f) => f.outboundMessages.om1,
    inScope: (f, role) =>
      role === 'organization_admin' || role === 'property_manager' ? f.outboundMessages.om1 : null,
    outOfScope: () => null,
    // Service-role only: no INSERT policy and no INSERT privilege. A client that could
    // write here could send a message to a tenant's real phone number in the
    // organization's name — or, worse, fabricate the record of one it never sent and
    // have the ledger agree with it.
    //
    // Structurally exact so a refusal can only be authorization. Every NOT NULL is
    // populated, both enumerations take a legal value, and the row is deliberately
    // `kind='staff_reply'` with `inbound_message_id` null: the partial unique index
    // allows at most one `acknowledgement` per inbound message, and a payload that
    // tripped it would come back 23505, which looks like a denial and proves nothing.
    // `status='queued'` with no `sent_at` and no `provider_message_id` is the only
    // internally consistent not-yet-sent shape, so no delivery-consistency check can
    // reject it before RLS is reached either.
    insertRow: ({ f, actorProfileId }) => ({
      id: randomUUID(),
      organization_id: f.organizationId,
      inbound_message_id: null,
      tenant_id: f.tenants.t1,
      to_identifier: SHARED_SHAPE.tenantPhones[0],
      body: 'Injected by the isolation suite.',
      kind: 'staff_reply',
      drafted_by: 'human',
      sent_by_profile_id: actorProfileId,
      provider: 'whatsapp',
      provider_message_id: null,
      status: 'queued',
    }),
    // The patch a compromised client would most want: rewrite what the record says we
    // told a tenant. There is no UPDATE policy and no UPDATE privilege, so this must
    // fail with 42501 rather than quietly matching zero rows.
    patch: { patch: { body: TAMPERED }, column: 'body' },
  },
};

/** Fails fast if a table ever gains a row in the registry without a probe. */
export function assertProbeCoverage(): void {
  const missing = TENANT_SCOPED_TABLES.filter((t) => !(t in PROBES));
  if (missing.length > 0) {
    throw new Error(
      `No probe defined for: ${missing.join(', ')}. Every tenant-scoped table needs one, ` +
        'or the cross-organization suite silently skips it.',
    );
  }
}

export const probeColumns = (table: TenantScopedTable) => PROBES[table].columns ?? 'id';
