/**
 * The tenant-scoped table registry, and the guard that keeps it honest. Lane w0-l6.
 *
 * The brief for this lane is explicit: enumerate the tables from the migration, do not
 * hand-pick a few. A hand-maintained list is exactly how a table added in sprint 6 ends
 * up with no cross-organization test. So the registry below is accompanied by parsers
 * over supabase/migrations/*.sql, and harness.test.ts asserts:
 *
 *   1. every table declaring an `organization_id` column is in the registry;
 *   2. every table any migration enables RLS on is in the registry;
 *   3. every table in the registry has RLS enabled by some migration;
 *   4. every table EXCLUDED from the registry has earned it — a written reason in
 *      NON_TENANT_RLS_TABLES, plus RLS enabled, zero policies and no client privilege,
 *      all three re-derived from the SQL rather than taken on trust.
 *
 * (3) fails until 0002 lands, because 0001 leaves `organizations` and `profiles` without
 * RLS — findings 1 and 2 in docs/implementation-plan.md §3. That failure is the point.
 * (4) exists because migration 0004 added the first table that genuinely belongs outside
 * the tenant-scoped set, and "it is infrastructure" must be provable, not asserted.
 *
 * Parsing SQL with regular expressions is normally a bad idea. Here the input is a
 * handful of files in this repository written in one style, the parser is only ever used
 * to make a test list complete, and the alternative is a hand-written list that silently
 * rots.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'supabase', 'migrations');

/**
 * Every table the isolation suite must prove is organization-scoped.
 *
 * The first thirteen are the tables 0001 enables RLS on. `organizations` and `profiles`
 * are the two platform-wide leaks 0002 closes: neither carries an `organization_id`
 * column, but both are tenant-scoped in effect — an organization row is the tenant, and
 * a profile row is a person's name, email and phone.
 */
