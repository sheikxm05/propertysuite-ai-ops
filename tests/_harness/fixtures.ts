/**
 * Fixture builder. Lane w0-l6.
 *
 * Seeds two organizations whose data is deliberately INDISTINGUISHABLE: the same
 * property names, the same unit numbers, the same tenant names, the same ticket titles,
 * the same contract number. If a policy leaks, the leaked row looks exactly like a row
 * the caller is entitled to see, so the only thing that can catch it is an identifier
 * comparison — which is what every assertion in tests/rls does.
 *
 * Seeding runs through the service-role client, which bypasses RLS. That is the only
 * legitimate use of it in this lane: building the world. No assertion ever touches it.
 *
 * Every row id is derived from a stable key (make-jwts.mjs `fixtureId`), so seeding is
 * an upsert and re-running the suite against an un-reset database is idempotent.
 *
 * Shape, per organization — the asymmetries are all load-bearing:
 *
 *   properties      P1 "Marina Heights Tower"            owned by the owner principal
 *                   P2 "Downtown Boulevard Residences"   owned by nobody
 *   units           P1/1204, P1/1808, P2/1204, P2/1808   same numbers in both properties
 *   tenants         T1 (the tenant principal), T2 (the secondary tenant principal)
 *   tenancies       TC1 T1 -> P1/1204, TC2 T2 -> P1/1808, TC3 T2 -> P2/1204
 *   providers       SP1 (the provider principal), SP2 (unused by the principal)
 *   tickets         K1 P1/1204 T1 assigned to SP1      <- the provider's ONLY job
 *                   K2 P1/1204 T1 open, unassigned
 *                   K3 P1/1808 T2 in_progress, SP2
 *                   K4 P2/1204 T2 open, unassigned     <- outside the owner's property
 *   documents       D1 -> P1 + TC1    D2 -> P2 + TC3
 *   conversations   C1 (tenant principal), C2 (secondary tenant)
 *   notifications   one per principal
 *   audit_logs      one row
 *   invitations     one pending invitation
 *   chunks          one per document, so a chunk inherits its parent's visibility
 *   inbound         IM1 attributed, linked to K1; plus ONE global unattributed message
 *                   with organization_id null, which must be visible to nobody
 *   agent runs      AR1 started by the admin
 *   proposals       AP1 pending on AR1 — inert until a human approves it by RPC
 *   outbound        OM1 the automatic acknowledgement for IM1 (drafted_by system)
 *                   OM2 the reply a human released (drafted_by ai + sent_by_profile_id)
 *                   both addressed to T1's own phone, and readable by STAFF ONLY
 *
 * So: the owner sees P1 and everything hanging off it and nothing from P2; the tenant
 * sees only unit 1204 of P1 and their own two tickets; the provider sees exactly K1.
 */

import type { Row, SetupClient } from './driver';
import type { JwtFactoryModule, OrgKey, PrincipalDescriptor } from './jwt-factory';

