/**
 * The named role-scoping cases. Lane w0-l6, task 6.
 *
 * Where cross-role.test.ts is generated from the matrix, these are the specific claims
 * the acceptance criteria make in words, asserted in the words' own terms. Each one is
 * phrased as an INVARIANT over everything the caller can see rather than as a row
 * count, because the suite seeds extra rows as it runs and a count-based assertion
 * would then be order-dependent — green on its own, red in CI, for no security reason.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SHARED_SHAPE,
  clientFor,
  clientForKey,
  expectInsertAllowed,
  expectInsertDenied,
  expectSelectAllowed,
  expectSelectDenied,
  expectUpdateDenied,
  getWorld,
  org as orgFixture,
  recordPass,
  type World,
} from '../_harness';

let world: World;

beforeAll(async () => {
  world = await getWorld();
});

describe('a tenant cannot reach another tenant', () => {
  it('cannot read the other tenant record in its own organization', async () => {
    // AC: "Avoid exposing another tenant's personal data." Both tenants carry the same
    // kind of data and live in the same organization; only the row id separates them.
    const f = orgFixture(world, 'A');
    await expectSelectDenied(clientFor(world, 'A', 'tenant'), 'tenants', f.tenants.t2, {
      dimension: 'in_org',
      table: 'tenants',
      role: 'tenant',
      operation: 'select',
      policies: ['tenants_select_self'],
    });
  });

  it('cannot read the other tenant`s name, email or phone by any filter', async () => {
    const client = clientFor(world, 'A', 'tenant');
    const { data, error } = await client.from('tenants').select('id,full_name,email,phone');
    expect(error).toBeNull();

    const f = orgFixture(world, 'A');
    const rows = (data ?? []) as { id: string; email: string | null; phone: string | null }[];

    expect(
      rows.map((r) => r.id),
      'A tenant listing `tenants` must see exactly their own record.',
    ).toEqual([f.tenants.t1]);

    const leaked = rows.filter(
      (r) => r.email === SHARED_SHAPE.tenantEmails[1] || r.phone === SHARED_SHAPE.tenantPhones[1],
    );
    expect(leaked, 'another tenant`s contact details were returned').toEqual([]);
    recordPass({ dimension: 'integrity', label: 'tenant PII not visible to another tenant' });
  });

  it('cannot read the other tenant`s profile row', async () => {
    const f = orgFixture(world, 'A');
    await expectSelectDenied(
      clientFor(world, 'A', 'tenant'),
      'profiles',
      f.profiles.a_tenant2 ?? '',
      {
        dimension: 'in_org',
        table: 'profiles',
        role: 'tenant',
        operation: 'select',
        policies: ['profiles_select_self'],
      },
    );
  });

  it('cannot read the other tenant`s tenancy, tickets or documents', async () => {
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'tenant');

    for (const [table, id] of [
      ['tenancies', f.tenancies.tc2],
      ['maintenance_tickets', f.tickets.k3],
      ['documents', f.documents.d2],
      ['ai_conversations', f.conversations.c2],
      ['ai_messages', f.messages.m2],
    ] as const) {
      const { data } = await client.from(table).select('id').eq('id', id);
      expect(data ?? [], `${table}: another tenant's row ${id} was visible`).toEqual([]);
    }
    recordPass({
      dimension: 'integrity',
      label: 'tenant sees nothing belonging to another tenant',
    });
  });

  it('cannot update another tenant`s ticket', async () => {
    const f = orgFixture(world, 'A');
    await expectUpdateDenied(
      clientFor(world, 'A', 'tenant'),
      'maintenance_tickets',
      f.tickets.k3,
      { status: 'cancelled' },
      {
        dimension: 'in_org',
        table: 'maintenance_tickets',
        role: 'tenant',
        operation: 'update',
        policies: ['maintenance_tickets_update_tenant_cancel'],
      },
      {
        verifyWith: clientFor(world, 'A', 'organization_admin'),
        verifyColumn: 'status',
      },
    );
  });

  it('the second tenant is symmetrically blind to the first', async () => {
    // Asserted from a real second session, not inferred from the first one's result.
    const f = orgFixture(world, 'A');
    const client = clientForKey(world, 'a_tenant2');
    const { data } = await client.from('tenants').select('id');
    expect((data ?? []).map((r) => (r as { id: string }).id)).toEqual([f.tenants.t2]);
    recordPass({ dimension: 'integrity', label: 'tenant isolation is symmetric' });
  });
});

describe('a service provider sees only assigned work', () => {
  it('sees exactly the one assigned ticket and nothing unassigned', async () => {
    // Acceptance criterion 7, and finding 4: the baseline schema gave providers
    // organization-wide ticket read.
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'service_provider');

    const { data, error } = await client
      .from('maintenance_tickets')
      .select('id,assigned_provider_id');
    expect(error).toBeNull();

    const rows = (data ?? []) as { id: string; assigned_provider_id: string | null }[];

    expect(
      rows.map((r) => r.id),
      'the provider must see their one assigned ticket',
    ).toContain(f.tickets.k1);

    // Invariant form: every visible ticket is assigned to this provider. Holds no
    // matter how many extra tickets other files in the suite have created.
    const foreign = rows.filter((r) => r.assigned_provider_id !== f.providers.sp1);
    expect(
      foreign.map((r) => r.id),
      'a provider saw a ticket that is not assigned to them',
    ).toEqual([]);

    // And the three specific negatives, by id.
    for (const id of [f.tickets.k2, f.tickets.k3, f.tickets.k4]) {
      expect(
        rows.map((r) => r.id),
        `ticket ${id} must be invisible to this provider`,
      ).not.toContain(id);
    }
    recordPass({ dimension: 'integrity', label: 'provider sees exactly one assigned ticket' });
  });

  it('sees the tenant`s name but not their email or phone', async () => {
    // Matrix: "R name only, via assignment." A provider needs to know who to call
    // about, not how to contact them directly.
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'service_provider');

    const { data: nameOnly, error: nameError } = await client
      .from('tenants')
      .select('id,full_name')
      .eq('id', f.tenants.t1);
    expect(
      nameError,
      `provider could not read the assigned tenant's name: ${nameError?.message}`,
    ).toBeNull();
    expect((nameOnly ?? []).length).toBe(1);

    const { data: contact, error: contactError } = await client
      .from('tenants')
      .select('id,email,phone')
      .eq('id', f.tenants.t1);

    const exposed = ((contact ?? []) as { email: string | null; phone: string | null }[]).filter(
      (r) => r.email === SHARED_SHAPE.tenantEmails[0] || r.phone === SHARED_SHAPE.tenantPhones[0],
    );
    expect(
      contactError !== null || exposed.length === 0,
      'the matrix grants a provider the tenant NAME only, but email/phone came back: ' +
        'either revoke those columns from the provider or amend §4.',
    ).toBe(true);
    recordPass({ dimension: 'integrity', label: 'provider reads tenant name only' });
  });

  it('cannot update a ticket that is not assigned to it', async () => {
    const f = orgFixture(world, 'A');
    await expectUpdateDenied(
      clientFor(world, 'A', 'service_provider'),
      'maintenance_tickets',
      f.tickets.k2,
      { status: 'in_progress' },
      {
        dimension: 'in_org',
        table: 'maintenance_tickets',
        role: 'service_provider',
        operation: 'update',
        policies: ['maintenance_tickets_update_assigned_provider'],
      },
      { verifyWith: clientFor(world, 'A', 'organization_admin'), verifyColumn: 'status' },
    );
  });

  it('sees only the property and unit its assigned ticket is in', async () => {
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'service_provider');

    const { data: properties } = await client.from('properties').select('id');
    expect((properties ?? []).map((r) => (r as { id: string }).id)).toEqual([f.properties.p1]);

    const { data: units } = await client.from('property_units').select('id');
    expect((units ?? []).map((r) => (r as { id: string }).id)).toEqual([f.units.p1u1]);
    recordPass({ dimension: 'integrity', label: 'provider property/unit scope' });
  });
});

describe('a property owner sees only what they own', () => {
  it('every property it can see is one it owns', async () => {
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'property_owner');

    const { data, error } = await client.from('properties').select('id,owner_member_id');
    expect(error).toBeNull();

    const rows = (data ?? []) as { id: string; owner_member_id: string | null }[];
    expect(rows.map((r) => r.id)).toContain(f.properties.p1);
    expect(
      rows.filter((r) => r.owner_member_id !== f.members.a_owner).map((r) => r.id),
      'an owner saw a property whose owner_member_id is not theirs',
    ).toEqual([]);
    expect(
      rows.map((r) => r.id),
      'the unowned building must be invisible',
    ).not.toContain(f.properties.p2);
    recordPass({ dimension: 'integrity', label: 'owner sees only owned properties' });
  });

  it('sees tenancies, tickets and documents only for the owned building', async () => {
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'property_owner');

    const visible = async (table: string) => {
      const { data } = await client.from(table).select('id');
      return (data ?? []).map((r) => (r as { id: string }).id);
    };

    expect(await visible('tenancies')).not.toContain(f.tenancies.tc3);
    expect(await visible('maintenance_tickets')).not.toContain(f.tickets.k4);
    expect(await visible('documents')).not.toContain(f.documents.d2);
    expect(await visible('property_units')).not.toContain(f.units.p2u1);
    recordPass({ dimension: 'integrity', label: 'owner scope follows the owned property' });
  });

  it('cannot read tenant records at all', async () => {
    // The matrix gives property_owner nothing on `tenants`: an owner is entitled to
    // know a unit is occupied, not to the occupant's personal data.
    const { data } = await clientFor(world, 'A', 'property_owner').from('tenants').select('id');
    expect(data ?? []).toEqual([]);
    recordPass({ dimension: 'integrity', label: 'owner reads no tenant records' });
  });
});

describe('the audit trail is admin-only', () => {
  it('the organization admin reads its own organization`s audit rows', async () => {
    const f = orgFixture(world, 'A');
    await expectSelectAllowed(
      clientFor(world, 'A', 'organization_admin'),
      'audit_logs',
      f.auditLogs.al1,
      {
        dimension: 'in_org',
        table: 'audit_logs',
        role: 'organization_admin',
        operation: 'select',
        policies: ['audit_logs_select_admin'],
      },
    );
  });

  it('no other role sees a single audit row', async () => {
    // Finding 7: the baseline policy exposed the audit trail to every member, which
    // includes every tenant.
    for (const role of [
      'property_manager',
      'property_owner',
      'tenant',
      'service_provider',
    ] as const) {
      const { data, error } = await clientFor(world, 'A', role).from('audit_logs').select('id');
      if (error) {
        expect(/permission denied|row-level security/i.test(error.message)).toBe(true);
      } else {
        expect(data ?? [], `${role} can read the audit trail`).toEqual([]);
      }
    }
    recordPass({ dimension: 'integrity', label: 'audit trail is organization_admin only' });
  });
});

describe('profiles expose nothing across the boundary', () => {
  it('an admin of one organization cannot read a member of the other', async () => {
    const b = orgFixture(world, 'B');
    for (const key of ['b_admin', 'b_manager', 'b_tenant', 'b_provider'] as const) {
      await expectSelectDenied(
        clientFor(world, 'A', 'organization_admin'),
        'profiles',
        b.profiles[key] ?? '',
        {
          dimension: 'cross_org',
          table: 'profiles',
          role: 'organization_admin',
          operation: 'select',
          policies: ['profiles_select_same_org_staff'],
        },
      );
    }
  });

  it('listing profiles returns only members of the caller`s own organization', async () => {
    const a = orgFixture(world, 'A');
    const b = orgFixture(world, 'B');
    const ownIds = new Set(Object.values(a.profiles));
    const foreignIds = new Set(Object.values(b.profiles));

    const { data, error } = await clientFor(world, 'A', 'organization_admin')
      .from('profiles')
      .select('id,email');
    expect(error).toBeNull();

    const rows = (data ?? []) as { id: string; email: string | null }[];
    expect(rows.length, 'an admin should see their own organization`s members').toBeGreaterThan(0);
    expect(
      rows.filter((r) => foreignIds.has(r.id)).map((r) => r.email),
      'profiles from the other organization were listed — the platform-wide PII leak ' +
        'that finding 2 exists to close',
    ).toEqual([]);
    expect(rows.every((r) => ownIds.has(r.id))).toBe(true);
    recordPass({ dimension: 'integrity', label: 'profiles listing is organization-scoped' });
  });

  it('a tenant sees exactly one profile: their own', async () => {
    const a = orgFixture(world, 'A');
    const { data } = await clientFor(world, 'A', 'tenant').from('profiles').select('id');
    expect((data ?? []).map((r) => (r as { id: string }).id)).toEqual([a.profiles.a_tenant]);
    recordPass({ dimension: 'integrity', label: 'tenant sees only their own profile' });
  });
});

describe('provider completion evidence (amendment A7)', () => {
  // These two cells are listed in cross-role.test.ts as COVERED_ELSEWHERE, because a
  // bare "select returned nothing" failure here would be read as an RLS finding when
  // the real cause is a column the migrations never added.
  const a7 = (operation: 'select' | 'insert') => ({
    dimension: 'in_org' as const,
    table: 'documents',
    role: 'service_provider',
    operation,
    policies: [`documents_${operation}_provider_assigned`],
  });

  it('documents.ticket_id exists, so evidence can be scoped to an assigned ticket', () => {
    expect(
      world.fixture.capabilities.documentsHasTicketId,
      'documents.ticket_id is absent. Amendment A7 (§5.8) grants a service_provider ' +
        'INSERT and SELECT on documents scoped to an assigned ticket, and the §4 matrix ' +
        'now reads "CR assigned-ticket evidence only" — but neither 0002 nor 0003 adds ' +
        'the column or the policies. The document is the contract, so this assertion ' +
        'stays as written until the migration implements A7.',
    ).toBe(true);
  });

  it('a provider reads the evidence document attached to its assigned ticket', async () => {
    const f = orgFixture(world, 'A');
    await expectSelectAllowed(
      clientFor(world, 'A', 'service_provider'),
      'documents',
      f.documents.evidence,
      a7('select'),
    );
  });

  it('a provider cannot read a tenancy contract', async () => {
    const f = orgFixture(world, 'A');
    await expectSelectDenied(
      clientFor(world, 'A', 'service_provider'),
      'documents',
      f.documents.d1,
      a7('select'),
    );
  });

  it('a provider can attach evidence to its own ticket but not to another`s', async () => {
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'service_provider');
    const profileId = f.profiles.a_provider ?? '';
    const base = {
      organization_id: f.organizationId,
      property_id: f.properties.p1,
      document_type: 'completion_evidence',
      verification_status: 'pending',
      uploaded_by: profileId,
    };

    await expectInsertAllowed(
      client,
      'documents',
      {
        ...base,
        storage_path: `${f.organizationId}/tickets/${randomUUID()}.pdf`,
        ticket_id: f.tickets.k1,
      },
      a7('insert'),
    );

    await expectInsertDenied(
      client,
      'documents',
      {
        ...base,
        storage_path: `${f.organizationId}/tickets/${randomUUID()}.pdf`,
        ticket_id: f.tickets.k3,
      },
      a7('insert'),
    );
  });
});