export const TENANT_SCOPED_TABLES = [
  'organizations',
  'profiles',
  'organization_members',
  'properties',
  'property_units',
  'tenants',
  'tenancies',
  'service_providers',
  'maintenance_tickets',
  'maintenance_activities',
  'documents',
  'ai_conversations',
  'ai_messages',
  'notifications',
  'audit_logs',
  // Amendment A4 (parallel-execution-plan.md §5.8): introduced by 0003 to hold a
  // pending invitation, because organization_members.profile_id is NOT NULL.
  'organization_invitations',
  // 0004 (lane w3-l1), the agentic migration. All four carry organization_id and all
  // four have RLS enabled, so all four are inside the isolation claim. See
  // NON_TENANT_RLS_TABLES for the fifth table 0004 adds, which is not.
  //
  //   document_chunks   the retrieval index over documents.extracted_text. One SELECT
  //                     policy, written as a bare EXISTS against public.documents so it
  //                     inherits 0002's four visibility rules instead of restating them.
  //                     No client write path at all: a client that could write chunks
  //                     could poison its own organization's retrieval.
  //   inbound_messages  WhatsApp / simulator messages. organization_id is NULLABLE by
  //                     design — a sender we cannot map to exactly one tenant stays
  //                     unattributed rather than being guessed into an organization —
  //                     and the staff SELECT policy requires it to be non-null, so an
  //                     unattributed row is visible to NO organization.
  //   agent_runs        one row per agent invocation. Staff select/insert/update.
  //   agent_proposals   a consequential action the model wants to take. Staff
  //                     select/insert only: there is no UPDATE policy AND no UPDATE
  //                     privilege, which is what makes "the model proposes, a human
  //                     commits" structural (CLAUDE.md rule 7). harness.test.ts asserts
  //                     that absence directly.
  'document_chunks',
  'inbound_messages',
  'agent_runs',
  'agent_proposals',
  // 0006, the outbound half of the WhatsApp loop. The ledger of what we SENT a tenant.
  //
  //   outbound_messages  one row per message the organization sent out. RLS enabled
  //                      with exactly ONE policy: staff of the owning organization may
  //                      SELECT, via is_org_staff(). There is no client INSERT, UPDATE
  //                      or DELETE policy and no such privilege — sending is a
  //                      service-role / security-definer path, and that absence IS the
  //                      control, asserted statically by 'leaves outbound_messages with
  //                      no client write path at all' in harness.test.ts.
  //
  // Two properties make it different from `inbound_messages`, and both are deliberate:
  //
  //   organization_id is NOT NULL. Inbound may be unattributed, because a message
  //   arrives before anyone knows whose it is; outbound may not, because an
  //   unattributed message is never replied to. A reply whose organization we had to
  //   guess would be the client-supplied-organization_id mistake (CLAUDE.md rule 5)
  //   committed against a real tenant's phone.
  //
  //   The tenant cannot read it. They already received it on WhatsApp; the row is
  //   staff infrastructure — provenance (`drafted_by`), who committed it
  //   (`sent_by_profile_id`) and delivery state. Handing a tenant the ledger would
  //   disclose that a reply was model-drafted and which staff member released it.
  'outbound_messages',
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

/**
 * Tables that carry an `organization_id` column, so a cross-organization filter can be
 * expressed directly. `organizations` and `profiles` are keyed differently and are
 * excluded here — their cross-organization assertions go by row id.
 */
export const TABLES_WITH_ORGANIZATION_ID = TENANT_SCOPED_TABLES.filter(
  (t) => t !== 'organizations' && t !== 'profiles',
) as readonly Exclude<TenantScopedTable, 'organizations' | 'profiles'>[];

/**
 * Tables that RLS protects but that carry NO tenant scope, each with the reason it sits
 * outside `TENANT_SCOPED_TABLES`.
 *
 * This is the only way a table may be excluded from the registry. harness.test.ts
 * refuses to take the reason on trust: for every entry here it re-reads the migrations
 * and proves the exclusion is earned — RLS enabled, ZERO policies, and no privilege
 * left with `anon` or `authenticated`. An exclusion that stopped being true would
 * therefore fail here rather than quietly removing a table from the suite, which is the
 * whole failure mode this file exists to prevent.
 */
export const NON_TENANT_RLS_TABLES: Readonly<Record<string, string>> = {
  jobs:
    '0003 background job queue. Infrastructure rather than tenant data: no ' +
    'organization_id to scope by, RLS enabled with no policies, service role only.',
  webhook_events:
    '0004 raw inbound webhook deliveries. Deliberately NOT organization-scoped: a ' +
    'webhook arrives before anyone knows whose it is, and inventing an organization at ' +
    'that moment would be the client-supplied-organization_id mistake (CLAUDE.md rule ' +
    '5) committed by the server. Attribution happens in inbound_messages instead. RLS ' +
    'is enabled with zero policies and every privilege is revoked from anon and ' +
    'authenticated, so only the service role reaches it. Payloads are untrusted ' +
    'third-party input and may contain personal data.',
  platform_operator_events:
    "0005 the operator plane's own append-only audit trail. It DOES carry an " +
    'organization_id — populated only when an operator moves a message into an ' +
    'organization — but it is not tenant data: no organization admin may read it, and ' +
    'that is the point of it being separate from public.audit_logs. RLS is enabled ' +
    'with zero policies, every privilege is revoked from anon and authenticated, and ' +
    'update/delete/truncate are refused by trigger even for the service role. With no ' +
    'policy and no privilege there is no client path to a row at all, so there is ' +
    'nothing for the cross-organization suite to prove about it.',
};

/**
 * The PLATFORM OPERATOR plane (0005), which is a third category again: row level
 * security is on, a policy DOES exist, and yet the table is not tenant-scoped, because
 * an operator sits outside every organization by construction.
 *
 * Such a table cannot go in NON_TENANT_RLS_TABLES — it has a policy, so that registry's
 * proof (nobody can reach a row) is false of it — and it must not go in
 * TENANT_SCOPED_TABLES either: it has no organization_id to filter on, so the generated
 * cross-organization cases would be meaningless and the `organization_id` sweep would
 * fail with "column does not exist", which is not an access-control result.
 *
 * What harness.test.ts proves instead, from the SQL, for every entry here:
 *
 *   1. RLS is enabled;
 *   2. the table declares NO organization_id column — 0005's disjointness argument
 *      rests on that, and 0005 itself raises if the column ever appears;
 *   3. every policy on it is a SELECT, and there is exactly one, named `_select_self`
 *      — the roster of who holds cross-organization reach must not be enumerable;
 *   4. no client role holds a write privilege on it.
 */
export const PLATFORM_PLANE_TABLES: Readonly<Record<string, string>> = {
  platform_operators:
    '0005 the operator grant list. One self-scoped SELECT policy — a caller may learn ' +
    'whether THEY are an operator, because the application has to decide whether to ' +
    'render the triage surface, and a fact about yourself discloses nothing. The roster ' +
    'as a whole is not readable by any client. No organization_id by design: a profile ' +
    'that is a member of any organization cannot hold operator status, so the operator ' +
    'plane and the tenant plane are disjoint and a member role reads zero rows here.',
};

/**
 * `jobs` (0003) is service-role only and carries no organization column.
 *
 * NOT widened to include `webhook_events`, even though that table is service-role only
 * too. tests/rls/negative-writes.test.ts probes every entry here with a JOB-SHAPED
 * insert payload (`{ id, type, payload }`), and `webhook_events` has no `type` column:
 * the attempt would be rejected with 42703 "column does not exist", which LOOKS like a
 * denial and proves nothing about authorization. A probe that proves nothing is worse
 * than an honest gap, and that file belongs to another lane. `webhook_events` is
 * therefore accounted for in NON_TENANT_RLS_TABLES, where the static gate in
 * harness.test.ts proves its zero policies and revoked grants from the SQL itself.
 */
export const SERVICE_ROLE_ONLY_TABLES = ['jobs'] as const;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function readMigrations(): { file: string; sql: string }[] {
  return migrationFiles().map((file) => ({
    file,
    sql: readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8'),
  }));
}

const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** Tables declaring an `organization_id` column, read out of the `create table` blocks. */
export function parseTablesWithOrganizationId(): string[] {
  const found = new Set<string>();
  for (const { sql } of readMigrations()) {
    const text = stripComments(sql);
    const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)\s*\(/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const name = match[1];
      // Walk forward to the matching closing parenthesis of the column list.
      let depth = 0;
      let i = match.index + match[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = text.slice(match.index, i);
      if (/\borganization_id\b/.test(body) && name) found.add(name);
    }
  }
  return [...found].sort();
}

/** Tables any migration enables row level security on. */
export function parseRlsEnabledTables(): string[] {
  const found = new Set<string>();
  for (const { sql } of readMigrations()) {
    const re =
      /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?public\.(\w+)\s+enable\s+row\s+level\s+security/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripComments(sql))) !== null) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