export interface OrgFixture {
  key: OrgKey;
  organizationId: string;
  slug: string;
  name: string;
  /** Keyed by principal key, e.g. `a_manager`. */
  profiles: Record<string, string>;
  members: Record<string, string>;
  properties: { p1: string; p2: string };
  units: { p1u1: string; p1u2: string; p2u1: string; p2u2: string };
  tenants: { t1: string; t2: string };
  tenancies: { tc1: string; tc2: string; tc3: string };
  providers: { sp1: string; sp2: string };
  tickets: { k1: string; k2: string; k3: string; k4: string };
  activities: { a1: string; a2: string; a3: string; a4: string };
  documents: { d1: string; d2: string; evidence: string };
  conversations: { c1: string; c2: string };
  messages: { m1: string; m2: string };
  notifications: Record<string, string>;
  auditLogs: { al1: string };
  invitations: { inv1: string };
  /**
   * Migration 0004. One chunk per seeded document, so a chunk inherits exactly the
   * visibility of its parent: `d1` is staff + owner-of-P1 + tenant-of-TC1, `d2` is
   * staff + tenant2, `evidence` is staff + the assigned provider.
   */
  documentChunks: { d1: string; d2: string; evidence: string };
  /**
   * `im1` is attributed to this organization and linked to ticket K1.
   *
   * `unattributed` is the SAME row id in both organizations on purpose: it is one
   * global row with `organization_id is null`, the message from a sender the resolver
   * could not map to exactly one tenant. It must be visible to NOBODY, so it is the
   * in-organization negative for the staff read.
   */
  inboundMessages: { im1: string; unattributed: string };
  agentRuns: { ar1: string };
  agentProposals: { ap1: string };
  /**
   * Migration 0006. What we SENT this organization's tenant, on their phone.
   *
   * `om1` is the automatic acknowledgement for `im1` — `kind='acknowledgement'`,
   * `drafted_by='system'`, nobody's name on it. `om2` is the reply a human released:
   * `drafted_by='ai'` with `sent_by_profile_id` set, which is the pair that records
   * CLAUDE.md rule 7 actually happening. Two rows rather than one because collapsing
   * them would leave the provenance columns untested by anything.
   *
   * Both are addressed to tenant T1 at `tenantPhones[0]`, which is what makes the
   * tenant negative sharp: the tenant looks for a message sent to their own number,
   * about their own ticket, and still gets nothing. They have it on WhatsApp; the row
   * is staff infrastructure.
   */
  outboundMessages: { om1: string; om2: string };
  /** Object paths seeded into the private bucket, `{org}/{entity}/{uuid}.pdf`. */
  objects: { d1: string; d2: string };
}

export interface Fixture {
  A: OrgFixture;
  B: OrgFixture;
  /** Schema features the suite probes for rather than assumes. */
  capabilities: { documentsHasTicketId: boolean };
}

/** Values that must be identical across both organizations. See the file header. */
export const SHARED_SHAPE = {
  propertyNames: ['Marina Heights Tower', 'Downtown Boulevard Residences'],
  unitNumbers: ['1204', '1808'],
  tenantNames: ['Omar Haddad', 'Layla Nasser'],
  tenantEmails: ['omar.haddad@resident.test', 'layla.nasser@resident.test'],
  tenantPhones: ['+971500000101', '+971500000102'],
  providerNames: ['Gulf Cool Technical Services', 'Gulf Cool Maintenance LLC'],
  contractNumbers: ['EJARI-2026-000421', 'EJARI-2026-000422', 'EJARI-2026-000423'],
  ticketTitles: [
    'Air conditioning not cooling',
    'Kitchen sink leaking under the cupboard',
    'Air conditioning not cooling',
    'Lift making a grinding noise',
  ],
  documentType: 'tenancy_contract',
  auditAction: 'tenancy.created',
  aiMessage: 'The air conditioning in my apartment has stopped cooling since yesterday.',
  // Migration 0004. Identical in both organizations, like everything else here: a
  // leaked chunk, message or proposal must be impossible to tell from one the caller is
  // entitled to, so only an identifier comparison can catch it.
  chunkContent:
    'Clause 7.2 — The landlord shall maintain the air conditioning system in working order.',
  inboundMessageBody: 'The AC in 1204 is still not cooling. Can someone come today?',
  agentInstruction: 'Summarise the open maintenance tickets for Marina Heights Tower.',
  proposalTool: 'create_maintenance_ticket',
  // Migration 0006. Identical in both organizations for the same reason as everything
  // else here: if the outbound ledger leaks, the leaked row must be indistinguishable
  // from one the caller is entitled to, so only an identifier comparison can catch it.
  outboundAcknowledgementBody: 'Thanks — we have logged your request and will be in touch.',
  outboundStaffReplyBody: 'A technician is booked for tomorrow between 9am and 11am.',
} as const;

const ORG_KEYS: readonly OrgKey[] = ['A', 'B'];

