/**
 * An in-memory stand-in for the PostgREST query builder, for lane w1-l3's unit tests.
 *
 * WHAT IT IS FOR, AND WHAT IT PROVES NOTHING ABOUT
 * ------------------------------------------------
 * Authorization in this application is enforced twice: Row Level Security in Postgres,
 * and server-side checks in `features/**`. The RLS half is proven by `tests/rls/**`
 * against a real database with real JWTs (lane w0-l6) — nothing here substitutes for
 * that, and a passing suite in this directory says nothing whatsoever about a policy.
 *
 * What it does prove is the half that RLS structurally cannot:
 *
 *   - **Column projection.** The fake returns exactly the columns the `select` list asked
 *     for, just as PostgREST does. So a fixture row carrying `email` and `phone` yields a
 *     response *without* them if and only if the service projected correctly. A test can
 *     assert the absence of a key rather than merely asserting that a role was refused —
 *     which is the difference between checking the row boundary and checking the column
 *     boundary.
 *   - **Server-side rules with no database counterpart**: the overlapping-active-tenancy
 *     rule, the tenancy lifecycle edge set, the unit-occupancy reconciliation, and the
 *     date ordering re-check on a partial PATCH.
 *   - **What the service actually sent.** Every query is recorded, so a test can assert
 *     that `organization_id` was filtered on at all, and that the value came from
 *     membership rather than from the request.
 *
 * The fake applies **no** policy of its own. It returns whatever the filters select. That
 * is deliberate: if a service relied on RLS to scope a query, the test would see the
 * unscoped rows and fail, which is exactly the signal wanted. A fake that re-implemented
 * the policies would hide the one defect this suite can catch.
 *
 * The chainable surface below is only as wide as this lane uses. An unsupported method is
 * an explicit throw, not a silent no-op, so a service that starts using `.rpc('rpc_x')`
 * or `.textSearch()` fails loudly here instead of appearing to pass.
 */

import type { AppSupabaseClient } from '@/lib/supabase/types';

export type Row = Record<string, unknown>;

export interface PostgresFailure {
  code: string;
  message: string;
}

export interface FakeClientConfig {
  /** `tableName → rows`. Mutated in place by inserts and updates, like a database. */
  tables: Record<string, Row[]>;
  /**
   * Forced failures, keyed `"<op>:<table>"` — `"update:property_units"`,
   * `"select:tenancies"`, `"insert:tenants"` — or `"rpc:<name>"`.
   */
  failures?: Record<string, PostgresFailure>;
}

/** One query the service issued, as the service issued it. */
export interface RecordedQuery {
  op: 'select' | 'insert' | 'update' | 'rpc';
  table: string;
  /** The `select` list verbatim, which is how a projection assertion is made. */
  select: string | null;
  filters: { method: string; column: string; value: unknown }[];
  payload?: unknown;
  limit: number | null;
}

export interface FakeClient {
  client: AppSupabaseClient;
  queries: RecordedQuery[];
  /** Convenience: every recorded query against one table. */
  against(table: string): RecordedQuery[];
  /** Convenience: every `rpc` call by name. */
  rpcCalls(name: string): RecordedQuery[];
}

type Result<T> = { data: T; error: PostgresFailure | null };