export interface ParsedPolicy {
  name: string;
  table: string;
  command: string;
  file: string;
}

/**
 * The EFFECTIVE policy set after every migration has been applied in order.
 *
 * It has to be effective rather than cumulative: 0001 ships eight `for all` baseline
 * policies, and 0002's whole job is to drop them by name and replace them with
 * per-operation ones (finding 5). A parser that only counted `create policy` would
 * report the database as still carrying policies that no longer exist, and the
 * "no `for all` policy" assertion would fail against a database that is in fact
 * correct.
 */
export function parsePolicies(): ParsedPolicy[] {
  // Policy names appear both quoted ("organization admins can view ...") and bare
  // (notifications_select_own), and the table may be schema-qualified or not.
  const re =
    /(create|drop)\s+policy\s+(?:if\s+exists\s+)?(?:"([^"]+)"|(\w+))\s+on\s+(?:public\.|storage\.)?(\w+)(?:\s+as\s+\w+)?(?:\s+for\s+(\w+))?/gi;

  const effective = new Map<string, ParsedPolicy>();
  for (const { file, sql } of readMigrations()) {
    const text = stripComments(sql);
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const action = (match[1] ?? '').toLowerCase();
      const name = match[2] ?? match[3] ?? '';
      const table = match[4] ?? '';
      const key = `${table}:${name}`;
      if (action === 'drop') {
        effective.delete(key);
      } else {
        effective.set(key, { name, table, command: (match[5] ?? 'all').toLowerCase(), file });
      }
    }
  }
  return [...effective.values()];
}

