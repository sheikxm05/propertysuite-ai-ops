/**
 * Harness self-tests. Lane w0-l6.
 *
 * These run with no database and no Docker, and they guard the two things that would
 * otherwise make the isolation suite quietly incomplete:
 *
 *   - the table list drifting behind the migrations, so a table added later never gets
 *     a cross-organization test;
 *   - scripts/make-jwts.mjs changing shape, so the TypeScript facade over it silently
 *     narrows to `undefined` and every client turns out to be unauthenticated.
 *
 * Deliberately NOT in tests/rls: these are unit tests of the harness and belong in the
 * default `npm test` run, where they protect the suite even when nobody has Docker up.
 */

import { describe, expect, it } from 'vitest';
import {
  CLIENT_ROLES,
  NON_TENANT_RLS_TABLES,
  PLATFORM_PLANE_TABLES,
  TENANT_SCOPED_TABLES,
  TABLES_WITH_ORGANIZATION_ID,
  clientGrantsOn,
  createTableBody,
  isColumnNotNull,
  isRevokedFrom,
  migrationFiles,
  parseIndexes,
  parsePolicies,
  parseRevokes,
  parseRlsEnabledTables,
  parseTablesWithOrganizationId,
  policyStatementsFor,
} from './tables';
import { loadJwtFactory, REQUIRED_FACTORY_EXPORTS } from './jwt-factory';
import { pathTo } from './scratch';