export function createFakeClient(config: FakeClientConfig): FakeClient {
  const queries: RecordedQuery[] = [];
  const failures = config.failures ?? {};

  const tableRows = (table: string): Row[] => {
    config.tables[table] ??= [];
    return config.tables[table];
  };

  const client = {
    from(table: string) {
      return {
        select(selectList: string) {
          return createBuilder({
            op: 'select',
            table,
            select: selectList,
            rows: () => tableRows(table),
            failures,
            queries,
          });
        },

        /**
         * `insert` happens inside `rows()`, so it runs when the builder is awaited — the
         * same point at which PostgREST would have sent the request. An insert builder
         * that is never awaited writes nothing.
         */
        insert(payload: Row) {
          return createBuilder({
            op: 'insert',
            table,
            select: null,
            payload,
            rows: () => {
              const inserted: Row = {
                // A real UUID shape, because the response schemas validate it. A
                // placeholder like `generated-1` would fail `UuidSchema` and the test
                // would look like a serialisation bug rather than a fixture one.
                id: payload.id ?? generatedUuid(),
                created_at: payload.created_at ?? '2026-01-01T00:00:00+00:00',
                ...payload,
              };
              tableRows(table).push(inserted);
              return [inserted];
            },
            failures,
            queries,
          });
        },

        /** `update` applies the patch to the rows its filters matched, in place. */
        update(payload: Row) {
          return createBuilder({
            op: 'update',
            table,
            select: null,
            payload,
            rows: () => tableRows(table),
            mutate: (matched) => {
              for (const row of matched) Object.assign(row, payload);
              return matched;
            },
            failures,
            queries,
          });
        },
      };
    },

    rpc(name: string, args: Row) {
      const recorded: RecordedQuery = {
        op: 'rpc',
        table: name,
        select: null,
        filters: [],
        payload: args,
        limit: null,
      };
      queries.push(recorded);

      const failure = failures[`rpc:${name}`] ?? null;
      const result: Result<unknown> = failure
        ? { data: null, error: failure }
        : { data: `audit-${queries.length}`, error: null };

      return Promise.resolve(result);
    },
  };

  return {
    client: client as unknown as AppSupabaseClient,
    queries,
    against: (table) => queries.filter((query) => query.table === table),
    rpcCalls: (name) => queries.filter((query) => query.op === 'rpc' && query.table === name),
  };
}

/**
 * A deterministic, well-formed UUID for an inserted row.
 *
 * `gen_random_uuid()`'s stand-in. Deterministic so that a failing assertion names the
 * same identifier on every run; `ee...` prefixed so an inserted row is recognisable in
 * a diff against the `seedTables()` fixtures.
 */
let generatedCount = 0;
function generatedUuid(): string {
  generatedCount += 1;
  return `eeeeeeee-0000-4000-8000-${String(generatedCount).padStart(12, '0')}`;
}

/* ---------------------------------------------------------------- builder -- */

const FILTER_METHODS = ['eq', 'neq', 'in', 'ilike', 'gte', 'lte', 'gt', 'lt'] as const;

interface BuilderOptions {
  op: RecordedQuery['op'];
  table: string;
  select: string | null;
  payload?: unknown;
  rows: () => Row[];
  /** Applied to the filtered rows, for `update`. */
  mutate?: (matched: Row[]) => Row[];
  failures: Record<string, PostgresFailure>;
  queries: RecordedQuery[];
}

function createBuilder(options: BuilderOptions) {
  const recorded: RecordedQuery = {
    op: options.op,
    table: options.table,
    select: options.select,
    filters: [],
    limit: null,
  };
  if (options.payload !== undefined) recorded.payload = options.payload;

  const order: { column: string; ascending: boolean }[] = [];

  const resolveRows = (): Row[] => {
    let rows = applyFilters(options.rows(), recorded.filters);
    if (options.mutate) rows = options.mutate(rows);
    for (const spec of [...order].reverse()) rows = sortRows(rows, spec);
    if (recorded.limit !== null) rows = rows.slice(0, recorded.limit);
    return rows;
  };

  const builder: Record<string, unknown> = {};

  for (const method of FILTER_METHODS) {
    builder[method] = (column: string, value: unknown) => {
      recorded.filters.push({ method, column, value });
      return builder;
    };
  }

  // `insert(...).select(...)` and `update(...).eq(...).select(...)` both land here.
  builder.select = (selectList: string) => {
    recorded.select = selectList;
    return builder;
  };

  builder.or = (expression: string) => {
    // Recorded so a test can assert a keyset filter was applied, but not evaluated: the
    // fake does not parse PostgREST expressions and must not pretend to.
    recorded.filters.push({ method: 'or', column: '(expression)', value: expression });
    return builder;
  };

  builder.order = (column: string, opts?: { ascending?: boolean }) => {
    order.push({ column, ascending: opts?.ascending !== false });
    return builder;
  };

  builder.limit = (count: number) => {
    recorded.limit = count;
    return builder;
  };

  builder.maybeSingle = () => {
    const thenable = makeThenable(recorded, resolveRows, options.failures, options.queries);
    return thenable.then((result: Result<Row[]>) => ({
      data: result.error ? null : (result.data[0] ?? null),
      error: result.error,
    }));
  };

  builder.single = () => {
    const thenable = makeThenable(recorded, resolveRows, options.failures, options.queries);
    return thenable.then((result: Result<Row[]>) => {
      if (result.error) return { data: null, error: result.error };
      const row = result.data[0];
      if (!row) {
        return {
          data: null,
          // PostgREST's own "no rows for .single()" code, which `lib/api/errors.ts`
          // maps to NOT_FOUND.
          error: { code: 'PGRST116', message: 'no rows returned' },
        };
      }
      return { data: row, error: null };
    });
  };

  Object.assign(builder, makeThenable(recorded, resolveRows, options.failures, options.queries));
  return builder;
}

