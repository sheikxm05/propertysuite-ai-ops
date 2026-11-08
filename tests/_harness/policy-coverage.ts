/**
 * Policy coverage accounting. Lane w0-l6, task 10.
 *
 * The exit gate for this lane is not "the suite is green". It is "every policy in the
 * §4 matrix is exercised by at least one PASSING assertion". Those are different
 * claims, and the gap between them is where a security suite rots: delete a test and
 * the suite is still green.
 *
 * So every assertion helper registers what it just proved, and the global teardown
 * reconciles three sets against each other:
 *
 *   1. matrix cells  — (table, role, operation) from docs/implementation-plan.md §4
 *   2. assertions    — what the suite actually exercised and passed
 *   3. SQL policies  — every `create policy` parsed out of supabase/migrations
 *
 * Three different failures become visible instead of one vague pass:
 *   - a matrix cell no assertion covers         -> the suite has a hole
 *   - an SQL policy no exercised cell claims    -> something in the database is untested
 *   - a matrix cell no SQL policy implements    -> the migration does not meet the spec
 *
 * Records are written to per-process JSON parts, because Vitest may run files in
 * separate workers. The teardown merges them.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const COVERAGE_DIR = resolve(__dirname, '..', '..', 'test-results', 'policy-coverage');

export const REPORT_PATH = resolve(COVERAGE_DIR, 'policy-coverage.md');

export type Dimension = 'in_org' | 'cross_org' | 'storage' | 'state_machine' | 'integrity';
export type Outcome = 'allow' | 'deny';

export interface CoverageRecord {
  dimension: Dimension;
  table?: string;
  role?: string;
  operation?: string;
  outcome: Outcome;
  /** Policy names in the migrations that this assertion exercised. */
  policies: string[];
  /** Free-text label for records that are not (table, role, operation) shaped. */
  label?: string;
}

const records = new Map<string, CoverageRecord & { count: number }>();
let dirty = 0;
let hookInstalled = false;

const keyOf = (r: CoverageRecord) =>
  [r.dimension, r.table ?? '-', r.role ?? '-', r.operation ?? '-', r.outcome, r.label ?? '-'].join(
    '|',
  );

function partPath(): string {
  return resolve(COVERAGE_DIR, `part-${process.pid}.json`);
}

export function flushCoverage(): void {
  if (records.size === 0) return;
  mkdirSync(COVERAGE_DIR, { recursive: true });
  writeFileSync(partPath(), JSON.stringify([...records.values()], null, 0), 'utf8');
  dirty = 0;
}

/**
 * Call this only after an assertion has PASSED. Recording before the expectation would
 * mark a cell covered by a test that fails, which is the exact illusion this file
 * exists to prevent.
 */
export function recordCoverage(record: CoverageRecord): void {
  if (!hookInstalled) {
    process.on('exit', flushCoverage);
    hookInstalled = true;
  }
  const key = keyOf(record);
  const existing = records.get(key);
  if (existing) existing.count += 1;
  else records.set(key, { ...record, count: 1 });
  // Periodic flush so a worker killed mid-run still contributes what it proved.
  if (++dirty >= 25) flushCoverage();
}

export function resetCoverageDirectory(): void {
  mkdirSync(COVERAGE_DIR, { recursive: true });
  for (const file of readdirSync(COVERAGE_DIR)) {
    if (file.startsWith('part-') && file.endsWith('.json')) {
      writeFileSync(resolve(COVERAGE_DIR, file), '[]', 'utf8');
    }
  }
}

export function mergeCoverageParts(): (CoverageRecord & { count: number })[] {
  if (!existsSync(COVERAGE_DIR)) return [];
  const merged = new Map<string, CoverageRecord & { count: number }>();
  for (const file of readdirSync(COVERAGE_DIR)) {
    if (!file.startsWith('part-') || !file.endsWith('.json')) continue;
    let parsed: (CoverageRecord & { count: number })[] = [];
    try {
      parsed = JSON.parse(readFileSync(resolve(COVERAGE_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    for (const r of parsed) {
      const key = keyOf(r);
      const existing = merged.get(key);
      if (existing) existing.count += r.count;
      else merged.set(key, { ...r });
    }
  }
  return [...merged.values()];
}

/** Storage policies live on storage.objects and so have no (table, role) matrix cell. */
export const STORAGE_POLICIES = [
  'documents_objects_select_member',
  'documents_objects_insert_member',
  'documents_objects_update_staff',
] as const;
