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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PsqlSession,
  SHARED_SHAPE,
  clientFor,
  clientForKey,
  expectDeleteDenied,
  expectInsertAllowed,
  expectInsertDenied,
  expectNothingVisible,
  expectSelectAllowed,
  expectSelectDenied,
  expectUpdateDenied,
  getWorld,
  isAuthorizationRefusal,
  keyForRole,
  lit,
  org as orgFixture,
  quote,
  recordPass,
  resolvePostgresConnection,
  type MemberRole,
  type OrgKey,
  type World,
} from '../_harness';

let world: World;

beforeAll(async () => {
  world = await getWorld();
});

/* ------------------------------------------- tenants.email / phone (0004) -- */

/**
 * Migration 0004 took `email` and `phone` away from every client session.
 *
 * The defect it closed was measured, not theorised: a `service_provider` holding an
 * assigned ticket could read the tenant's email and phone straight through PostgREST
 * with `select full_name,email,phone from tenants`. §4 of the implementation plan gives
 * that role "R name only, via assignment", and the application layer did project
 * correctly — but the anon key is public by design, the provider holds a real JWT, and
 * PostgREST is reachable without going through the application at all.
 *
 * No policy could express the boundary, for a structural reason worth stating plainly:
 * row level security filters ROWS, not COLUMNS, and all five application roles share
 * the single Postgres role `authenticated`. A policy can branch on the caller; a GRANT
 * cannot, because there is only one role to grant to. So the only instrument left is
 * the grant itself — and a grant discriminates by nothing. 0004 therefore revokes
 * table-level SELECT on `tenants` and grants back five columns
 * (`id, organization_id, profile_id, full_name, created_at`), which means `email` and
 * `phone` are now selectable by NO role, organization staff included.
 *
 * Staff and the tenant themselves read them through `tenant_contact()`, which is
 * `security definer`, checks `is_org_staff()` / `current_tenant_id()`, and raises 42501
 * otherwise.
 *
 * That function is an RPC, and `Principal` has no RPC verb: PostgREST reaches it with
 * POST /rpc/..., psql with `select ... from public.tenant_contact(...)`, and there is no
 * single statement the driver abstraction could issue for both. Rather than widen the
 * harness interface from a test file, the call is made here on the pg driver using the
 * same impersonation the driver itself performs — `set local role authenticated` plus
 * `request.jwt.claims`, rolled back — and reported as unsupported elsewhere, so a
 * supabase-driver run skips the case visibly instead of passing it in silence.
 */
interface ContactRow {
  tenant_id: string;
  email: string | null;
  phone: string | null;
}

interface ContactOutcome {
  rows: ContactRow[] | null;
  error: { code: string; message: string } | null;
  /** The transport cannot express an RPC. Never `true` on the pg driver. */
  unsupported?: boolean;
}

let rpcSession: PsqlSession | undefined;
let authUserIds: Map<string, string> | undefined;

afterAll(async () => {
  if (rpcSession) await rpcSession.close();
});

/**
 * Calls `public.tenant_contact(p_organization_id, p_tenant_id)` as a named principal.
 *
 * The exception is caught in PL/pgSQL and its SQLSTATE returned, so a refusal is
 * distinguishable from a function that is missing, mis-signed or returning nothing —
 * "the call failed" and "the call was refused" must not look the same in a suite whose
 * whole point is proving refusals.
 */