function ids(factory: JwtFactoryModule, org: OrgKey) {
  const id = (what: string) => factory.fixtureId(`${org}:${what}`);
  return {
    organizationId: id('organization'),
    properties: { p1: id('property:1'), p2: id('property:2') },
    units: {
      p1u1: id('unit:1:1204'),
      p1u2: id('unit:1:1808'),
      p2u1: id('unit:2:1204'),
      p2u2: id('unit:2:1808'),
    },
    tenants: { t1: id('tenant:1'), t2: id('tenant:2') },
    tenancies: { tc1: id('tenancy:1'), tc2: id('tenancy:2'), tc3: id('tenancy:3') },
    providers: { sp1: id('provider:1'), sp2: id('provider:2') },
    tickets: { k1: id('ticket:1'), k2: id('ticket:2'), k3: id('ticket:3'), k4: id('ticket:4') },
    activities: {
      a1: id('activity:1'),
      a2: id('activity:2'),
      a3: id('activity:3'),
      a4: id('activity:4'),
    },
    documents: { d1: id('document:1'), d2: id('document:2'), evidence: id('document:evidence') },
    conversations: { c1: id('conversation:1'), c2: id('conversation:2') },
    messages: { m1: id('message:1'), m2: id('message:2') },
    auditLogs: { al1: id('audit:1') },
    invitations: { inv1: id('invitation:1') },
    documentChunks: {
      d1: id('chunk:document:1'),
      d2: id('chunk:document:2'),
      evidence: id('chunk:document:evidence'),
    },
    inboundMessages: {
      im1: id('inbound_message:1'),
      // Deliberately NOT organization-keyed: there is one unattributed message in the
      // whole database, belonging to neither organization. Seeded on both passes (the
      // second is an idempotent no-op) so either organization's fixture can name it.
      unattributed: factory.fixtureId('shared:inbound_message:unattributed'),
    },
    agentRuns: { ar1: id('agent_run:1') },
    agentProposals: { ap1: id('agent_proposal:1') },
    outboundMessages: { om1: id('outbound_message:1'), om2: id('outbound_message:2') },
  };
}

/**
 * Does `documents.ticket_id` exist? Amendment A7 depends on it: 0003 adds the column and
 * then calls 0002's `ensure_document_provider_policies()`. Probed rather than assumed, so
 * a half-applied migration reports itself instead of looking like an RLS finding.
 */
async function detectDocumentsTicketId(setup: SetupClient): Promise<boolean> {
  return setup.hasColumn('documents', 'ticket_id');
}

