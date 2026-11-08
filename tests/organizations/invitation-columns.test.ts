/**
 * The `organization_invitations` column contract. Lane w1-l1.
 *
 * `0003` grants SELECT on that table **column by column**, deliberately omitting
 * `token_hash`, so `select *` fails with a permission error rather than returning the
 * hash. That makes "no client ever reads the token column" structural instead of
 * conventional — and it means a single `select('*')` anywhere in this lane is a
 * production outage, not a style problem.
 *
 * Two assertions, and the second is the one that will still be true in a year:
 *
 *  1. No star select against the table exists anywhere in this lane's source. Asserted
 *     by reading the files, because this is a property of the *text* and no amount of
 *     runtime testing can cover a line that was not executed.
 *  2. `INVITATION_COLUMNS` equals the grant in the migration, parsed out of the
 *     migration itself. A hand-maintained list would drift the first time the grant
 *     changed; this fails the moment the two disagree, in either direction — a column
 *     added to the grant but not to the code, or a column the code reads that the grant
 *     no longer covers.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { INVITATION_COLUMNS, INVITATION_SELECT } from '@/features/organizations/queries';

const ROOT = resolve(__dirname, '..', '..');

/** Every directory this lane owns that can contain a database query. */
const LANE_SOURCE_ROOTS = [
  'app/(auth)',
  'app/(dashboard)/dashboard',
  'app/(dashboard)/organization',
  'app/(dashboard)/members',
  'app/api/v1/organizations',
  'app/api/v1/members',
  'features/organizations',
  'tests/organizations',
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function laneFiles(): { path: string; source: string }[] {
  const files: { path: string; source: string }[] = [];

  const walk = (directory: string) => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return; // A root this lane has not created is not a failure.
    }
    for (const entry of entries) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        files.push({
          path: full.slice(ROOT.length + 1).replace(/\\/g, '/'),
          source: readFileSync(full, 'utf8'),
        });
      }
    }
  };

  for (const root of LANE_SOURCE_ROOTS) walk(join(ROOT, root));
  return files;
}

/**
 * One line with its prose removed.
 *
 * Three things are stripped, and the third is why this helper exists at all: these files
 * discuss `select *` and `.select()` at length *because* they are forbidden, and a
 * sentence saying so must not be read as a violation. Stripping line comments, JSDoc
 * continuation lines and inline backtick spans leaves the executable text.
 */
function codeOf(line: string): string {
  if (/^\s*\*/.test(line)) return '';
  return line.replace(/\/\/.*$/, '').replace(/`[^`]*`/g, '``');
}

describe('no star select anywhere in lane w1-l1', () => {
  it('finds the lane source it is supposed to be checking', () => {
    const files = laneFiles();
    // A guard against the check silently passing because the walk found nothing.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.path)).toContain('features/organizations/queries.ts');
  });

  it('issues no `select("*")` against any table', () => {
    const offenders: string[] = [];

    // Matches .select('*'), .select("*"), .select(`*`) and .select('*', { ... }) alike,
    // with any whitespace. A star select is wrong for every table in this lane — the
    // invitations grant makes it fail outright, and elsewhere it transfers columns the
    // §4 matrix may withhold.
    const starSelect = /\.select\(\s*(['"`])\s*\*\s*\1/;

    for (const file of laneFiles()) {
      file.source.split(/\r?\n/).forEach((line, index) => {
        if (starSelect.test(codeOf(line))) offenders.push(`${file.path}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('issues no argument-less select, which defaults to every column', () => {
    const offenders: string[] = [];
    // An argument-less select is a star select by another name, and against the
    // invitations table it fails outright because the grant is column-level.
    const bareSelect = /\.select\(\s*\)/;

    for (const file of laneFiles()) {
      file.source.split(/\r?\n/).forEach((line, index) => {
        if (bareSelect.test(codeOf(line))) offenders.push(`${file.path}:${index + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  it('names the invitations table only where the projection is the granted column list', () => {
    const referencing = laneFiles()
      // The lane's own tests name the table in order to assert about it; only shipping
      // code is being constrained here.
      .filter((file) => !file.path.startsWith('tests/'))
      .filter((file) => file.source.includes(`from('organization_invitations')`))
      .map((file) => file.path);

    // Exactly one module may reach the table, so there is one projection to audit
    // rather than one per call site.
    expect(referencing).toEqual(['features/organizations/queries.ts']);
  });
});

describe('INVITATION_COLUMNS matches the grant in migration 0003', () => {
  /**
   * Pulls the granted column list out of the migration.
   *
   * Parsed rather than retyped: the grant is the authority, and this test exists to
   * detect disagreement, which it cannot do if it holds its own copy of the answer.
   */
  function grantedColumns(): string[] {
    const sql = readFileSync(
      join(ROOT, 'supabase', 'migrations', '0003_domain_integrity.sql'),
      'utf8',
    );

    const match =
      /grant\s+select\s*\(([^)]*)\)\s*on\s+table\s+public\.organization_invitations\s+to\s+authenticated/i.exec(
        sql,
      );

    expect(match, 'the column-level grant was not found in 0003').toBeTruthy();

    return (match?.[1] ?? '')
      .split(',')
      .map((column) => column.trim())
      .filter((column) => column.length > 0);
  }

  it('grants exactly the columns the lane reads, in the same order', () => {
    expect([...INVITATION_COLUMNS]).toEqual(grantedColumns());
  });

  it('does not include token_hash', () => {
    expect(grantedColumns()).not.toContain('token_hash');
    expect([...INVITATION_COLUMNS]).not.toContain('token_hash');
    expect(INVITATION_SELECT).not.toContain('token_hash');
  });

  it('renders a PostgREST projection with no star in it', () => {
    expect(INVITATION_SELECT).not.toContain('*');
    expect(INVITATION_SELECT.split(',').map((c) => c.trim())).toEqual([...INVITATION_COLUMNS]);
  });
});