async function tenantContactAs(
  principalKey: string,
  organizationId: string,
  tenantId: string | null,
): Promise<ContactOutcome> {
  if (world.driver.name !== 'pg') return { rows: null, error: null, unsupported: true };

  rpcSession ??= new PsqlSession(resolvePostgresConnection());
  authUserIds ??= await world.driver.ensureAuthUsers();

  const authUserId = authUserIds.get(principalKey);
  if (!authUserId) throw new Error(`No auth identity for principal ${principalKey}`);

  const claims = JSON.stringify({ sub: authUserId, role: 'authenticated', aud: 'authenticated' });
  const call =
    `public.tenant_contact(${lit(organizationId)}::uuid, ` +
    `${tenantId === null ? 'null' : lit(tenantId)}::uuid)`;

  const batch = [
    'begin',
    "set local statement_timeout = '30s'",
    "set local lock_timeout = '10s'",
    // Everything after this line runs as a client would. Nothing before it asserts.
    'set local role authenticated',
    `select set_config('request.jwt.claims', ${quote(claims)}, true)`,
    [
      'do $ps_rpc$',
      'declare v jsonb;',
      'begin',
      `  select coalesce(jsonb_agg(__t), '[]'::jsonb) into v`,
      `    from (select tenant_id, email, phone from ${call}) __t;`,
      `  perform set_config('ps.rpc', jsonb_build_object('rows', v)::text, true);`,
      'exception when others then',
      `  perform set_config('ps.rpc', jsonb_build_object('error', jsonb_build_object(`,
      // Flattened to one line: psql's wire format here is one result per line, so a
      // newline inside the message would truncate the JSON into something unparseable
      // and a real refusal would surface as a harness fault. `chr(10)`/`chr(13)` rather
      // than a regex because the SQL travels through two levels of string escaping on
      // its way here and a lost backslash would silently mangle the message instead.
      `    'code', sqlstate,`,
      `    'message', replace(replace(sqlerrm, chr(10), ' '), chr(13), ' ')))::text, true);`,
      'end',
      '$ps_rpc$',
    ].join('\n'),
    'reset role',
    `select '__RESULT__' || coalesce(current_setting('ps.rpc', true), '<<missing>>')`,
    'rollback',
  ].join('\n\\;\n');

  const out = await rpcSession.run(batch);
  if (out.payload === undefined || out.payload === '<<missing>>') {
    // The batch died before its own `rollback`, so the session is sitting in a failed
    // transaction and every later call would fail with 25P02 for no reason of its own.
    await rpcSession.recover();
    throw new Error(
      `tenant_contact probe returned no payload. This is a harness fault, not an ` +
        `authorization outcome, so it is raised rather than reported as a denial.\n` +
        `${(out.stderr || out.stdout).slice(0, 400)}`,
    );
  }

  const parsed = JSON.parse(out.payload) as {
    rows?: ContactRow[];
    error?: { code: string; message: string };
  };
  return { rows: parsed.rows ?? null, error: parsed.error ?? null };
}