/**
 * Makes a builder awaitable, recording the query at the moment it is awaited.
 *
 * Recording on `await` rather than on construction means the recorded filter list is
 * complete, and an abandoned builder leaves no trace — the same as a query never sent.
 */
function makeThenable(
  recorded: RecordedQuery,
  resolve: () => Row[],
  failures: Record<string, PostgresFailure>,
  queries: RecordedQuery[],
) {
  const run = (): Result<Row[]> => {
    if (!queries.includes(recorded)) queries.push(recorded);

    const failure = failures[`${recorded.op}:${recorded.table}`];
    if (failure) return { data: [], error: failure };

    const rows = resolve();
    return { data: rows.map((row) => project(row, recorded.select)), error: null };
  };

  return {
    then<TResult1, TResult2 = never>(
      onFulfilled?: ((value: Result<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(run()).then(onFulfilled, onRejected);
    },
  };
}

/* ---------------------------------------------------------------- helpers -- */

function applyFilters(rows: readonly Row[], filters: RecordedQuery['filters']): Row[] {
  return rows.filter((row) =>
    filters.every((filter) => {
      const actual = row[filter.column];
      switch (filter.method) {
        case 'eq':
          return actual === filter.value;
        case 'neq':
          return actual !== filter.value;
        case 'in':
          return Array.isArray(filter.value) && filter.value.includes(actual);
        case 'ilike':
          return matchesIlike(actual, filter.value);
        case 'gte':
          return compare(actual, filter.value) >= 0;
        case 'lte':
          return compare(actual, filter.value) <= 0;
        case 'gt':
          return compare(actual, filter.value) > 0;
        case 'lt':
          return compare(actual, filter.value) < 0;
        case 'or':
          // Not evaluated — see `builder.or`.
          return true;
        default:
          throw new Error(`fake-postgrest: unsupported filter ${filter.method}`);
      }
    }),
  );
}

function matchesIlike(actual: unknown, pattern: unknown): boolean {
  if (typeof actual !== 'string' || typeof pattern !== 'string') return false;
  const needle = pattern.replace(/%/g, '').toLowerCase();
  return actual.toLowerCase().includes(needle);
}

function compare(a: unknown, b: unknown): number {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortRows(rows: readonly Row[], spec: { column: string; ascending: boolean }): Row[] {
  const sorted = [...rows].sort((a, b) => compare(a[spec.column], b[spec.column]));
  return spec.ascending ? sorted : sorted.reverse();
}

/**
 * Projects a row down to the `select` list, exactly as PostgREST does.
 *
 * This is the behaviour the projection tests depend on: a withheld column is *absent*
 * from the result, not present-and-null. A service that selected it would therefore
 * produce a row with the key, and the assertion would catch it.
 */
function project(row: Row, selectList: string | null): Row {
  if (!selectList || selectList.trim() === '*') return { ...row };

  const columns = selectList
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0);

  const projected: Row = {};
  for (const column of columns) {
    if (column in row) projected[column] = row[column];
  }
  return projected;
}
