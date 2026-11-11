/**
 * Assertion helpers for the RLS suite. Lane w0-l6.
 *
 * Two things here matter more than the convenience.
 *
 * 1. A denial must be denied for the RIGHT REASON. PostgREST returns an error for a
 *    missing column, a null violation, a foreign key and an RLS refusal alike. A test
 *    that accepts "some error happened" passes against a typo, proves nothing, and
 *    reads as if it proved everything. So `expectInsertDenied` requires the SQLSTATE to
 *    be an authorization refusal (42501, or 'permission denied' from a revoked grant)
 *    and fails loudly on anything else, naming the code it actually got.
 *
 * 2. A filtered-out row is not an error. An UPDATE or DELETE that RLS makes invisible
 *    returns HTTP 200 with zero rows, not a 403. Asserting only on `error` would make
 *    every write test pass trivially, which is exactly the failure mode this lane
 *    exists to prevent. So the write helpers assert zero affected rows AND confirm,
 *    through a second AUTHENTICATED principal who is entitled to read the row, that the
 *    value did not change.
 *
 * Every helper records coverage only after its expectation holds.
 */

import { expect } from 'vitest';
import type { DbError, Principal, Row } from './driver';
import { recordCoverage, type Dimension } from './policy-coverage';

/** SQLSTATEs that mean "authorization refused", per amendment A2 in §5.8. */
const RLS_DENIAL_CODES = new Set(['42501']);
/** A revoked table or column grant surfaces as a permission error, not an RLS one. */
const PERMISSION_MESSAGE = /permission denied|row-level security|not authorized/i;
/** Raised by the state-machine and immutability triggers. */
export const TRIGGER_CONFLICT_CODE = 'P0001';

export interface CoverageTag {
  dimension: Dimension;
  table?: string;
  role?: string;
  operation?: string;
  policies?: string[];
  label?: string;
}

function pass(tag: CoverageTag, outcome: 'allow' | 'deny'): void {
  recordCoverage({
    dimension: tag.dimension,
    outcome,
    policies: tag.policies ?? [],
    ...(tag.table ? { table: tag.table } : {}),
    ...(tag.role ? { role: tag.role } : {}),
    ...(tag.operation ? { operation: tag.operation } : {}),
    ...(tag.label ? { label: tag.label } : {}),
  });
}

const describeError = (error: DbError | null) =>
  error ? `${error.code ?? '-'}: ${error.message}` : 'no error';

export function isAuthorizationRefusal(error: DbError | null): boolean {
  if (!error) return false;
  return RLS_DENIAL_CODES.has(error.code ?? '') || PERMISSION_MESSAGE.test(error.message ?? '');
}

/* ------------------------------------------------------------------ select -- */

/** The row must be invisible: zero rows, and not an unexpected error. */
export async function expectSelectDenied(
  client: Principal,
  table: string,
  rowId: string,
  tag: CoverageTag,
  columns = 'id',
): Promise<void> {
  const { data, error } = await client.select(table, { columns, eq: { id: rowId } });

  if (error) {
    // A revoked grant is a legitimate denial. Anything else is a broken test.
    expect(
      isAuthorizationRefusal(error),
      `${table}: expected the row to be invisible or refused, got ${describeError(error)}`,
    ).toBe(true);
  } else {
    expect(data ?? [], `${table}: row ${rowId} leaked to a caller with no policy for it`).toEqual(
      [],
    );
  }
  pass(tag, 'deny');
}

/** The row must be visible. */
export async function expectSelectAllowed(
  client: Principal,
  table: string,
  rowId: string,
  tag: CoverageTag,
  columns = 'id',
): Promise<void> {
  const { data, error } = await client.select(table, { columns, eq: { id: rowId } });
  expect(error, `${table}: expected to read ${rowId}, got ${describeError(error)}`).toBeNull();
  expect(
    (data ?? []).length,
    `${table}: expected to read ${rowId} but the policy hid it — the matrix grants this role access`,
  ).toBe(1);
  pass(tag, 'allow');
}

/** Nothing at all may be visible in this table for this caller. */
export async function expectNothingVisible(
  client: Principal,
  table: string,
  tag: CoverageTag,
  columns = 'id',
): Promise<void> {
  const { data, error } = await client.select(table, { columns, limit: 5 });
  if (error) {
    expect(
      isAuthorizationRefusal(error),
      `${table}: expected an empty result or a refusal, got ${describeError(error)}`,
    ).toBe(true);
  } else {
    expect(data ?? [], `${table}: rows visible to a role the matrix grants nothing`).toEqual([]);
  }
  pass(tag, 'deny');
}

/* ------------------------------------------------------------------ insert -- */

export async function expectInsertDenied(
  client: Principal,
  table: string,
  row: Row,
  tag: CoverageTag,
): Promise<void> {
  const { error } = await client.insert(table, row);

  expect(error, `${table}: INSERT succeeded where the matrix grants no INSERT`).not.toBeNull();
  expect(
    isAuthorizationRefusal(error),
    `${table}: INSERT was rejected, but not as an authorization refusal — got ` +
      `${describeError(error)}. A denial for the wrong reason (bad payload, missing ` +
      'column, FK violation) proves nothing about RLS. Fix the fixture payload.',
  ).toBe(true);
  pass(tag, 'deny');
}

export async function expectInsertAllowed(
  client: Principal,
  table: string,
  row: Row,
  tag: CoverageTag,
): Promise<void> {
  const { data, error } = await client.insert(table, row);
  expect(
    error,
    `${table}: expected the INSERT to be permitted, got ${describeError(error)}`,
  ).toBeNull();
  expect((data ?? []).length, `${table}: INSERT returned no row`).toBe(1);
  pass(tag, 'allow');
}

