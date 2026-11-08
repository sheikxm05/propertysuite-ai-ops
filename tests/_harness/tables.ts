/**
 * The tenant-scoped table registry, and the guard that keeps it honest. Lane w0-l6.
 *
 * The brief for this lane is explicit: enumerate the tables from the migration, do not
 * hand-pick a few. A hand-maintained list is exactly how a table added in sprint 6 ends
 * up with no cross-organization test. So the registry below is accompanied by two
 * parsers over supabase/migrations/*.sql, and harness.test.ts asserts:
 *
 *   1. every table declaring an `organization_id` column is in the registry;
 *   2. every table any migration enables RLS on is in the registry;
 *   3. every table in the registry has RLS enabled by some migration.
 *
 * (3) fails until 0002 lands, because 0001 leaves `organizations` and `profiles` without
 * RLS — findings 1 and 2 in docs/implementation-plan.md §3. That failure is the point.
 *
 * Parsing SQL with regular expressions is normally a bad idea. Here the input is three
 * files in this repository written in one style, the parser is only ever used to make a
 * test list complete, and the alternative is a hand-written list that silently rots.
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

/** `jobs` (0003) is service-role only and carries no organization column. */
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

/** Statements revoking a privilege from `authenticated`, e.g. the activity-table revoke. */
export function parseRevokes(): { privileges: string[]; table: string }[] {
  const out: { privileges: string[]; table: string }[] = [];
  for (const { sql } of readMigrations()) {
    const re = /revoke\s+([\w\s,]+?)\s+on\s+(?:table\s+)?public\.(\w+)\s+from\s+([\w\s,"]+)/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(stripComments(sql))) !== null) {
      if (!/authenticated|anon|public/.test(match[3] ?? '')) continue;
      out.push({
        privileges: (match[1] ?? '')
          .split(',')
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean),
        table: match[2] ?? '',
      });
    }
  }
  return out;
}
