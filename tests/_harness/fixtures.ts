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
 *
 * So: the owner sees P1 and everything hanging off it and nothing from P2; the tenant
 * sees only unit 1204 of P1 and their own two tickets; the provider sees exactly K1.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  JwtFactoryModule,
  OrgKey,
  PrincipalDescriptor,
  StackCredentials,
} from './jwt-factory';

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
  };
}

async function upsert(
  service: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  const { error } = await service.from(table).upsert(rows, { onConflict: 'id' });
  if (error) {
    throw new Error(
      `Fixture seeding failed on ${table}: ${error.message}` +
        (error.details ? ` (${error.details})` : '') +
        `\nThis is a seeding failure, not an RLS result. Check that migrations applied:` +
        `\n  node scripts/reset-db.mjs`,
    );
  }
}

/** Does `documents.ticket_id` exist? Amendment A7 depends on it; 0002/0003 may not have it. */
async function detectDocumentsTicketId(service: SupabaseClient): Promise<boolean> {
  const { error } = await service.from('documents').select('ticket_id').limit(1);
  return !error;
}

const isoDate = (offsetDays: number) => {
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function seedOrganization(
  service: SupabaseClient,
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

  await upsert(service, 'organizations', [
    {
      id: f.organizationId,
      name: descriptor.name,
      slug: descriptor.slug,
      status: 'active',
    },
  ]);

  // 0003 creates a profile from an auth.users trigger. Upserting here keeps the suite
  // runnable whether or not that trigger has landed, and pins the ids either way.
  await upsert(
    service,
    'profiles',
    principals.map((p: PrincipalDescriptor) => ({
      id: p.profileId,
      auth_user_id: userIdByPrincipal.get(p.key),
      full_name: p.fullName,
      email: p.email,
      phone: '+971500000000',
    })),
  );

  await upsert(
    service,
    'organization_members',
    principals.map((p) => ({
      id: p.memberId,
      organization_id: f.organizationId,
      profile_id: p.profileId,
      role: p.role,
      status: 'active',
    })),
  );

  await upsert(service, 'properties', [
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

  await upsert(service, 'property_units', [
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

  await upsert(service, 'tenants', [
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

  await upsert(service, 'tenancies', [
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

  await upsert(service, 'service_providers', [
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

  // Tickets are inserted as 'open' (§4: a ticket must be inserted as open) and then
  // walked to their target status along legal edges, so the transition trigger is
  // satisfied whether it fires on INSERT, on UPDATE, or on both.
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
    status: 'open',
    source: 'web',
  });

  await upsert(service, 'maintenance_tickets', [
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

  await advanceTicket(service, f.tickets.k1, ['assigned'], f.providers.sp1);
  await advanceTicket(service, f.tickets.k3, ['assigned', 'in_progress'], f.providers.sp2);

  await upsert(service, 'maintenance_activities', [
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
  ]);

  const objectPath = (entity: string, id: string) => `${f.organizationId}/${entity}/${id}.pdf`;

  const documentRows: Record<string, unknown>[] = [
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
      property_id: f.properties.p1,
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
  await upsert(service, 'documents', documentRows);

  await upsert(service, 'ai_conversations', [
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

  await upsert(service, 'ai_messages', [
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
  await upsert(
    service,
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

  await upsert(service, 'audit_logs', [
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

  // Token hash only — never a plaintext token, even in a fixture.
  await upsert(service, 'organization_invitations', [
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
    objects: {
      d1: objectPath('tenancies', f.documents.d1),
      d2: objectPath('tenancies', f.documents.d2),
    },
  };
}

/** Walks a ticket along legal edges with the service-role client. Fixture setup only. */
async function advanceTicket(
  service: SupabaseClient,
  ticketId: string,
  path: readonly string[],
  providerId: string | null,
): Promise<void> {
  for (const status of path) {
    const patch: Record<string, unknown> = { status };
    if (status === 'assigned' && providerId) patch.assigned_provider_id = providerId;
    const { error } = await service.from('maintenance_tickets').update(patch).eq('id', ticketId);
    if (error) {
      throw new Error(
        `Fixture seeding failed walking ticket ${ticketId} to ${status}: ${error.message}. ` +
          'The seeded path follows only legal edges, so this means the transition trigger ' +
          'disagrees with the §4 state machine.',
      );
    }
  }
}

/**
 * Seeds a small PDF-shaped object per organization into the private bucket so the
 * storage suite has something real to request a signed URL for.
 */
export async function seedStorageObjects(
  service: SupabaseClient,
  bucket: string,
  fixture: Fixture,
): Promise<{ seeded: boolean; reason?: string }> {
  const body = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xc2, 0xa5, 0xc2, 0xb1, 0xc3, 0xab,
    0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a,
  ]);
  for (const org of ORG_KEYS) {
    for (const path of Object.values(fixture[org].objects)) {
      const { error } = await service.storage.from(bucket).upload(path, body, {
        contentType: 'application/pdf',
        upsert: true,
      });
      if (error) return { seeded: false, reason: `${path}: ${error.message}` };
    }
  }
  return { seeded: true };
}

/** Builds the whole world. Idempotent. */
export async function seedFixture(
  factory: JwtFactoryModule,
  creds: StackCredentials,
): Promise<Fixture> {
  const service = factory.createServiceRoleClient(creds);
  const users = await factory.ensureAuthUsers(creds);
  const userIdByPrincipal = new Map([...users.values()].map((u) => [u.key, u.userId]));

  const capabilities = { documentsHasTicketId: await detectDocumentsTicketId(service) };

  const seeded = {} as Record<OrgKey, OrgFixture>;
  for (const org of ORG_KEYS) {
    seeded[org] = await seedOrganization(service, factory, org, userIdByPrincipal, capabilities);
  }

  return { A: seeded.A, B: seeded.B, capabilities };
}