/**
 * An INSERT that must be rejected by a structural constraint rather than by RLS —
 * mismatched organization_id across a composite foreign key, for example. Accepts a
 * foreign-key or check violation as well as an authorization refusal, because both are
 * correct answers to "these two rows belong to different organizations".
 */
export async function expectInsertRejected(
  client: Principal,
  table: string,
  row: Row,
  tag: CoverageTag,
): Promise<void> {
  const { error } = await client.insert(table, row);
  expect(error, `${table}: a cross-organization INSERT was accepted`).not.toBeNull();
  const code = error?.code ?? '';
  const acceptable =
    isAuthorizationRefusal(error) || ['23503', '23514', '23505', 'P0001'].includes(code);
  expect(
    acceptable,
    `${table}: expected an authorization or integrity rejection, got ${describeError(error)}`,
  ).toBe(true);
  pass(tag, 'deny');
}

/* ------------------------------------------------------------------ update -- */

export interface WriteDenialOptions {
  /** A principal entitled to read the row, used to confirm nothing changed. */
  verifyWith?: Principal;
  /** The column the patch targets, read back through `verifyWith`. */
  verifyColumn?: string;
}

export async function expectUpdateDenied(
  client: Principal,
  table: string,
  rowId: string,
  patch: Row,
  tag: CoverageTag,
  options: WriteDenialOptions = {},
): Promise<void> {
  const before = await readColumn(options, table, rowId);

  const { data, error } = await client.update(table, patch, { id: rowId });

  if (error) {
    expect(
      isAuthorizationRefusal(error) || error.code === TRIGGER_CONFLICT_CODE,
      `${table}: UPDATE was rejected, but not as an authorization refusal — ${describeError(error)}`,
    ).toBe(true);
  } else {
    expect(
      data ?? [],
      `${table}: UPDATE affected rows where the matrix grants no UPDATE. RLS returns zero ` +
        'rows rather than an error for an invisible row, so this is the assertion that matters.',
    ).toEqual([]);
  }

  const after = await readColumn(options, table, rowId);
  if (before !== undefined) {
    expect(after, `${table}: the row changed despite the UPDATE being reported as denied`).toEqual(
      before,
    );
  }
  pass(tag, 'deny');
}

export async function expectUpdateAllowed(
  client: Principal,
  table: string,
  rowId: string,
  patch: Row,
  tag: CoverageTag,
  returning = 'id',
): Promise<Row[]> {
  const { data, error } = await client.update(table, patch, { id: rowId }, returning);
  expect(
    error,
    `${table}: expected the UPDATE to be permitted, got ${describeError(error)}`,
  ).toBeNull();
  expect(
    (data ?? []).length,
    `${table}: UPDATE affected no rows, so the policy hid a row the matrix grants`,
  ).toBe(1);
  pass(tag, 'allow');
  return data ?? [];
}

/* ------------------------------------------------------------------ delete -- */

/**
 * §4: no DELETE is granted on any table, to any role, in any organization. There is no
 * `expectDeleteAllowed`, deliberately — there is no case where one would be correct.
 */
export async function expectDeleteDenied(
  client: Principal,
  table: string,
  rowId: string,
  tag: CoverageTag,
  options: WriteDenialOptions = {},
): Promise<void> {
  const { data, error } = await client.remove(table, { id: rowId });

  if (error) {
    expect(
      isAuthorizationRefusal(error) || error.code === TRIGGER_CONFLICT_CODE,
      `${table}: DELETE was rejected, but not as an authorization refusal — ${describeError(error)}`,
    ).toBe(true);
  } else {
    expect(
      data ?? [],
      `${table}: a DELETE removed rows. No tenant-scoped table may grant DELETE to anyone ` +
        '(docs/implementation-plan.md §4, finding 5). Archive instead.',
    ).toEqual([]);
  }

  // The row must still be there. Checked through an authenticated reader when one is
  // supplied, because that is an assertion RLS itself has to permit.
  if (options.verifyWith) {
    const { data: still } = await options.verifyWith.select(table, { eq: { id: rowId } });
    expect((still ?? []).length, `${table}: row ${rowId} was actually deleted`).toBe(1);
  }
  pass(tag, 'deny');
}

/**
 * Reads one column back through a principal entitled to see the row.
 *
 * Returns `undefined` when there is nothing to verify with, and THROWS when the read
 * itself fails. Swallowing that error was a real defect: a verification read that timed
 * out returned `null`, the post-write read succeeded, and the mismatch was reported as
 * "the row changed despite the UPDATE being reported as denied" — a fabricated security
 * finding produced by lock contention.
 */
async function readColumn(
  options: WriteDenialOptions,
  table: string,
  rowId: string,
): Promise<unknown> {
  if (!options.verifyWith || !options.verifyColumn) return undefined;
  const { data, error } = await options.verifyWith.select(table, {
    columns: options.verifyColumn,
    eq: { id: rowId },
  });
  if (error) {
    throw new Error(
      `${table}: the verification read of ${options.verifyColumn} on ${rowId} failed ` +
        `(${error.code ?? '-'}: ${error.message}). This is the harness being unable to ` +
        'check the row, not an access-control result — fix the verifier, do not read a ' +
        'security conclusion into it.',
    );
  }
  const row = (data ?? [])[0];
  return row ? row[options.verifyColumn] : null;
}

/** Records a passing assertion that is not shaped as a single table operation. */
export function recordPass(tag: CoverageTag, outcome: 'allow' | 'deny' = 'deny'): void {
  pass(tag, outcome);
}