/** The three roles a client session can ever be. A privilege held by one is reachable. */
export const CLIENT_ROLES = ['authenticated', 'anon', 'public'] as const;

export interface TablePrivilege {
  privileges: string[];
  table: string;
  /** The roles named after FROM / TO, lower-cased. */
  grantees: string[];
}

/**
 * Splits a privilege list, dropping any parenthesised column list.
 *
 * 0004 introduced the column-level form — `grant select (id, organization_id, ...) on
 * table public.tenants to authenticated` — and a naive comma split turns that into one
 * "privilege" per COLUMN. Those fake privileges would then satisfy a gate asking
 * whether UPDATE is held, which is the wrong answer for the right-looking reason.
 */
const splitPrivileges = (raw: string): string[] =>
  raw
    .replace(/\([^)]*\)/g, ' ')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);

const splitGrantees = (raw: string): string[] =>
  raw
    .split(',')
    .map((g) => g.trim().toLowerCase().replace(/"/g, ''))
    .filter(Boolean);

/** Statements revoking a privilege from a client role, e.g. the activity-table revoke. */
export function parseRevokes(): TablePrivilege[] {
  const out: TablePrivilege[] = [];
  for (const { sql } of readMigrations()) {
    const re = /revoke\s+([\w\s,()]+?)\s+on\s+(?:table\s+)?public\.(\w+)\s+from\s+([\w\s,"]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripComments(sql))) !== null) {
      if (!/authenticated|anon|public/.test(match[3] ?? '')) continue;
      out.push({
        privileges: splitPrivileges(match[1] ?? ''),
        table: match[2] ?? '',
        grantees: splitGrantees(match[3] ?? ''),
      });
    }
  }
  return out;
}

/**
 * Statements granting a table privilege to a client role.
 *
 * The counterpart to `parseRevokes`, and the half that matters for an exclusion gate: a
 * revoke proves nothing if a later statement grants the privilege straight back. Only
 * TABLE grants are parsed — `grant execute on function public.f(...)` does not match,
 * because the schema qualifier there is preceded by `function` rather than by nothing
 * or by `table`.
 */
export function parseGrants(): TablePrivilege[] {
  const out: TablePrivilege[] = [];
  for (const { sql } of readMigrations()) {
    const re = /grant\s+([\w\s,()]+?)\s+on\s+(?:table\s+)?public\.(\w+)\s+to\s+([\w\s,"]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripComments(sql))) !== null) {
      out.push({
        privileges: splitPrivileges(match[1] ?? ''),
        table: match[2] ?? '',
        grantees: splitGrantees(match[3] ?? ''),
      });
    }
  }
  return out;
}

/** Every table privilege a client role is granted on `table`, across all migrations. */
export function clientGrantsOn(table: string): string[] {
  return parseGrants()
    .filter(
      (g) =>
        g.table === table &&
        g.grantees.some((r) => (CLIENT_ROLES as readonly string[]).includes(r)),
    )
    .flatMap((g) => g.privileges);
}

/**
 * The text of the `create table public.<name> (...)` column list, comments stripped.
 *
 * Returns the LAST definition found, so a table created in one migration and recreated
 * in a later one is read as the later one. `undefined` when no migration creates it —
 * which is itself a useful answer: a gate written against a table whose migration has
 * not landed yet should say so rather than silently assert nothing.
 */
export function createTableBody(table: string): string | undefined {
  let body: string | undefined;
  for (const { sql } of readMigrations()) {
    const text = stripComments(sql);
    const re = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\s*\\(`, 'gi');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      let depth = 0;
      let i = match.index + match[0].length - 1;
      for (; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      body = text.slice(match.index + match[0].length, i);
    }
  }
  return body;
}

/**
 * True when `column` is declared NOT NULL in `table`'s column list.
 *
 * Deliberately line-scoped rather than a search over the whole body: `not null` can
 * appear in a neighbouring column, in a check constraint, or in a default expression,
 * and a whole-body search would answer "yes" for a column that is in fact nullable.
 * That is the wrong answer for the right-looking reason, which is how a gate becomes
 * decoration.
 */
export function isColumnNotNull(table: string, column: string): boolean {
  const body = createTableBody(table);
  if (body === undefined) return false;
  return body
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => new RegExp(`^${column}\\b`).test(line))
    .some((line) => /\bnot\s+null\b/.test(line));
}

export interface ParsedIndex {
  name: string;
  table: string;
  unique: boolean;
  /** The parenthesised key list, lower-cased. */
  columns: string;
  /** The `where` clause of a partial index, lower-cased, or '' when total. */
  predicate: string;
  file: string;
}

/**
 * Indexes any migration creates, including the partial-unique form.
 *
 * A partial unique index is an access-control-adjacent control here, not just a
 * performance one: `unique (inbound_message_id) where kind = 'acknowledgement'` is what
 * stops one inbound message producing a stream of automated replies to a tenant's
 * phone. It is asserted from the SQL because nothing in a live RLS run would notice it
 * going missing.
 */
export function parseIndexes(): ParsedIndex[] {
  const out: ParsedIndex[] = [];
  for (const { file, sql } of readMigrations()) {
    const text = stripComments(sql);
    const re =
      /create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(\w+)[^(]*\(([^;]*?)\)\s*(where\s+[^;]*?)?;/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      out.push({
        name: match[2] ?? '',
        table: match[3] ?? '',
        unique: Boolean(match[1]),
        columns: (match[4] ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
        predicate: (match[5] ?? '').replace(/\s+/g, ' ').trim().toLowerCase(),
        file,
      });
    }
  }
  return out;
}

/**
 * The raw text of every `create policy` statement on `table`, so a gate can assert what
 * a policy's predicate actually says rather than only that a policy exists.
 *
 * `parsePolicies` answers "which policies exist, on what, for which command"; it does
 * not read the `using` / `with check` clause. For `outbound_messages` the clause is the
 * whole claim — "staff of the OWNING organization" is `is_org_staff(organization_id)`,
 * and a policy named `_select_staff` whose predicate said `true` would satisfy every
 * name-level gate in this file while leaking every organization's outbound ledger to
 * every other.
 */
export function policyStatementsFor(table: string): string[] {
  const out: string[] = [];
  for (const { sql } of readMigrations()) {
    const text = stripComments(sql);
    const re = new RegExp(
      `create\\s+policy\\s+(?:if\\s+not\\s+exists\\s+)?(?:"[^"]+"|\\w+)\\s+on\\s+(?:public\\.)?${table}\\b[^;]*;`,
      'gi',
    );
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) out.push(match[0]);
  }
  return out;
}

/** True when some migration revokes `privilege` (or ALL) on `table` from `grantee`. */
export function isRevokedFrom(table: string, privilege: string, grantee: string): boolean {
  return parseRevokes().some(
    (r) =>
      r.table === table &&
      r.grantees.includes(grantee) &&
      (r.privileges.includes(privilege) || r.privileges.includes('all')),
  );
}