/** `select id,<column> from tenants` as this role. Returns the driver's verdict. */
async function selectTenantColumn(org: OrgKey, role: MemberRole, columns: string, rowId: string) {
  return clientFor(world, org, role).select('tenants', { columns, eq: { id: rowId } });
}

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

  it('cannot read the other tenant`s name by any filter, and cannot reach a contact column at all', async () => {
    // `email` and `phone` are deliberately absent from the select list: since 0004 they
    // are not SELECT-able by the `authenticated` role, so naming them here would fail
    // with 42501 for a reason that has nothing to do with this tenant's row scope. The
    // row scope is asserted on `full_name`; the contact columns are asserted below, and
    // again in the 0004 block at the foot of this file.
    const client = clientFor(world, 'A', 'tenant');
    const { data, error } = await client.select('tenants', { columns: 'id,full_name' });
    expect(error).toBeNull();

    const f = orgFixture(world, 'A');
    const rows = (data ?? []) as { id: string; full_name: string | null }[];

    expect(
      rows.map((r) => r.id),
      'A tenant listing `tenants` must see exactly their own record.',
    ).toEqual([f.tenants.t1]);

    const leaked = rows.filter((r) => r.full_name === SHARED_SHAPE.tenantNames[1]);
    expect(leaked, 'another tenant`s name was returned').toEqual([]);

    // And the contact columns are not reachable even for the caller's OWN row — the one
    // row RLS does hand them. A tenant is entitled to their own email and phone under
    // the §4 matrix, but through `tenant_contact()`, not through a column grant that
    // would hand the same columns to everyone else sharing the `authenticated` role.
    for (const column of ['email', 'phone'] as const) {
      const { error: refusal } = await client.select('tenants', {
        columns: `id,${column}`,
        eq: { id: f.tenants.t1 },
      });
      expect(
        refusal,
        `tenants.${column} came back to a client session. 0004 revoked the table-level ` +
          'SELECT grant and granted back five columns precisely so this column has one ' +
          'read path; if it is selectable again the provider PII leak is reopened.',
      ).not.toBeNull();
    }
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
      const { data } = await client.select(table, { columns: 'id', eq: { id: id } });
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
    const { data } = await client.select('tenants', { columns: 'id' });
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

    const { data, error } = await client.select('maintenance_tickets', {
      columns: 'id,assigned_provider_id',
    });
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
    //
    // Before 0004 this case accepted either outcome — a refusal OR an empty-looking
    // result — because no policy could withhold a column and the assertion had to be
    // satisfiable. That tolerance is gone: the column grant is the control now, so
    // nothing less than a hard refusal is acceptable, and `exposed.length === 0` would
    // be a false green the moment the grant came back.
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'service_provider');

    const { data: nameOnly, error: nameError } = await client.select('tenants', {
      columns: 'id,full_name',
      eq: { id: f.tenants.t1 },
    });
    expect(
      nameError,
      `provider could not read the assigned tenant's name: ${nameError?.message}`,
    ).toBeNull();
    expect((nameOnly ?? []).length).toBe(1);
    expect((nameOnly ?? [])[0]).toMatchObject({ full_name: SHARED_SHAPE.tenantNames[0] });

    for (const columns of ['id,email', 'id,phone', 'id,email,phone'] as const) {
      const { data: contact, error: contactError } = await client.select('tenants', {
        columns,
        eq: { id: f.tenants.t1 },
      });

      expect(
        contactError,
        `a service_provider selected \`${columns}\` from tenants and Postgres allowed ` +
          'it. This is the exact leak 0004 closed: the provider holds the assigned ' +
          'ticket, so RLS hands it the ROW, and only the column grant withholds the ' +
          'contact details. Returned rows: ' +
          JSON.stringify(contact ?? []),
      ).not.toBeNull();
      expect(
        isAuthorizationRefusal(contactError),
        `tenants(${columns}) failed for the wrong reason: ${contactError?.code ?? '-'} ` +
          `${contactError?.message ?? ''}`,
      ).toBe(true);
    }

    // `select *` is the lazy spelling the application never writes and an attacker
    // always does. It must be refused too, for the same reason the invitation
    // token_hash case asserts it: a column grant that only holds against an explicit
    // column list holds against nothing.
    const star = await client.select('tenants', { columns: '*' });
    expect(
      star.error,
      '`select *` on tenants returned rows to a service_provider, so every column the ' +
        'grant withholds — email and phone — came back anyway.',
    ).not.toBeNull();

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

    const { data: properties } = await client.select('properties', { columns: 'id' });
    expect((properties ?? []).map((r) => (r as { id: string }).id)).toEqual([f.properties.p1]);

    const { data: units } = await client.select('property_units', { columns: 'id' });
    expect((units ?? []).map((r) => (r as { id: string }).id)).toEqual([f.units.p1u1]);
    recordPass({ dimension: 'integrity', label: 'provider property/unit scope' });
  });
});

