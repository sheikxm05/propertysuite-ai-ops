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
 * Records are appended, one JSON object per line, to a per-process file. Append-only
 * because the alternative — accumulate in memory and write on exit — silently lost
 * every record the first time it ran: the global teardown can execute before a pooled
 * worker's exit handler, and a worker that is killed rather than exiting never flushes
 * at all. A coverage ledger that can lose entries reports gaps that are not real, and
 * would eventually be "fixed" by relaxing the gate.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
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

const keyOf = (r: CoverageRecord) =>
  [r.dimension, r.table ?? '-', r.role ?? '-', r.operation ?? '-', r.outcome, r.label ?? '-'].join(
    '|',
  );

/**
 * Part files are named for the RUN, not just the process.
 *
 * The first design keyed them on the pid alone, and a long run came back reporting 3
 * assertions out of 902 — the ledger had been emptied underneath it. Scoping the name
 * to a run id means a concurrent `vitest` invocation, a recycled worker or a stale file
 * from a previous run can no longer be MISCOUNTED into this run's totals.
 * `beginCoverageRun` publishes the id through the environment, which Vitest forwards to
 * workers spawned after global setup.
 *
 * Scoping alone does not stop a concurrent run from DELETING these files, which is a
 * separate problem with a separate fix — see `resetCoverageDirectory`.
 */
export const RUN_ID_ENV = 'PS_RLS_RUN_ID';

const runId = (): string => process.env[RUN_ID_ENV] ?? 'adhoc';

const partPath = () => resolve(COVERAGE_DIR, `part-${runId()}-${process.pid}.jsonl`);

const isPartFile = (file: string) => file.startsWith('part-') && file.endsWith('.jsonl');

/** Called by global setup, before any worker exists. Returns the new run id. */
export function beginCoverageRun(): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  process.env[RUN_ID_ENV] = id;
  resetCoverageDirectory();
  return id;
}

let directoryReady = false;

/**
 * Call this only after an assertion has PASSED. Recording before the expectation would
 * mark a cell covered by a test that fails, which is the exact illusion this file
 * exists to prevent.
 */
export function recordCoverage(record: CoverageRecord): void {
  if (!directoryReady) {
    mkdirSync(COVERAGE_DIR, { recursive: true });
    directoryReady = true;
  }
  appendFileSync(partPath(), `${JSON.stringify(record)}\n`, 'utf8');
}

/** Retained for callers that want an explicit flush point. Appends are synchronous. */
export function flushCoverage(): void {
  /* no-op: every record is already on disk */
}

/**
 * How long a part file from another run is left alone. Anything still being appended to
 * belongs to a run that has not finished; anything older than this is debris.
 */
const STALE_PART_MS = 60 * 60 * 1000;

/**
 * Removes STALE part files from other runs. Never touches this run's own files, and
 * never touches a file another run is still writing to.
 *
 * The first version deleted every part file that did not belong to this run, on the
 * reasoning that run-id scoping already made the records unambiguous. Running two
 * invocations at once showed that reasoning was backwards: scoping stops a concurrent
 * run's records from being *counted*, but the unconditional delete still destroyed
 * them. A `PS_RLS=1 vitest run <one file>` started while the full suite was mid-flight
 * wiped a 600-record ledger, and the suite went on to report coverage gaps for cells it
 * had already proven — the precise failure mode this file's header warns about, which
 * would eventually be "fixed" by relaxing the gate.
 *
 * Age is read from mtime rather than from the run id, because the id carries no clock a
 * second process can trust.
 */
export function resetCoverageDirectory(): void {
  mkdirSync(COVERAGE_DIR, { recursive: true });
  const mine = `part-${runId()}-`;
  const now = Date.now();

  for (const file of readdirSync(COVERAGE_DIR)) {
    const isPart = isPartFile(file) || (file.startsWith('part-') && file.endsWith('.json'));
    if (!isPart || file.startsWith(mine)) continue;

    const path = resolve(COVERAGE_DIR, file);
    let age = Number.POSITIVE_INFINITY;
    try {
      age = now - statSync(path).mtimeMs;
    } catch {
      // Vanished underneath us — another run's teardown got there first.
      continue;
    }
    if (age > STALE_PART_MS) rmSync(path, { force: true });
  }
}

/** Part files belonging to the current run, with their line counts. Diagnostic. */
export function coveragePartSummary(): { file: string; records: number }[] {
  if (!existsSync(COVERAGE_DIR)) return [];
  const mine = `part-${runId()}-`;
  return readdirSync(COVERAGE_DIR)
    .filter((f) => isPartFile(f) && f.startsWith(mine))
    .map((file) => ({
      file,
      records: readFileSync(resolve(COVERAGE_DIR, file), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '').length,
    }));
}

export function mergeCoverageParts(): (CoverageRecord & { count: number })[] {
  if (!existsSync(COVERAGE_DIR)) return [];
  const merged = new Map<string, CoverageRecord & { count: number }>();
  const mine = `part-${runId()}-`;

  for (const file of readdirSync(COVERAGE_DIR)) {
    if (!isPartFile(file) || !file.startsWith(mine)) continue;
    const text = readFileSync(resolve(COVERAGE_DIR, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      let record: CoverageRecord;
      try {
        record = JSON.parse(line) as CoverageRecord;
      } catch {
        // A torn final line from a killed worker. Skipping it can only understate
        // coverage, never overstate it, which is the safe direction for a gate.
        continue;
      }
      const key = keyOf(record);
      const existing = merged.get(key);
      if (existing) existing.count += 1;
      else merged.set(key, { ...record, count: 1 });
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