describe('migration parsing', () => {
  it('finds the migrations', () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0]).toMatch(/^0001_/);
  });

  it('every table with an organization_id column is in the registry', () => {
    const parsed = parseTablesWithOrganizationId();
    expect(parsed.length).toBeGreaterThan(0);
    // The one admissible excuse for carrying organization_id and still staying out of
    // the suite: NO CLIENT CAN REACH A ROW AT ALL. Row level security on, zero policies,
    // every privilege revoked — a table a client cannot read or write cannot leak one
    // organization's rows to another through a client, so there is nothing for a
    // cross-organization assertion to prove. 'every table excluded from the registry has
    // earned its exclusion' below re-derives all three of those facts from the SQL, so
    // the excuse cannot outlive the thing that made it true.
    const unreachable = new Set(Object.keys(NON_TENANT_RLS_TABLES));
    const missing = parsed.filter(
      (t) => !(TENANT_SCOPED_TABLES as readonly string[]).includes(t) && !unreachable.has(t),
    );
    expect(
      missing,
      'A table carrying organization_id has no entry in TENANT_SCOPED_TABLES, so the ' +
        'cross-organization suite never touches it. Add it to tests/_harness/tables.ts ' +
        'and give it a probe.',
    ).toEqual([]);
  });

  it('every table any migration enables RLS on is in the registry', () => {
    // The only permitted exclusions are a written entry in NON_TENANT_RLS_TABLES (no
    // client can reach a row) or in PLATFORM_PLANE_TABLES (a client can reach only a
    // fact about itself, on a table with no organization scope). The two tests below
    // re-derive from the SQL whether each entry is still true.
    const excluded = new Set([
      ...Object.keys(NON_TENANT_RLS_TABLES),
      ...Object.keys(PLATFORM_PLANE_TABLES),
    ]);
    const rlsTables = parseRlsEnabledTables().filter((t) => !excluded.has(t));
    const missing = rlsTables.filter(
      (t) => !(TENANT_SCOPED_TABLES as readonly string[]).includes(t),
    );
    expect(
      missing,
      'RLS is enabled on a table the suite does not test. Add it to ' +
        'TENANT_SCOPED_TABLES with a probe, or — only if it carries no tenant scope at ' +
        'all — record why in NON_TENANT_RLS_TABLES or PLATFORM_PLANE_TABLES, which the ' +
        'tests below will hold you to.',
    ).toEqual([]);
  });

  it('every table excluded from the registry has earned its exclusion', () => {
    // An exclusion is a hole in the isolation suite, so it is not taken on the strength
    // of the comment next to it. A table is allowed to sit outside TENANT_SCOPED_TABLES
    // only while all three of these remain true in the SQL:
    //
    //   1. RLS is enabled on it                 — otherwise it is simply unprotected;
    //   2. no policy exists on it               — a policy means some client CAN reach
    //                                             rows, and then the suite must test it;
    //   3. no client role holds any privilege   — RLS with no policies denies, but a
    //                                             grant plus a future stray policy would
    //                                             open it silently.
    const rlsEnabled = new Set(parseRlsEnabledTables());
    const policies = parsePolicies();

    for (const [table, reason] of Object.entries(NON_TENANT_RLS_TABLES)) {
      expect(reason.trim().length, `${table}: exclusions need a written reason`).toBeGreaterThan(
        20,
      );

      expect(
        rlsEnabled.has(table),
        `${table} is excluded from the tenant-scoped registry on the grounds that row ` +
          'level security plus zero policies denies everyone — but no migration enables ' +
          'row level security on it at all, so it is simply open.',
      ).toBe(true);

      expect(
        policies.filter((p) => p.table === table).map((p) => p.name),
        `${table} is excluded from the registry because no client can reach it, yet a ` +
          'policy now exists on it. A policy means some client CAN reach rows, so the ' +
          'table belongs in TENANT_SCOPED_TABLES with a probe.',
      ).toEqual([]);

      expect(
        clientGrantsOn(table),
        `${table} is excluded from the registry as service-role only, but a migration ` +
          `grants a table privilege on it to a client role (${CLIENT_ROLES.join('/')}).`,
      ).toEqual([]);

      for (const role of ['anon', 'authenticated']) {
        expect(
          isRevokedFrom(table, 'all', role),
          `${table}: ALL is not revoked from ${role}. Supabase's default ACL leaves ` +
            '`authenticated` with arwdDxtm on a new table, so a table that is never ' +
            'explicitly revoked is NOT service-role only, whatever the comment says.',
        ).toBe(true);
      }
    }
  });

  it('every registry table has RLS enabled by some migration', () => {
    const rlsTables = new Set(parseRlsEnabledTables());
    const unprotected = TENANT_SCOPED_TABLES.filter((t) => !rlsTables.has(t));
    expect(
      unprotected,
      'A tenant-scoped table with no `enable row level security`. In 0001 this is true ' +
        'of organizations and profiles — findings 1 and 2 — and 0002 is what closes it.',
    ).toEqual([]);
  });

  it('grants no DELETE policy on any tenant-scoped table', () => {
    const deletePolicies = parsePolicies().filter(
      (p) =>
        p.command === 'delete' && (TENANT_SCOPED_TABLES as readonly string[]).includes(p.table),
    );
    expect(
      deletePolicies.map((p) => `${p.table}:${p.name}`),
      'docs/implementation-plan.md §4: no DELETE is granted on any table. Archive instead.',
    ).toEqual([]);
  });

  it('uses no `for all` policy on a tenant-scoped table', () => {
    // Finding 5: a `for all` policy grants DELETE as a side effect of granting write.
    const forAll = parsePolicies().filter(
      (p) => p.command === 'all' && (TENANT_SCOPED_TABLES as readonly string[]).includes(p.table),
    );
    expect(
      forAll.map((p) => `${p.table}:${p.name} (${p.file})`),
      'A `for all` policy silently grants DELETE (finding 5). Per-operation policies only.',
    ).toEqual([]);
  });

  it('every platform-plane table stays outside the tenant plane', () => {
    // PLATFORM_PLANE_TABLES is the harder exclusion of the two: a policy exists, so a
    // client CAN reach rows, and the claim is only that it can reach nothing but a fact
    // about itself on a table with no organization scope. Each half is re-derived here.
    const rlsEnabled = new Set(parseRlsEnabledTables());
    const withOrganizationId = new Set(parseTablesWithOrganizationId());
    const policies = parsePolicies();

    for (const [table, reason] of Object.entries(PLATFORM_PLANE_TABLES)) {
      expect(reason.trim().length, `${table}: exclusions need a written reason`).toBeGreaterThan(
        20,
      );
      expect(rlsEnabled.has(table), `${table}: row level security is not enabled`).toBe(true);

      expect(
        withOrganizationId.has(table),
        `${table} has acquired an organization_id column. A platform operator scoped to ` +
          'an organization IS an organization role, and the disjointness this exclusion ' +
          'rests on collapses — the table becomes tenant data and belongs in ' +
          'TENANT_SCOPED_TABLES with a probe.',
      ).toBe(false);

      const mine = policies.filter((p) => p.table === table);
      expect(
        mine.filter((p) => p.command !== 'select').map((p) => `${p.name} (${p.command})`),
        `${table}: a write policy appeared on the platform plane. Granting yourself ` +
          'cross-organization reach must require the service role.',
      ).toEqual([]);
      expect(
        mine.map((p) => p.name),
        `${table}: expected exactly one self-scoped SELECT policy. Who holds ` +
          'cross-organization reach is operational information, and an enumerable list ' +
          'of them is a target list — so any second policy, or a policy not named ' +
          '`_select_self`, has to be looked at by a human rather than assumed benign.',
      ).toEqual([`${table}_select_self`]);

      for (const privilege of ['insert', 'update', 'delete']) {
        expect(
          isRevokedFrom(table, privilege, 'authenticated'),
          `${table}: ${privilege.toUpperCase()} is not revoked from \`authenticated\`.`,
        ).toBe(true);
      }
      expect(
        clientGrantsOn(table).filter((p) => p !== 'select'),
        `${table}: a client role is granted more than SELECT.`,
      ).toEqual([]);
    }
  });

  it('leaves agent_proposals with no client UPDATE path at all', () => {
    // CLAUDE.md rule 7, made structural by 0004: a proposal becomes `approved` only
    // through approve_agent_proposal() / reject_agent_proposal(), both security definer
    // and both checking is_org_staff(). The ABSENCE of an UPDATE policy is the security
    // property, so it is asserted here rather than worked around in a probe.
    //
    // Both halves matter, and they fail differently. A missing policy is quiet — the
    // statement matches zero rows and returns 200. A missing privilege is loud — 42501.
    // The negative-write suite wants loud, and the privilege is also what makes the
    // absent policy hold under amendment: someone adding a well-meaning UPDATE policy
    // later still cannot open this path.
    const writable = parsePolicies().filter(
      (p) => p.table === 'agent_proposals' && (p.command === 'update' || p.command === 'all'),
    );
    expect(
      writable.map((p) => `${p.name} (${p.file})`),
      'An UPDATE policy now exists on agent_proposals. The only transition into ' +
        '`approved` must be approve_agent_proposal(), or the model can commit its own ' +
        'proposals and CLAUDE.md rule 7 is decoration.',
    ).toEqual([]);

    expect(
      isRevokedFrom('agent_proposals', 'update', 'authenticated'),
      'UPDATE is not revoked from `authenticated` on agent_proposals. Relying on the ' +
        'absent policy alone makes the refusal silent, and leaves one stray policy ' +
        'between a browser session and an approved proposal.',
    ).toBe(true);

    expect(
      clientGrantsOn('agent_proposals').filter((p) => p === 'update' || p === 'all'),
      'A migration grants UPDATE on agent_proposals back to a client role.',
    ).toEqual([]);
  });

  it('gives document_chunks and inbound_messages no client write path', () => {
    // Both are written by a service-role worker only. A client that could write chunks
    // could poison its own organization's retrieval — the one injection vector a RAG
    // store has — and a client that could edit an inbound message could forge the
    // evidence an AI classification was based on.
    for (const table of ['document_chunks', 'inbound_messages']) {
      const writePolicies = parsePolicies().filter(
        (p) => p.table === table && p.command !== 'select',
      );
      expect(
        writePolicies.map((p) => `${p.name} ${p.command}`),
        `${table} has a write policy, but it is derived data written with the service role.`,
      ).toEqual([]);

      for (const privilege of ['insert', 'update', 'delete']) {
        expect(
          isRevokedFrom(table, privilege, 'authenticated'),
          `${table}: ${privilege.toUpperCase()} is not revoked from \`authenticated\`.`,
        ).toBe(true);
      }

      expect(
        clientGrantsOn(table).filter((p) => p !== 'select'),
        `${table}: a client role is granted more than SELECT.`,
      ).toEqual([]);
    }
  });

  it('leaves outbound_messages with no client write path at all', () => {
    // The same property as the agent_proposals gate above, pinned for the same reason:
    // the SECURITY CONTROL IS AN ABSENCE, and an absence is not self-asserting. Nothing
    // in a live RLS run notices a write policy appearing on this table — the suite
    // would simply start proving that writes are allowed, and go green doing it.
    //
    // What a client write would buy an attacker here is worth stating plainly, because
    // it is larger than it looks. `outbound_messages` is not an inbox: every row is a
    // message the organization SENT to a real phone number. An INSERT privilege is a
    // channel for sending WhatsApp messages to tenants in the organization's name. An
    // UPDATE privilege is the ability to rewrite the record of what was said to whom,
    // after the fact — including `drafted_by`, which is the only durable evidence that
    // a reply was model-drafted, and `sent_by_profile_id`, which is the only record of
    // which human released it. Those two columns are CLAUDE.md rule 7's audit trail.
    //
    // Both halves of the absence are asserted, and they fail differently: a missing
    // policy is quiet (the statement matches zero rows and returns 200), a missing
    // privilege is loud (42501). The privilege is also what keeps the absent policy
    // honest under amendment — a well-meaning UPDATE policy added later still cannot
    // open the path.
    const policies = parsePolicies().filter((p) => p.table === 'outbound_messages');

    expect(
      policies.length,
      policies.length === 0
        ? 'No policy on public.outbound_messages. Either migration 0006 has not landed ' +
          'yet — in which case this gate is correctly red and will clear when it does — ' +
          'or it landed without a policy, which means RLS denies staff their own ' +
          'organization`s outbound ledger and the feature is broken rather than secure.'
        : 'public.outbound_messages must carry EXACTLY ONE policy: staff of the owning ' +
          'organization may SELECT. A second policy on this table has to be read by a ' +
          `human rather than assumed benign. Found: ${policies
            .map((p) => `${p.name} (${p.command})`)
            .join(', ')}`,
    ).toBe(1);

    expect(
      policies.filter((p) => p.command !== 'select').map((p) => `${p.name} (${p.command})`),
      'A write policy now exists on outbound_messages. Sending is a service-role / ' +
        'security-definer path precisely so that no browser session can send a message ' +
        'to a tenant in the organization`s name, or rewrite the record of one.',
    ).toEqual([]);

    // Name-level checks cannot see a predicate, and the predicate is the whole claim:
    // a policy called `outbound_messages_select_staff` whose `using` clause said `true`
    // would satisfy every assertion above while handing every organization's outbound
    // ledger to every other. So the clause is read out of the SQL.
    const statements = policyStatementsFor('outbound_messages');
    expect(
      statements.some((s) => /is_org_staff\s*\(/i.test(s)),
      'The SELECT policy on outbound_messages does not call is_org_staff(). "Staff of ' +
        'the OWNING organization" is that function; a predicate written any other way ' +
        'has to be read by a human, because this is the table that proves one ' +
        'organization cannot read what another said to its tenants.',
    ).toBe(true);

    for (const privilege of ['insert', 'update', 'delete']) {
      expect(
        isRevokedFrom('outbound_messages', privilege, 'authenticated'),
        `outbound_messages: ${privilege.toUpperCase()} is not revoked from ` +
          '`authenticated`. Supabase`s default ACL hands `authenticated` arwdDxtm on a ' +
          'new table, so a table that is never explicitly revoked is NOT service-role ' +
          'only however the policies read.',
      ).toBe(true);
      expect(
        isRevokedFrom('outbound_messages', privilege, 'anon'),
        `outbound_messages: ${privilege.toUpperCase()} is not revoked from \`anon\`.`,
      ).toBe(true);
    }

    expect(
      clientGrantsOn('outbound_messages').filter((p) => p !== 'select'),
      'A migration grants more than SELECT on outbound_messages back to a client role. ' +
        'A revoke proves nothing if a later statement grants the privilege straight back.',
    ).toEqual([]);
  });

  it('keeps outbound_messages.organization_id NOT NULL, unlike inbound_messages', () => {
    // The asymmetry is deliberate and it is the reason this is a gate rather than a
    // comment. `inbound_messages.organization_id` is NULLABLE because a message arrives
    // before anyone knows whose it is, and guessing would cross the exact boundary this
    // project defends. Outbound is the mirror image: an unattributed message is never
    // replied to, so there is no legitimate row with no organization — and if the
    // column were nullable, a null row would be invisible to every is_org_staff()
    // policy and would sit in the table unreadable, un-auditable and un-attributable to
    // anyone, having already been delivered to a real person's phone.
    const body = createTableBody('outbound_messages');
    expect(
      body,
      'No migration creates public.outbound_messages, yet TENANT_SCOPED_TABLES declares ' +
        'it. Either 0006 has not landed yet, or the registry is ahead of the schema.',
    ).toBeDefined();

    expect(
      isColumnNotNull('outbound_messages', 'organization_id'),
      'outbound_messages.organization_id is nullable. Inbound may be unattributed; ' +
        'outbound may not. A null here produces a row no policy can match and nobody ' +
        'can audit, describing a message that was nonetheless delivered.',
    ).toBe(true);

    // The counterpart, asserted so this gate cannot be satisfied by making BOTH tables
    // NOT NULL — which would quietly destroy the unattributed-message case that
    // inbound_messages exists to prove.
    expect(
      isColumnNotNull('inbound_messages', 'organization_id'),
      'inbound_messages.organization_id has become NOT NULL. An unattributed inbound ' +
        'message must stay unattributed rather than be guessed into an organization; ' +
        'the whole `unmatched` fixture row and its negative assertions depend on it.',
    ).toBe(false);
  });

  it('allows at most one acknowledgement per inbound message', () => {
    // A partial unique index, and an access-control-adjacent control rather than a
    // performance one: without it, one inbound WhatsApp message can produce a stream of
    // automated replies to a tenant's phone — a retry loop, a redelivered webhook or a
    // replayed event all land as another "thanks, we have logged your request". Nothing
    // in a live RLS run would notice it going missing, so it is pinned here.
    const indexes = parseIndexes().filter((i) => i.table === 'outbound_messages');
    const acknowledgement = indexes.filter(
      (i) =>
        i.unique &&
        /\binbound_message_id\b/.test(i.columns) &&
        /\backnowledgement\b/.test(i.predicate),
    );

    expect(
      acknowledgement.map((i) => i.name),
      'No partial unique index on outbound_messages (inbound_message_id) where ' +
        "kind = 'acknowledgement'. One inbound message must produce at most one " +
        'automatic reply; a redelivered webhook or a retried send would otherwise ' +
        `message a tenant repeatedly. Indexes found on the table: ${
          indexes.map((i) => `${i.name}${i.unique ? ' (unique)' : ''}`).join(', ') || 'none'
        }`,
    ).not.toEqual([]);
  });

  it('revokes UPDATE and DELETE on maintenance_activities from client roles', () => {
    // Finding 6: "immutable by omission of a policy" is not immutability.
    const revokes = parseRevokes().filter((r) => r.table === 'maintenance_activities');
    const privileges = new Set(revokes.flatMap((r) => r.privileges));
    const covers = (p: string) => privileges.has(p) || privileges.has('all');
    expect(covers('update'), 'UPDATE is not revoked on maintenance_activities').toBe(true);
    expect(covers('delete'), 'DELETE is not revoked on maintenance_activities').toBe(true);
  });

  it('excludes organizations and profiles from the organization_id-keyed set', () => {
    expect(TABLES_WITH_ORGANIZATION_ID).not.toContain('organizations');
    expect(TABLES_WITH_ORGANIZATION_ID).not.toContain('profiles');
  });
});

