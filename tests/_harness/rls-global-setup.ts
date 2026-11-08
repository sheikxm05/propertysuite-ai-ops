/**
 * Global setup and teardown for the RLS suite. Lane w0-l6.
 *
 * setup()    Resolves the local stack, proves it is actually reachable, and clears the
 *            coverage parts from the previous run. It THROWS when the stack is absent.
 *            It deliberately does not skip: a hard gate that reports success when it
 *            could not run is worse than no gate, because Wave 1 is cleared to start on
 *            the strength of it.
 *
 * teardown() Reconciles the §4 matrix, what the suite exercised, and the policies that
 *            actually exist in the migrations; writes the report; and fails the run if
 *            any policy in the matrix was never exercised by a passing assertion. That
 *            is this lane's exit gate, enforced rather than asserted in prose.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadJwtFactory } from './jwt-factory';
import { NO_IN_ORG_NEGATIVE, matrixCells, type MatrixCell } from './policy-matrix';
import {
  COVERAGE_DIR,
  REPORT_PATH,
  STORAGE_POLICIES,
  mergeCoverageParts,
  resetCoverageDirectory,
  type CoverageRecord,
} from './policy-coverage';
import { parsePolicies } from './tables';

const banner = (text: string) => `\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`;

export async function setup(): Promise<void> {
  const factory = await loadJwtFactory();

  let creds;
  try {
    creds = factory.resolveStackCredentials();
  } catch (error) {
    throw new Error(
      `${banner('RLS ISOLATION SUITE CANNOT RUN')}\n` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        'Nothing below this point is skipped quietly: the suite fails, because an\n' +
        'unproven isolation claim must never read as a passing gate.',
    );
  }

  // A reachable REST endpoint is the cheapest proof that Postgres is actually up.
  const probe = await fetch(`${creds.url}/rest/v1/`, {
    headers: { apikey: creds.anonKey },
  }).catch((error: unknown) => error as Error);

  if (probe instanceof Error) {
    throw new Error(
      `${banner('RLS ISOLATION SUITE CANNOT RUN')}\n` +
        `Resolved ${creds.url} but could not reach it: ${probe.message}\n\n` +
        'Start the stack:\n' +
        '  node scripts/supabase-local.mjs doctor   # tells you exactly what is missing\n' +
        '  npm run db:start\n',
    );
  }

  resetCoverageDirectory();
  mkdirSync(COVERAGE_DIR, { recursive: true });
}

export async function teardown(): Promise<void> {
  const records = mergeCoverageParts();
  const cells = matrixCells();
  const sqlPolicies = parsePolicies();

  const report = buildReport(cells, records, sqlPolicies);

  mkdirSync(COVERAGE_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, report.markdown, 'utf8');
  console.log(report.console);

  if (report.gaps.length > 0) {
    throw new Error(
      `${banner('POLICY COVERAGE GATE FAILED')}\n` +
        `${report.gaps.length} matrix cell(s) were not exercised by a passing assertion.\n` +
        `Full report: ${resolve(REPORT_PATH)}\n` +
        report.gaps
          .slice(0, 25)
          .map((g) => `  - ${g}`)
          .join('\n') +
        (report.gaps.length > 25 ? `\n  ... and ${report.gaps.length - 25} more` : ''),
    );
  }
}

interface ReportResult {
  markdown: string;
  console: string;
  gaps: string[];
}

function buildReport(
  cells: MatrixCell[],
  records: (CoverageRecord & { count: number })[],
  sqlPolicies: { name: string; table: string; command: string; file: string }[],
): ReportResult {
  const seen = new Set(
    records.map((r) => `${r.dimension}|${r.table}|${r.role}|${r.operation}|${r.outcome}`),
  );
  const has = (dimension: string, c: MatrixCell, outcome: string) =>
    seen.has(`${dimension}|${c.table}|${c.role}|${c.operation}|${outcome}`);

  const exercisedPolicies = new Set<string>();
  for (const r of records) for (const p of r.policies) exercisedPolicies.add(p);

  const gaps: string[] = [];
  const rows: string[] = [];

  for (const c of cells) {
    const crossOrg = has('cross_org', c, 'deny');
    const inOrgExpected =
      c.expectation === 'allow' ? has('in_org', c, 'allow') : has('in_org', c, 'deny');
    // A 'scoped' grant is only proven when BOTH halves are shown: the in-scope row is
    // reachable and an out-of-scope row in the same organization is not.
    const needsBoundary =
      c.expectation === 'allow' && c.scope === 'scoped' && !NO_IN_ORG_NEGATIVE.has(label(c));
    const boundary = !needsBoundary || has('in_org', c, 'deny');

    if (!crossOrg) gaps.push(`cross-organization denial not asserted: ${label(c)}`);
    if (!inOrgExpected) {
      gaps.push(
        `in-organization ${c.expectation} not asserted: ${label(c)}` +
          (c.note ? ` — ${c.note}` : ''),
      );
    }
    if (!boundary) {
      gaps.push(
        `scope boundary not asserted (in-scope allowed but out-of-scope never denied): ${label(c)}`,
      );
    }

    rows.push(
      `| \`${c.table}\` | ${c.role} | ${c.operation} | ${c.expectation} | ${c.scope} | ` +
        `${mark(crossOrg)} | ${mark(inOrgExpected)} | ${needsBoundary ? mark(boundary) : 'n/a'} | ` +
        `${(c.policies ?? []).map((p) => `\`${p}\``).join(', ') || '—'} |`,
    );
  }

  const declaredPolicies = new Set(cells.flatMap((c) => c.policies ?? []));
  const sqlNames = new Set(sqlPolicies.map((p) => p.name));

  const unaccounted = [...sqlNames].filter(
    (name) =>
      !exercisedPolicies.has(name) && !(STORAGE_POLICIES as readonly string[]).includes(name),
  );
  const notImplemented = [...declaredPolicies].filter((name) => !sqlNames.has(name));
  const storageUnexercised = (STORAGE_POLICIES as readonly string[]).filter(
    (name) => !exercisedPolicies.has(name),
  );

  for (const name of unaccounted) {
    gaps.push(`SQL policy exists but no passing assertion exercises it: ${name}`);
  }
  for (const name of storageUnexercised) {
    gaps.push(`storage policy not exercised: ${name}`);
  }
  // A matrix cell with no implementing policy is a migration defect, reported loudly
  // but not as a coverage gap: this lane does not own the migration.
  const markdown = [
    '# RLS policy coverage',
    '',
    `Generated by \`tests/_harness/rls-global-setup.ts\` on ${new Date().toISOString()}.`,
    '',
    'Specification: `docs/implementation-plan.md` §4 plus the §5.8 amendments.',
    'A cell is covered only when a PASSING assertion exercised it. Deleting a test',
    'reopens its gap rather than quietly shrinking the suite.',
    '',
    '## Summary',
    '',
    `- matrix cells: ${cells.length}`,
    `- assertions recorded: ${records.reduce((n, r) => n + r.count, 0)}`,
    `- coverage gaps: ${gaps.length}`,
    `- policies in migrations: ${sqlPolicies.length}`,
    `- policies exercised: ${[...sqlNames].filter((n) => exercisedPolicies.has(n)).length}`,
    '',
    '## Matrix cells',
    '',
    '| table | role | operation | expected | scope | cross-org denial | in-org expectation | scope boundary | policies |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## Policies in the migrations with no passing assertion',
    '',
    unaccounted.length === 0
      ? 'None. Every policy in `supabase/migrations` is exercised.'
      : unaccounted.map((n) => `- \`${n}\``).join('\n'),
    '',
    '## Matrix cells no migration policy implements',
    '',
    notImplemented.length === 0
      ? 'None.'
      : notImplemented
          .map((n) => `- \`${n}\` — declared by the §4 matrix, absent from the SQL`)
          .join('\n'),
    '',
    '## Storage policies',
    '',
    (STORAGE_POLICIES as readonly string[])
      .map((n) => `- \`${n}\` — ${exercisedPolicies.has(n) ? 'exercised' : 'NOT EXERCISED'}`)
      .join('\n'),
    '',
  ].join('\n');

  const consoleLines = [
    banner('RLS POLICY COVERAGE'),
    `matrix cells        : ${cells.length}`,
    `assertions recorded : ${records.reduce((n, r) => n + r.count, 0)}`,
    `policies in SQL     : ${sqlPolicies.length}`,
    `policies exercised  : ${[...sqlNames].filter((n) => exercisedPolicies.has(n)).length}`,
    `coverage gaps       : ${gaps.length}`,
    notImplemented.length > 0
      ? `\nMatrix cells with no implementing SQL policy (migration defect, not a test gap):\n` +
        notImplemented.map((n) => `  - ${n}`).join('\n')
      : '',
    `\nFull report: ${resolve(REPORT_PATH)}`,
  ].filter(Boolean);

  return { markdown, console: consoleLines.join('\n'), gaps };
}

const label = (c: MatrixCell) => `${c.table}.${c.role}.${c.operation}`;
const mark = (ok: boolean) => (ok ? 'yes' : '**NO**');