const isoDate = (offsetDays: number) => {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function seedOrganization(
  setup: SetupClient,
  factory: JwtFactoryModule,
  org: OrgKey,
  userIdByPrincipal: Map<string, string>,
  capabilities: { documentsHasTicketId: boolean },
): Promise<OrgFixture> {
  const f = ids(factory, org);
  const descriptor = factory.ORGANIZATIONS[org];
  const principals = factory.PRINCIPALS.filter((p) => p.org === org);
  const byRole = (role: string, slot?: string) => {
    const hit = principals.find((p) => p.role === role && (slot ? p.slot === slot : p.core));
    if (!hit) throw new Error(`Fixture: no principal for ${org}/${role}/${slot ?? 'core'}`);
    return hit;
  };

  const admin = byRole('organization_admin');
  const manager = byRole('property_manager');
  const owner = byRole('property_owner');
  const tenant = byRole('tenant', 'tenant');
  const tenant2 = byRole('tenant', 'tenant2');
  const provider = byRole('service_provider');

  await setup.upsert('organizations', [
    {
      id: f.organizationId,
      name: descriptor.name,
      slug: descriptor.slug,
      status: 'active',
    },
  ]);

  // 0003 creates a profile from an auth.users trigger. Upserting here keeps the suite
  // runnable whether or not that trigger has landed, and pins the ids either way.
  await setup.upsert(
    'profiles',
    principals.map((p: PrincipalDescriptor) => ({
      id: p.profileId,
      auth_user_id: userIdByPrincipal.get(p.key),
      full_name: p.fullName,
      email: p.email,
      phone: '+971500000000',
    })),
  );

  await setup.upsert(
    'organization_members',
    principals.map((p) => ({
      id: p.memberId,
      organization_id: f.organizationId,
      profile_id: p.profileId,
      role: p.role,
      status: 'active',
    })),
  );

  await setup.upsert('properties', [
    {
      id: f.properties.p1,
      organization_id: f.organizationId,
      name: SHARED_SHAPE.propertyNames[0],
      property_type: 'apartment_building',
      address_line: 'Plot 12, Dubai Marina',
      city: 'Dubai',
      emirate: 'Dubai',
      owner_member_id: owner.memberId,
      status: 'active',
    },
    {
      id: f.properties.p2,
      organization_id: f.organizationId,
      name: SHARED_SHAPE.propertyNames[1],
      property_type: 'apartment_building',
      address_line: 'Plot 40, Downtown Dubai',
      city: 'Dubai',
      emirate: 'Dubai',
      owner_member_id: null,
      status: 'active',
    },
  ]);

  await setup.upsert('property_units', [
    {
      id: f.units.p1u1,
      organization_id: f.organizationId,
      property_id: f.properties.p1,
      unit_number: SHARED_SHAPE.unitNumbers[0],
      bedrooms: 2,
      bathrooms: 2,
      area_sqft: 1240.5,
      status: 'occupied',
    },
    {
      id: f.units.p1u2,
      organization_id: f.organizationId,
      property_id: f.properties.p1,
      unit_number: SHARED_SHAPE.unitNumbers[1],
      bedrooms: 1,
      bathrooms: 1,
      area_sqft: 810.0,
      status: 'occupied',
    },
    {
      id: f.units.p2u1,
      organization_id: f.organizationId,
      property_id: f.properties.p2,
      unit_number: SHARED_SHAPE.unitNumbers[0],
      bedrooms: 2,
      bathrooms: 2,
      area_sqft: 1240.5,
      status: 'occupied',
    },
    {
      id: f.units.p2u2,
      organization_id: f.organizationId,
      property_id: f.properties.p2,
      unit_number: SHARED_SHAPE.unitNumbers[1],
      bedrooms: 1,
      bathrooms: 1,
      area_sqft: 810.0,
      status: 'available',
    },
  ]);

  await setup.upsert('tenants', [
    {
      id: f.tenants.t1,
      organization_id: f.organizationId,
      profile_id: tenant.profileId,
      full_name: SHARED_SHAPE.tenantNames[0],
      email: SHARED_SHAPE.tenantEmails[0],
      phone: SHARED_SHAPE.tenantPhones[0],
    },
    {
      id: f.tenants.t2,
      organization_id: f.organizationId,
      profile_id: tenant2.profileId,
      full_name: SHARED_SHAPE.tenantNames[1],
      email: SHARED_SHAPE.tenantEmails[1],
      phone: SHARED_SHAPE.tenantPhones[1],
    },
  ]);

  await setup.upsert('tenancies', [
    {
      id: f.tenancies.tc1,
      organization_id: f.organizationId,
      property_unit_id: f.units.p1u1,
      tenant_id: f.tenants.t1,
      contract_number: SHARED_SHAPE.contractNumbers[0],
      start_date: isoDate(0),
      end_date: isoDate(364),
      rent_amount: '95000.00',
      currency: 'AED',
      status: 'active',
    },
    {
      id: f.tenancies.tc2,
      organization_id: f.organizationId,
      property_unit_id: f.units.p1u2,
      tenant_id: f.tenants.t2,
      contract_number: SHARED_SHAPE.contractNumbers[1],
      start_date: isoDate(0),
      end_date: isoDate(364),
      rent_amount: '72000.00',
      currency: 'AED',
      status: 'active',
    },
    {
      id: f.tenancies.tc3,
      organization_id: f.organizationId,
      property_unit_id: f.units.p2u1,
      tenant_id: f.tenants.t2,
      contract_number: SHARED_SHAPE.contractNumbers[2],
      start_date: isoDate(0),
      end_date: isoDate(364),
      rent_amount: '88000.00',
      currency: 'AED',
      status: 'active',
    },
  ]);

  await setup.upsert('service_providers', [
    {
      id: f.providers.sp1,
      organization_id: f.organizationId,
      profile_id: provider.profileId,
      company_name: SHARED_SHAPE.providerNames[0],
      service_categories: ['hvac', 'plumbing'],
      status: 'active',
    },
    {
      id: f.providers.sp2,
      organization_id: f.organizationId,
      profile_id: null,
      company_name: SHARED_SHAPE.providerNames[1],
      service_categories: ['electrical'],
      status: 'active',
    },
  ]);

  // `status` and `assigned_provider_id` are deliberately absent from the payload.
  //
  // §4 requires a ticket to be inserted as `open`, which the column default gives us.
  // More importantly, re-seeding must not try to UPDATE the status: on a second run the
  // row already sits at `in_progress`, and writing `open` over it is an illegal
  // transition that the trigger correctly rejects. Omitting the column leaves the
  // status to `ensureTicketStatus`, which walks forward from wherever the row actually
  // is — so seeding is idempotent against a live database rather than only against a
  // freshly reset one.
  const ticketBase = (id: string, unit: string, property: string, tenantId: string, i: number) => ({
    id,
    organization_id: f.organizationId,
    property_id: property,
    property_unit_id: unit,
    tenant_id: tenantId,
    title: SHARED_SHAPE.ticketTitles[i],
    description: 'Reported through the tenant portal. Seeded fixture row.',
    category: i === 1 ? 'plumbing' : 'hvac',
    priority: 'normal',
    source: 'web',
  });

  await setup.upsert('maintenance_tickets', [
    {
      ...ticketBase(f.tickets.k1, f.units.p1u1, f.properties.p1, f.tenants.t1, 0),
      tenancy_id: f.tenancies.tc1,
    },
    {
      ...ticketBase(f.tickets.k2, f.units.p1u1, f.properties.p1, f.tenants.t1, 1),
      tenancy_id: f.tenancies.tc1,
    },
    {
      ...ticketBase(f.tickets.k3, f.units.p1u2, f.properties.p1, f.tenants.t2, 2),
      tenancy_id: f.tenancies.tc2,
    },
    {
      ...ticketBase(f.tickets.k4, f.units.p2u1, f.properties.p2, f.tenants.t2, 3),
      tenancy_id: f.tenancies.tc3,
    },
  ]);

  await ensureTicketStatus(setup, f.tickets.k1, 'assigned', f.providers.sp1);
  await ensureTicketStatus(setup, f.tickets.k3, 'in_progress', f.providers.sp2);

  // Append-only: insert-or-skip, never insert-or-update. 0003's
  // maintenance_activities_block_update trigger refuses an UPDATE even to the table
  // owner, which is exactly the guarantee negative-writes.test.ts asserts.
  await setup.upsert(
    'maintenance_activities',
    [
      {
        id: f.activities.a1,
        organization_id: f.organizationId,
        ticket_id: f.tickets.k1,
        actor_profile_id: manager.profileId,
        activity_type: 'assigned',
        description: 'Assigned to the HVAC contractor.',
        metadata: {},
      },
      {
        id: f.activities.a2,
        organization_id: f.organizationId,
        ticket_id: f.tickets.k2,
        actor_profile_id: tenant.profileId,
        activity_type: 'created',
        description: 'Reported by the tenant.',
        metadata: {},
      },
      {
        id: f.activities.a3,
        organization_id: f.organizationId,
        ticket_id: f.tickets.k3,
        actor_profile_id: manager.profileId,
        activity_type: 'in_progress',
        description: 'Contractor on site.',
        metadata: {},
      },
      {
        id: f.activities.a4,
        organization_id: f.organizationId,
        ticket_id: f.tickets.k4,
        actor_profile_id: tenant2.profileId,
        activity_type: 'created',
        description: 'Reported by the tenant.',
        metadata: {},
      },
    ],
    { ignoreDuplicates: true },
  );

  const objectPath = (entity: string, id: string) => `${f.organizationId}/${entity}/${id}.pdf`;

  const documentRows: Row[] = [
    {
      id: f.documents.d1,
      organization_id: f.organizationId,
      property_id: f.properties.p1,
      tenancy_id: f.tenancies.tc1,
      document_type: SHARED_SHAPE.documentType,
      storage_path: objectPath('tenancies', f.documents.d1),
      extracted_data: { contract_number: SHARED_SHAPE.contractNumbers[0] },
      verification_status: 'pending',
      uploaded_by: manager.profileId,
    },
    {
      id: f.documents.d2,
      organization_id: f.organizationId,
      property_id: f.properties.p2,
      tenancy_id: f.tenancies.tc3,
      document_type: SHARED_SHAPE.documentType,
      storage_path: objectPath('tenancies', f.documents.d2),
      extracted_data: { contract_number: SHARED_SHAPE.contractNumbers[2] },
      verification_status: 'verified',
      uploaded_by: manager.profileId,
    },
    {
      id: f.documents.evidence,
      organization_id: f.organizationId,
      // Ticket-scoped only, matching what documents_insert_provider_assigned permits a
      // provider to write: evidence attached to a property or a tenancy would be
      // readable by that property's owner and that tenancy's tenant.
      property_id: null,
      tenancy_id: null,
      document_type: 'completion_evidence',
      storage_path: objectPath('tickets', f.documents.evidence),
      verification_status: 'pending',
      uploaded_by: provider.profileId,
      // Amendment A7. Omitted when the column does not exist, so the suite reports a
      // missing capability rather than failing to seed.
      ...(capabilities.documentsHasTicketId ? { ticket_id: f.tickets.k1 } : {}),
    },
  ];
  await setup.upsert('documents', documentRows);

  await setup.upsert('ai_conversations', [
    {
      id: f.conversations.c1,
      organization_id: f.organizationId,
      user_profile_id: tenant.profileId,
      channel: 'web',
      status: 'active',
    },
    {
      id: f.conversations.c2,
      organization_id: f.organizationId,
      user_profile_id: tenant2.profileId,
      channel: 'web',
      status: 'active',
    },
  ]);

  await setup.upsert('ai_messages', [
    {
      id: f.messages.m1,
      organization_id: f.organizationId,
      conversation_id: f.conversations.c1,
      sender_type: 'user',
      content: SHARED_SHAPE.aiMessage,
      metadata: {},
    },
    {
      id: f.messages.m2,
      organization_id: f.organizationId,
      conversation_id: f.conversations.c2,
      sender_type: 'user',
      content: SHARED_SHAPE.aiMessage,
      metadata: {},
    },
  ]);

  const notifications: Record<string, string> = {};
  await setup.upsert(
    'notifications',
    principals.map((p) => {
      const id = factory.fixtureId(`${org}:notification:${p.key}`);
      notifications[p.key] = id;
      return {
        id,
        organization_id: f.organizationId,
        recipient_profile_id: p.profileId,
        channel: 'in_app',
        event_type: 'ticket.updated',
        payload: { ticket_id: f.tickets.k1 },
        status: 'queued',
        retry_count: 0,
      };
    }),
  );

  await setup.upsert('audit_logs', [
    {
      id: f.auditLogs.al1,
      organization_id: f.organizationId,
      actor_profile_id: admin.profileId,
      action: SHARED_SHAPE.auditAction,
      entity_type: 'tenancy',
      entity_id: f.tenancies.tc1,
      metadata: {},
    },
  ]);

  /* ----------------------------------------------- migration 0004, agentic -- */

  // One chunk per document. `embedding` is left null on purpose: the column is
  // nullable because the worker writes content and embedding in separate passes, and
  // no assertion in this suite ranks anything — they all ask who may READ a chunk.
  await setup.upsert(
    'document_chunks',
    [
      { id: f.documentChunks.d1, document: f.documents.d1 },
      { id: f.documentChunks.d2, document: f.documents.d2 },
      { id: f.documentChunks.evidence, document: f.documents.evidence },
    ].map(({ id, document }) => ({
      id,
      organization_id: f.organizationId,
      document_id: document,
      chunk_index: 0,
      content: SHARED_SHAPE.chunkContent,
      token_count: 24,
    })),
  );

  await setup.upsert('inbound_messages', [
    {
      id: f.inboundMessages.im1,
      organization_id: f.organizationId,
      provider: 'whatsapp',
      // Globally unique by (provider, external_message_id), so the organization key has
      // to be in it. The SENDER is identical in both organizations, which is the point:
      // the same phone number reaching two organizations is exactly the case where a
      // resolver that guesses would cross the boundary.
      external_message_id: `wamid.fixture.${org}.1`,
      from_identifier: SHARED_SHAPE.tenantPhones[0],
      body: SHARED_SHAPE.inboundMessageBody,
      status: 'linked',
      ticket_id: f.tickets.k1,
    },
    {
      // The row that belongs to nobody. Written on both passes with identical values,
      // so the second upsert is a no-op. No organization_id and no ticket_id: the
      // inbound_messages_ticket_requires_org check refuses to link a ticket before the
      // organization is known, and the staff policy's `organization_id is not null`
      // keeps this row out of every organization's inbox.
      id: f.inboundMessages.unattributed,
      organization_id: null,
      provider: 'whatsapp',
      external_message_id: 'wamid.fixture.shared.unattributed',
      from_identifier: SHARED_SHAPE.tenantPhones[1],
      body: SHARED_SHAPE.inboundMessageBody,
      status: 'unmatched',
      ticket_id: null,
    },
  ]);

  await setup.upsert('agent_runs', [
    {
      id: f.agentRuns.ar1,
      organization_id: f.organizationId,
      actor_profile_id: admin.profileId,
      input: SHARED_SHAPE.agentInstruction,
      status: 'running',
    },
  ]);

  // Pending, with no decision attached — the only state a client may create, and the
  // state the approval RPC is the only exit from.
  await setup.upsert('agent_proposals', [
    {
      id: f.agentProposals.ap1,
      organization_id: f.organizationId,
      run_id: f.agentRuns.ar1,
      tool_name: SHARED_SHAPE.proposalTool,
      arguments: { property_unit_id: f.units.p1u1, category: 'hvac', priority: 'normal' },
      rationale: 'The tenant reported that the air conditioning is not cooling.',
      status: 'pending',
      decided_by: null,
      decided_at: null,
    },
  ]);

  /* --------------------------------------- migration 0006, outbound ledger -- */

  // Seeded through the privileged client, which is the ONLY way these rows can exist:
  // there is no client INSERT policy and no INSERT privilege, so a fixture written
  // with an authenticated principal could not create them at all. That is the control
  // the suite asserts, not an inconvenience to work around.
  //
  // `sent_at` is a fixed instant rather than `now()` so re-seeding an un-reset database
  // is an upsert of identical values rather than a perpetual diff.
  await setup.upsert('outbound_messages', [
    {
      id: f.outboundMessages.om1,
      organization_id: f.organizationId,
      inbound_message_id: f.inboundMessages.im1,
      tenant_id: f.tenants.t1,
      to_identifier: SHARED_SHAPE.tenantPhones[0],
      body: SHARED_SHAPE.outboundAcknowledgementBody,
      kind: 'acknowledgement',
      // A fixed string, sent on receipt. No model output and no human in it, which is
      // why nobody's profile id is attached.
      drafted_by: 'system',
      sent_by_profile_id: null,
      provider: 'whatsapp',
      provider_message_id: `wamid.out.fixture.${org}.1`,
      status: 'sent',
      sent_at: new Date(Date.UTC(2026, 0, 2, 9, 0, 0)).toISOString(),
    },
    {
      id: f.outboundMessages.om2,
      organization_id: f.organizationId,
      inbound_message_id: f.inboundMessages.im1,
      tenant_id: f.tenants.t1,
      to_identifier: SHARED_SHAPE.tenantPhones[0],
      body: SHARED_SHAPE.outboundStaffReplyBody,
      // `staff_reply`, not `acknowledgement`: the partial unique index permits at most
      // one acknowledgement per inbound message, and a second one here would make the
      // fixture un-seedable for a reason that has nothing to do with authorization.
      kind: 'staff_reply',
      // The pair that records CLAUDE.md rule 7 having happened: the model drafted the
      // text, and a named human released it. Collapsing `drafted_by` to 'human' on send
      // would erase the only durable evidence that the confirmation step existed.
      drafted_by: 'ai',
      sent_by_profile_id: manager.profileId,
      provider: 'whatsapp',
      provider_message_id: `wamid.out.fixture.${org}.2`,
      status: 'sent',
      sent_at: new Date(Date.UTC(2026, 0, 2, 9, 5, 0)).toISOString(),
    },
  ]);

  // Token hash only — never a plaintext token, even in a fixture.
  await setup.upsert('organization_invitations', [
    {
      id: f.invitations.inv1,
      organization_id: f.organizationId,
      email: `invitee@${descriptor.slug}.test`,
      role: 'property_manager',
      token_hash: `fixture-hash-${f.invitations.inv1}`,
      status: 'pending',
      invited_by_profile_id: admin.profileId,
      expires_at: new Date(Date.UTC(2030, 0, 1)).toISOString(),
    },
  ]);

  return {
    key: org,
    organizationId: f.organizationId,
    slug: descriptor.slug,
    name: descriptor.name,
    profiles: Object.fromEntries(principals.map((p) => [p.key, p.profileId])),
    members: Object.fromEntries(principals.map((p) => [p.key, p.memberId])),
    properties: f.properties,
    units: f.units,
    tenants: f.tenants,
    tenancies: f.tenancies,
    providers: f.providers,
    tickets: f.tickets,
    activities: f.activities,
    documents: f.documents,
    conversations: f.conversations,
    messages: f.messages,
    notifications,
    auditLogs: f.auditLogs,
    invitations: f.invitations,
    documentChunks: f.documentChunks,
    inboundMessages: f.inboundMessages,
    agentRuns: f.agentRuns,
    agentProposals: f.agentProposals,
    outboundMessages: f.outboundMessages,
    objects: {
      d1: objectPath('tenancies', f.documents.d1),
      d2: objectPath('tenancies', f.documents.d2),
    },
  };
}

/** The linear chain from §4. `cancelled` is reachable from any non-terminal state. */
const TICKET_CHAIN = ['open', 'assigned', 'in_progress', 'awaiting_approval', 'completed'];

/**
 * Walks a ticket FORWARD to `target` along legal edges only, from wherever it currently
 * is. Idempotent: a ticket already at the target is left alone.
 *
 * Seeding has to work this way rather than by upserting a status. On a second run the
 * row already sits at `in_progress`, and writing `open` over it is an illegal
 * transition the trigger correctly rejects — so a status upsert makes the fixture
 * un-reseedable against a live database.
 *
 * Fixture setup, through the privileged client. The state machine itself is asserted in
 * tests/rls/state-machine.test.ts on throwaway tickets; arriving at a seeded starting
 * state must not depend on the policy under test.
 */
async function ensureTicketStatus(
  setup: SetupClient,
  ticketId: string,
  target: string,
  providerId: string | null,
): Promise<void> {
  const { data } = await setup.select('maintenance_tickets', {
    columns: 'status',
    eq: { id: ticketId },
  });
  const current = String((data ?? [])[0]?.status ?? 'open');
  if (current === target) return;

  const from = TICKET_CHAIN.indexOf(current);
  const to = TICKET_CHAIN.indexOf(target);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(
      `Cannot seed ticket ${ticketId} from "${current}" to "${target}": there is no ` +
        'forward path, and the suite will not walk a ticket backwards because no such ' +
        'edge exists. Reset the database with `node scripts/reset-db.mjs`.',
    );
  }

  for (const next of TICKET_CHAIN.slice(from + 1, to + 1)) {
    const patch: Row = { status: next };
    if (next === 'assigned' && providerId) patch.assigned_provider_id = providerId;
    const { error } = await setup.update('maintenance_tickets', patch, { id: ticketId });
    if (error) {
      throw new Error(
        `Fixture seeding failed walking ticket ${ticketId} to ${next}: ${error.message}. ` +
          'The seeded path follows only legal edges, so this means the transition trigger ' +
          'disagrees with the §4 state machine.',
      );
    }
  }
}

/** Every seeded object path, in both organizations. The storage suite asserts on these. */
export function fixtureObjectPaths(fixture: Fixture): string[] {
  return ORG_KEYS.flatMap((key) => Object.values(fixture[key].objects));
}

/** Builds the whole world. Idempotent. */
export async function seedFixture(
  setup: SetupClient,
  factory: JwtFactoryModule,
  userIdByPrincipal: Map<string, string>,
): Promise<Fixture> {
  const capabilities = { documentsHasTicketId: await detectDocumentsTicketId(setup) };

  const seeded = {} as Record<OrgKey, OrgFixture>;
  for (const org of ORG_KEYS) {
    seeded[org] = await seedOrganization(setup, factory, org, userIdByPrincipal, capabilities);
  }

  return { A: seeded.A, B: seeded.B, capabilities };
}