describe('principal catalog', () => {
  it('exports everything the harness facade narrows to', async () => {
    const factory = await loadJwtFactory();
    const missing = REQUIRED_FACTORY_EXPORTS.filter(
      (name) => (factory as unknown as Record<string, unknown>)[name] === undefined,
    );
    expect(
      missing,
      'scripts/make-jwts.mjs no longer exports what tests/_harness/jwt-factory.ts ' +
        'declares. The facade would silently hand every test an undefined client.',
    ).toEqual([]);
  });

  it('describes exactly ten core principals: five roles x two organizations', async () => {
    const { PRINCIPALS, CORE_PRINCIPALS } = await loadJwtFactory();

    expect(CORE_PRINCIPALS).toHaveLength(10);

    for (const org of ['A', 'B'] as const) {
      const roles = CORE_PRINCIPALS.filter((p) => p.org === org).map((p) => p.role);
      expect(new Set(roles).size, `organization ${org} must cover five distinct roles`).toBe(5);
    }

    // The secondary tenants exist so "a tenant cannot read another tenant's row" is
    // asserted from a real second session rather than inferred.
    expect(PRINCIPALS.filter((p) => !p.core)).toHaveLength(2);
  });

  it('gives every principal a distinct identity and deterministic ids', async () => {
    const { PRINCIPALS, fixtureId } = await loadJwtFactory();

    const emails = PRINCIPALS.map((p) => p.email);
    expect(new Set(emails).size, 'duplicate email: two principals would share a session').toBe(
      emails.length,
    );

    const profileIds = PRINCIPALS.map((p) => p.profileId);
    expect(new Set(profileIds).size).toBe(profileIds.length);

    const memberIds = PRINCIPALS.map((p) => p.memberId);
    expect(new Set(memberIds).size).toBe(memberIds.length);

    // Deterministic ids are what make re-seeding an upsert rather than a duplicate.
    expect(fixtureId('A:property:1')).toBe(fixtureId('A:property:1'));
    expect(fixtureId('A:property:1')).not.toBe(fixtureId('B:property:1'));
    expect(fixtureId('A:property:1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('separates the two organizations by slug and by id', async () => {
    const { ORGANIZATIONS, fixtureId } = await loadJwtFactory();
    expect(ORGANIZATIONS.A.slug).not.toBe(ORGANIZATIONS.B.slug);
    expect(fixtureId('A:organization')).not.toBe(fixtureId('B:organization'));
  });

  it('refuses a non-local stack unless that is made explicit', async () => {
    const { resolveStackCredentials } = await loadJwtFactory();
    const saved = { ...process.env };
    try {
      process.env.SUPABASE_URL = 'https://some-project.supabase.co';
      process.env.SUPABASE_ANON_KEY = 'anon';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
      delete process.env.PS_ALLOW_REMOTE_STACK;
      expect(() => resolveStackCredentials({ allowStatusProbe: false })).toThrow(/non-local/i);
    } finally {
      process.env = saved;
    }
  });
});

describe('scratch ticket paths', () => {
  it('walks only legal edges to each reachable status', () => {
    expect(pathTo('open')).toEqual([]);
    expect(pathTo('assigned')).toEqual(['assigned']);
    expect(pathTo('in_progress')).toEqual(['assigned', 'in_progress']);
    expect(pathTo('awaiting_approval')).toEqual(['assigned', 'in_progress', 'awaiting_approval']);
    expect(pathTo('completed')).toEqual([
      'assigned',
      'in_progress',
      'awaiting_approval',
      'completed',
    ]);
    expect(pathTo('cancelled')).toEqual(['cancelled']);
  });

  it('refuses to invent a path to an unknown status', () => {
    expect(() => pathTo('reopened')).toThrow(/no legal path/i);
  });
});