describe('a property owner sees only what they own', () => {
  it('every property it can see is one it owns', async () => {
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'property_owner');

    const { data, error } = await client.select('properties', { columns: 'id,owner_member_id' });
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
      const { data } = await client.select(table, { columns: 'id' });
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
    const { data } = await clientFor(world, 'A', 'property_owner').select('tenants', {
      columns: 'id',
    });
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
      const { data, error } = await clientFor(world, 'A', role).select('audit_logs', {
        columns: 'id',
      });
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

    const { data, error } = await clientFor(world, 'A', 'organization_admin').select('profiles', {
      columns: 'id,email',
    });
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
    const { data } = await clientFor(world, 'A', 'tenant').select('profiles', { columns: 'id' });
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
      'documents.ticket_id is absent. Amendment A7 (§5.8) scopes a service_provider`s ' +
        'documents INSERT and SELECT to an assigned ticket, and 0002 creates those two ' +
        'policies only once the column exists — 0003 adds it and then calls ' +
        'ensure_document_provider_policies(). Without the column there is no evidence ' +
        'path at all, so the two assertions below would fail for a reason that has ' +
        'nothing to do with RLS.',
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
    // property_id and tenancy_id are omitted deliberately: the policy forces both null
    // so that a provider cannot staple evidence onto a tenancy or a property and expose
    // it to that tenancy's tenant or that property's owner. Evidence is ticket-scoped.
    const base = {
      organization_id: f.organizationId,
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

describe('tenant contact details have exactly one read path (migration 0004)', () => {
  // See the long note at the head of this file for why the control is a GRANT and not a
  // policy. These cases pin both halves of it: the column is closed to everybody, and
  // the one accessor that reopens it answers only the two principals §4 entitles.

  const ALL_FIVE: readonly MemberRole[] = [
    'organization_admin',
    'property_manager',
    'property_owner',
    'tenant',
    'service_provider',
  ];

  it('no role can select tenants.email or tenants.phone — staff included', async () => {
    // The point of sweeping every role rather than only the provider: a grant
    // discriminates by NOTHING. `authenticated` is one Postgres role shared by all five
    // application roles, so the protection either holds for all of them or for none.
    // Asserting it for staff too is what makes this case meaningful against a
    // compromised or escalated staff session — the attacker's prize is the tenant
    // contact list, and an organization_admin JWT is the likeliest way to reach for it.
    const f = orgFixture(world, 'A');

    for (const role of ALL_FIVE) {
      for (const columns of ['id,email', 'id,phone'] as const) {
        // t1 on purpose for every role: it is the row the tenant owns, the row the
        // provider's assigned ticket points at, and a row staff see anyway. So in every
        // one of these five cases RLS grants the ROW and the column grant is the only
        // thing left to refuse the read.
        const { data, error } = await selectTenantColumn('A', role, columns, f.tenants.t1);

        expect(
          error,
          `${role} selected \`${columns}\` from public.tenants without being refused. ` +
            '0004 revoked the table-level SELECT grant and granted back only ' +
            'id, organization_id, profile_id, full_name, created_at. If this call ' +
            'succeeds the grant has been widened again and the leak is live for every ' +
            `role at once. Rows: ${JSON.stringify(data ?? [])}`,
        ).not.toBeNull();
        expect(
          isAuthorizationRefusal(error),
          `${role}/${columns}: refused for the wrong reason: ${error?.code ?? '-'} ` +
            `${error?.message ?? ''}`,
        ).toBe(true);
      }
    }
    recordPass({
      dimension: 'integrity',
      label: 'tenants.email/phone selectable by no role, staff included',
    });
  });

  it('full_name is still readable, so the revoke did not simply close the table', async () => {
    // The negative above would also pass if `tenants` were unreadable altogether, which
    // would be a broken application rather than a hardened one. The five granted
    // columns have to still work.
    const f = orgFixture(world, 'A');
    const { data, error } = await selectTenantColumn(
      'A',
      'property_manager',
      'id,organization_id,profile_id,full_name,created_at',
      f.tenants.t1,
    );
    expect(error, `the five granted columns are not readable: ${error?.message}`).toBeNull();
    expect((data ?? []).length).toBe(1);
    expect((data ?? [])[0]).toMatchObject({ full_name: SHARED_SHAPE.tenantNames[0] });
    recordPass({ dimension: 'integrity', label: 'tenants granted columns still readable' });
  });

  it('tenant_contact answers staff of the owning organization', async (ctx) => {
    const f = orgFixture(world, 'A');

    for (const role of ['organization_admin', 'property_manager'] as const) {
      const one = await tenantContactAs(keyForRole('A', role), f.organizationId, f.tenants.t1);
      if (one.unsupported) {
        ctx.skip();
        return;
      }

      expect(
        one.error,
        `tenant_contact refused ${role} of the owning organization: ` +
          `${one.error?.code ?? '-'} ${one.error?.message ?? ''}. The §4 matrix gives ` +
          'staff RW on tenants, so a staff-blind accessor would make that cell ' +
          'unsatisfiable — a correctness defect in 0004, not a hardening win.',
      ).toBeNull();
      expect((one.rows ?? []).map((r) => r.tenant_id)).toEqual([f.tenants.t1]);
      expect(one.rows?.[0]?.email).toBe(SHARED_SHAPE.tenantEmails[0]);
      expect(one.rows?.[0]?.phone).toBe(SHARED_SHAPE.tenantPhones[0]);

      // p_tenant_id null means "every tenant in this organization you may see". A list
      // page needs that; one RPC per row is what would push someone to widen the grant.
      const all = await tenantContactAs(keyForRole('A', role), f.organizationId, null);
      expect(all.error).toBeNull();
      expect(
        (all.rows ?? []).map((r) => r.tenant_id).sort(),
        'the organization-wide form must return both seeded tenants',
      ).toEqual([f.tenants.t1, f.tenants.t2].sort());
    }
    // Label-only, with no (table, role, operation) triple: this proves a GRANT and an
    // accessor, not a policy, and a record shaped like a matrix cell would let it stand
    // in for a policy assertion the suite had lost.
    recordPass(
      { dimension: 'integrity', label: 'tenant_contact answers staff of the organization' },
      'allow',
    );
  });

  it('tenant_contact answers the tenant for their own row, and refuses them another', async (ctx) => {
    // §4 gives `tenant` "R self only" on tenants, and that cell includes their own
    // email and phone. The self branch is scoped by current_tenant_id(), so asking for
    // the neighbour's id must not fall through to it.
    const f = orgFixture(world, 'A');

    const own = await tenantContactAs(keyForRole('A', 'tenant'), f.organizationId, f.tenants.t1);
    if (own.unsupported) {
      ctx.skip();
      return;
    }
    expect(
      own.error,
      `tenant_contact refused a tenant their own row: ${own.error?.message}`,
    ).toBeNull();
    expect((own.rows ?? []).map((r) => r.tenant_id)).toEqual([f.tenants.t1]);
    expect(own.rows?.[0]?.email).toBe(SHARED_SHAPE.tenantEmails[0]);

    const neighbour = await tenantContactAs(
      keyForRole('A', 'tenant'),
      f.organizationId,
      f.tenants.t2,
    );
    expect(
      neighbour.error?.code,
      'a tenant obtained ANOTHER tenant`s contact details through tenant_contact — ' +
        'the self branch is not scoped by current_tenant_id(). Rows: ' +
        JSON.stringify(neighbour.rows ?? []),
    ).toBe('42501');

    // The organization-wide form must not become a back door either: asking for
    // everyone returns the caller's own row only.
    const wide = await tenantContactAs(keyForRole('A', 'tenant'), f.organizationId, null);
    expect(
      (wide.rows ?? []).map((r) => r.tenant_id),
      'the null form returned more than the calling tenant`s own row',
    ).toEqual([f.tenants.t1]);

    recordPass({ dimension: 'integrity', label: 'tenant_contact is self-scoped for a tenant' });
  });

  it('tenant_contact refuses a service_provider holding the assigned ticket', async (ctx) => {
    // The provider is the one role that CAN see the row — ticket K1 is assigned to it,
    // so `tenants_select_provider_assigned` hands it the record. That is precisely why
    // this is the case that matters in-organization: the row is legitimately visible
    // and the contact details still must not be. A property_owner, who sees no tenant
    // row at all, is asserted alongside it so a regression that merely re-checked row
    // visibility would not pass.
    const f = orgFixture(world, 'A');

    for (const role of ['service_provider', 'property_owner'] as const) {
      const outcome = await tenantContactAs(keyForRole('A', role), f.organizationId, f.tenants.t1);
      if (outcome.unsupported) {
        ctx.skip();
        return;
      }
      expect(
        outcome.error?.code,
        `tenant_contact answered a ${role}. §4 limits service_provider to "R name ` +
          'only, via assignment" and gives property_owner nothing on tenants, so the ' +
          'accessor must raise 42501 for both. Rows: ' +
          JSON.stringify(outcome.rows ?? []),
      ).toBe('42501');

      // And the organization-wide form, which is the shape a scraper would reach for.
      const wide = await tenantContactAs(keyForRole('A', role), f.organizationId, null);
      expect(
        wide.error?.code,
        `tenant_contact(organization, null) answered a ${role} — the whole ` +
          'organization`s contact list in one call.',
      ).toBe('42501');
    }

    recordPass({
      dimension: 'integrity',
      label: 'tenant_contact refuses a provider holding the assigned ticket',
    });
  });

  it('tenant_contact refuses staff of a DIFFERENT organization', async (ctx) => {
    // The one that matters most in this file. `tenant_contact` is `security definer`,
    // so it reads `public.tenants` with row level security switched OFF — every policy
    // that isolates organization A from organization B is inert inside it. The only
    // thing standing between organization B's admin and organization A's tenant contact
    // list is the `is_org_staff(p_organization_id)` check and the
    // `t.organization_id = p_organization_id` filter in the body.
    //
    // `p_organization_id` is supplied by the caller, which is exactly the shape
    // CLAUDE.md rule 5 warns about — so the parameter is not trusted as authority, it
    // is the thing being authorised against. A definer function that forgot that check
    // would be a platform-wide PII breach reachable by any authenticated user with a
    // uuid, and no policy anywhere in the database would catch it.
    const a = orgFixture(world, 'A');
    const b = orgFixture(world, 'B');

    for (const role of ['organization_admin', 'property_manager'] as const) {
      // B's staff, naming A's organization and A's tenant.
      const targeted = await tenantContactAs(keyForRole('B', role), a.organizationId, a.tenants.t1);
      if (targeted.unsupported) {
        ctx.skip();
        return;
      }
      expect(
        targeted.error?.code,
        `organization B's ${role} read organization A's tenant contact details through ` +
          'tenant_contact. The function is security definer, so RLS did not stop it and ' +
          'cannot: the is_org_staff(p_organization_id) check is the entire boundary. ' +
          'Rows: ' +
          JSON.stringify(targeted.rows ?? []),
      ).toBe('42501');

      // And the sweep form: B's staff asking for every tenant in A.
      const sweep = await tenantContactAs(keyForRole('B', role), a.organizationId, null);
      expect(
        sweep.error?.code,
        `organization B's ${role} enumerated organization A's entire tenant contact ` +
          'list in a single call.',
      ).toBe('42501');

      // Symmetry, from a real session on the other side rather than inferred: A's staff
      // must be equally blind to B.
      const mirrored = await tenantContactAs(keyForRole('A', role), b.organizationId, b.tenants.t1);
      expect(
        mirrored.error?.code,
        `organization A's ${role} read organization B's tenant contact details.`,
      ).toBe('42501');
    }

    recordPass({
      dimension: 'cross_org',
      label: 'tenant_contact is organization-scoped despite security definer',
    });
  });
});

/* --------------------------------- the outbound ledger (migration 0006) -- */

describe('the outbound ledger is staff infrastructure (migration 0006)', () => {
  // `outbound_messages` records what the organization SENT a tenant on WhatsApp. One
  // policy, one operation, one audience: staff of the owning organization may SELECT.
  //
  // cross-role.test.ts already generates the matrix cells for this table and
  // cross-organization.test.ts already generates the boundary cases. These are the
  // claims stated in their own terms, because two of them read as surprising and a
  // generated `expectNothingVisible` does not explain itself to whoever next wonders
  // whether the tenant was locked out by accident.

  const OUTBOUND_POLICIES = ['outbound_messages_select_staff'];

  const EVERY_ROLE: readonly MemberRole[] = [
    'organization_admin',
    'property_manager',
    'property_owner',
    'tenant',
    'service_provider',
  ];

  it('staff of the owning organization read both rows, including the provenance columns', async () => {
    // Asserted first and deliberately: every negative below would also hold against a
    // table nobody can read, which would be an outage rather than a control. And the
    // columns named here are the point of the row existing — `drafted_by` and
    // `sent_by_profile_id` are the pair that records a human having released a
    // model-drafted reply (CLAUDE.md rule 7).
    const f = orgFixture(world, 'A');

    for (const role of ['organization_admin', 'property_manager'] as const) {
      const { data, error } = await clientFor(world, 'A', role).select('outbound_messages', {
        columns: 'id,kind,drafted_by,sent_by_profile_id,status,to_identifier',
        eq: { organization_id: f.organizationId },
      });
      expect(
        error,
        `${role} could not read its own organization's outbound ledger: ${error?.message}`,
      ).toBeNull();

      const rows = (data ?? []) as {
        id: string;
        kind: string;
        drafted_by: string;
        sent_by_profile_id: string | null;
      }[];
      const byId = new Map(rows.map((r) => [r.id, r]));

      expect(
        byId.get(f.outboundMessages.om1),
        `${role} cannot see the automatic acknowledgement we sent`,
      ).toMatchObject({ kind: 'acknowledgement', drafted_by: 'system', sent_by_profile_id: null });

      expect(
        byId.get(f.outboundMessages.om2),
        `${role} cannot see the staff reply, so the evidence that a human released a ` +
          'model-drafted message is unreadable by the people accountable for it',
      ).toMatchObject({
        kind: 'staff_reply',
        drafted_by: 'ai',
        sent_by_profile_id: f.profiles.a_manager ?? null,
      });
    }

    recordPass({
      dimension: 'in_org',
      table: 'outbound_messages',
      role: 'organization_admin',
      operation: 'select',
      policies: OUTBOUND_POLICIES,
      label: 'staff read the outbound ledger including provenance',
    });
  });

  it('the tenant we sent the message to cannot read the record of it', async () => {
    // The surprising one. The tenant HAS this message — it arrived on their phone, which
    // was the entire purpose of sending it. What the row adds is `drafted_by` (was the
    // reply they received written by a model?), `sent_by_profile_id` (which member of
    // staff released it) and the delivery state. That is how the organization operates
    // internally, disclosed to the person it operates on, and it is not theirs.
    //
    // Probed three ways, because a policy can be wrong in three different ways: by row
    // id, by filtering on their own phone number, and by filtering on their own tenant
    // id. The last two are the realistic shapes — a tenant does not know a row id, but
    // they certainly know their own number.
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'tenant');

    for (const id of [f.outboundMessages.om1, f.outboundMessages.om2]) {
      await expectSelectDenied(client, 'outbound_messages', id, {
        dimension: 'in_org',
        table: 'outbound_messages',
        role: 'tenant',
        operation: 'select',
        policies: OUTBOUND_POLICIES,
      });
    }

    for (const filter of [
      { to_identifier: SHARED_SHAPE.tenantPhones[0] },
      { tenant_id: f.tenants.t1 },
    ]) {
      const { data, error } = await client.select('outbound_messages', {
        columns: 'id',
        eq: filter,
      });
      if (error) {
        expect(
          isAuthorizationRefusal(error),
          `outbound_messages filtered by ${JSON.stringify(filter)} failed for the wrong ` +
            `reason: ${error.code ?? '-'} ${error.message}`,
        ).toBe(true);
      } else {
        expect(
          data ?? [],
          'a tenant listed the messages we sent to their own number by filtering on ' +
            `${JSON.stringify(filter)}. The ledger is staff infrastructure: it carries ` +
            'who drafted the reply and which member of staff released it.',
        ).toEqual([]);
      }
    }

    recordPass({
      dimension: 'integrity',
      label: 'outbound ledger invisible to the recipient tenant',
    });
  });

  it('the property owner and the service provider see nothing at all', async () => {
    // Neither has any claim on a conversation between the organization and a resident.
    // The provider is the sharper of the two: they hold the assigned ticket K1, which
    // the acknowledgement OM1 is about, so any policy that reasoned from the ticket
    // rather than from staff membership would hand them the row.
    for (const role of ['property_owner', 'service_provider'] as const) {
      await expectNothingVisible(clientFor(world, 'A', role), 'outbound_messages', {
        dimension: 'in_org',
        table: 'outbound_messages',
        role,
        operation: 'select',
        policies: OUTBOUND_POLICIES,
      });
    }
  });

  it('staff of a DIFFERENT organization cannot read what we said to our tenants', async () => {
    // The one that matters most in this block, and asserted in BOTH directions: a
    // predicate with the organization hard-coded the wrong way round passes in one
    // direction only.
    //
    // Both organizations hold an identically-worded acknowledgement sent to an
    // identical phone number, so a leak cannot be spotted by reading the row — only by
    // comparing identifiers, which is what happens here.
    const a = orgFixture(world, 'A');
    const b = orgFixture(world, 'B');
    expect(
      a.outboundMessages.om1,
      'both organizations seeded the same outbound row id, so the comparison below ' +
        'could not tell a leak from a legitimate read',
    ).not.toBe(b.outboundMessages.om1);

    for (const [actor, target] of [
      ['A', 'B'],
      ['B', 'A'],
    ] as const) {
      const theirs = orgFixture(world, target);
      const mine = orgFixture(world, actor);

      for (const role of ['organization_admin', 'property_manager'] as const) {
        const client = clientFor(world, actor, role);

        for (const id of [theirs.outboundMessages.om1, theirs.outboundMessages.om2]) {
          await expectSelectDenied(client, 'outbound_messages', id, {
            dimension: 'cross_org',
            table: 'outbound_messages',
            role,
            operation: 'select',
            policies: OUTBOUND_POLICIES,
          });
        }

        // And the enumeration shape, which an id-by-id probe cannot reach: an
        // unfiltered list must contain this organization's rows and nothing else.
        const { data, error } = await client.select('outbound_messages', {
          columns: 'id,organization_id',
        });
        expect(error, `${role} of ${actor}: ${error?.message}`).toBeNull();
        const rows = (data ?? []) as { id: string; organization_id: string }[];
        expect(
          rows.filter((r) => r.organization_id !== mine.organizationId).map((r) => r.id),
          `${role} of organization ${actor} listed organization ${target}'s outbound ` +
            'messages. One organization can read what another said to its own tenants, ' +
            'which is the leak this project exists to prevent.',
        ).toEqual([]);
        expect(
          rows.length,
          `${role} of organization ${actor} sees no outbound rows at all, so the ` +
            'negative above would hold against an empty table and proves nothing',
        ).toBeGreaterThan(0);
      }
    }

    recordPass({
      dimension: 'cross_org',
      table: 'outbound_messages',
      role: 'organization_admin',
      operation: 'select',
      policies: OUTBOUND_POLICIES,
      label: 'outbound ledger is organization-scoped in both directions',
    });
  });

  it('no client role can write to the ledger at all — not even the organization admin', async () => {
    // The live counterpart to 'leaves outbound_messages with no client write path at
    // all' in harness.test.ts. The security property is an ABSENCE: no INSERT, UPDATE
    // or DELETE policy, and no such privilege. An INSERT privilege would be a channel
    // for sending WhatsApp messages to tenants in the organization's name; an UPDATE
    // privilege would be the ability to rewrite the record of what was said to whom,
    // including which human released it.
    //
    // Swept over every role rather than a low-privileged one: `authenticated` is a
    // single Postgres role shared by all five application roles, so a leaked privilege
    // leaks to all five at once — and the admin session is the likeliest one for an
    // attacker to be holding.
    const f = orgFixture(world, 'A');
    const reader = clientFor(world, 'A', 'organization_admin');
    const columns = 'id,body,kind,drafted_by,sent_by_profile_id,status';

    const { data: before } = await reader.select('outbound_messages', {
      columns,
      eq: { id: f.outboundMessages.om2 },
    });
    expect((before ?? []).length, 'the fixture row to be protected is missing').toBe(1);

    for (const role of EVERY_ROLE) {
      const client = clientFor(world, 'A', role);

      await expectInsertDenied(
        client,
        'outbound_messages',
        {
          id: randomUUID(),
          organization_id: f.organizationId,
          inbound_message_id: null,
          tenant_id: f.tenants.t1,
          to_identifier: SHARED_SHAPE.tenantPhones[0],
          body: 'Please transfer the deposit to the account below.',
          kind: 'staff_reply',
          drafted_by: 'human',
          sent_by_profile_id: f.profiles[keyForRole('A', role)] ?? null,
          provider: 'whatsapp',
          provider_message_id: null,
          status: 'queued',
        },
        {
          dimension: 'in_org',
          table: 'outbound_messages',
          role,
          operation: 'insert',
          policies: OUTBOUND_POLICIES,
          label: 'message forged into the outbound ledger',
        },
      );

      // Rewriting the provenance of a message that WAS sent: the shape that turns a
      // model-drafted reply into one the record claims a human wrote.
      await expectUpdateDenied(
        client,
        'outbound_messages',
        f.outboundMessages.om2,
        { drafted_by: 'human', body: 'Rewritten after the fact.' },
        {
          dimension: 'in_org',
          table: 'outbound_messages',
          role,
          operation: 'update',
          policies: OUTBOUND_POLICIES,
          label: 'provenance rewritten',
        },
        { verifyWith: reader, verifyColumn: 'drafted_by' },
      );

      await expectDeleteDenied(
        client,
        'outbound_messages',
        f.outboundMessages.om1,
        {
          dimension: 'in_org',
          table: 'outbound_messages',
          role,
          operation: 'delete',
          policies: OUTBOUND_POLICIES,
        },
        { verifyWith: reader },
      );
    }

    const { data: after } = await reader.select('outbound_messages', {
      columns,
      eq: { id: f.outboundMessages.om2 },
    });
    expect(after, 'the outbound ledger row was altered by a client session').toEqual(before);

    const { data: survivor } = await reader.select('outbound_messages', {
      columns: 'id',
      eq: { id: f.outboundMessages.om1 },
    });
    expect((survivor ?? []).length, 'the acknowledgement row was deleted by a client').toBe(1);

    recordPass({
      dimension: 'integrity',
      label: 'outbound ledger has no client write path, for any role',
    });
  });
});
