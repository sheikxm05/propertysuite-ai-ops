/**
 * A recording stand-in for the PostgREST query builder. Lane w1-l2.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT STAND IN FOR
 * ---------------------------------------------------------------------------
 * `.env.local` carries the live Supabase URL and direct-Postgres credentials, but the
 * anon and service_role keys are not available to this lane, so `supabase-js` cannot
 * authenticate against the project. The RLS half of the proof therefore lives in
 * `tests/rls/**` (lane w0-l6), which runs against a real database behind the `PS_RLS`
 * gate; these suites prove the **application-space** half, which is the half this lane
 * wrote.
 *
 * So this fake replaces the *transport*: it records the statement the service built and
 * returns rows the test chose. It does **not** replace anything under test. Specifically:
 *
 *  - `authorize()` from `lib/auth/authorize.ts` is the real implementation. Every
 *    role-boundary assertion in these suites runs the real matrix.
 *  - `features/properties/**` is entirely real — the scope resolution, the cursor codec,
 *    the search sanitiser, the status machine, the 404-not-403 rule.
 *  - `withApiHandler` is real in `routes.test.ts`, including the SQLSTATE mapping, so a
 *    `23505` from this fake becomes a 409 through the production code path.
 *
 * That split is what makes a test like "a cross-organization row the database returned
 * anyway is dropped" possible at all: the fake *is* the bugged database, and the
 * assertion is that the application layer denies without it.
 */

import type { AppSupabaseClient } from '@/lib/supabase/types';

/** One filter, transform or modifier call, in the order the service made it. */
export interface RecordedCall {
  method: string;
  args: readonly unknown[];
}

/** Everything the service asked for, as the fake saw it. */
export interface QueryRecord {
  table: string;
  operation: 'select' | 'insert' | 'update';
  /** The column list passed to `.select(...)`, when one was. */
  columns: string | null;
  /** The row(s) passed to `.insert(...)` or the patch passed to `.update(...)`. */
  payload: unknown;
  calls: RecordedCall[];
  /** Which single-row terminator was used, if any. */
  terminator: 'single' | 'maybeSingle' | null;
  /** `{ count: 'exact', head: true }`, when requested. */
  countRequested: boolean;
}

/** The shape a responder returns. Rows, or a Postgres-style error, or a count. */
export interface ResponderResult {
  rows?: readonly unknown[];
  error?: { code?: string; message?: string } | null;
  count?: number | null;
}

/**
 * Answers one statement.
 *
 * Keyed by `"<table>:<operation>"` with a `"<table>"` fallback, so a test only scripts
 * what it cares about. An unscripted statement is a thrown error rather than an empty
 * result: a service that queried a table the test did not anticipate must fail loudly.
 */
export type Responder = (query: QueryRecord) => ResponderResult;

export interface FakeClient {
  /** Pass this where an `AppSupabaseClient` is expected. */
  client: AppSupabaseClient;
  /** Every statement, in order. */
  queries: QueryRecord[];
}

/** Rows a test wants returned for a table, with no error and no count. */
export function rows(...values: readonly unknown[]): Responder {
  return () => ({ rows: values });
}

/** A Postgres error for a table, e.g. `fails('23505', 'duplicate key …')`. */
export function fails(code: string, message = 'database error'): Responder {
  return () => ({ error: { code, message } });
}

/** An exact count, for the `head: true` statements `portfolioCounts` issues. */
export function counts(value: number): Responder {
  return () => ({ count: value });
}

/**
 * Different answers for successive statements against the same table and operation.
 *
 * Needed because one service call can read a table twice with different intent —
 * `listUnits` reads `property_units` once to resolve a tenant's scope and once for the
 * list itself. Exhausting the sequence throws rather than repeating the last answer: an
 * extra statement the test did not anticipate is a finding, not something to absorb.
 */
export function sequence(...results: readonly ResponderResult[]): Responder {
  let index = 0;
  return (query) => {
    const result = results[index];
    index += 1;
    if (!result) {
      throw new Error(
        `fake-supabase: ${query.table}:${query.operation} was called ${index} times but only ` +
          `${results.length} answer(s) were scripted.`,
      );
    }
    return result;
  };
}

export function createFakeClient(responders: Record<string, Responder>): FakeClient {
  const queries: QueryRecord[] = [];

  const answer = (query: QueryRecord): ResponderResult => {
    const responder =
      responders[`${query.table}:${query.operation}`] ?? responders[query.table] ?? null;

    if (!responder) {
      throw new Error(
        `fake-supabase: no responder for ${query.table}:${query.operation}. ` +
          'Script it, or the service queried something the test did not expect.',
      );
    }
    return responder(query);
  };

  /**
   * Shapes a responder result the way PostgREST does.
   *
   * `single()` on an empty result is `PGRST116`, which `lib/api/errors.ts` maps to
   * `NOT_FOUND` — the behaviour the service relies on for "updated nothing". Reproducing
   * it here rather than letting each test hand-write the error keeps the tests honest
   * about what the real client does.
   */
  const settle = (query: QueryRecord) => {
    const result = answer(query);
    if (result.error) return { data: null, error: result.error, count: null };

    const list = result.rows ?? [];
    if (query.terminator === 'single') {
      return list.length === 0
        ? {
            data: null,
            error: {
              code: 'PGRST116',
              message: 'JSON object requested, multiple (or no) rows returned',
            },
            count: null,
          }
        : { data: list[0], error: null, count: null };
    }
    if (query.terminator === 'maybeSingle') {
      return { data: list[0] ?? null, error: null, count: null };
    }
    return { data: list, error: null, count: result.count ?? null };
  };

  /**
   * The builder. Every chainable method records itself and returns `this`; awaiting it
   * settles the statement. `then` is implemented directly rather than by extending
   * `Promise`, so a statement is only executed if the service actually awaits it.
   */
  function makeBuilder(query: QueryRecord) {
    const builder: Record<string, unknown> = {
      then(onFulfilled: unknown, onRejected: unknown) {
        return Promise.resolve(settle(query)).then(onFulfilled as never, onRejected as never);
      },
      single() {
        query.terminator = 'single';
        return builder;
      },
      maybeSingle() {
        query.terminator = 'maybeSingle';
        return builder;
      },
      select(columns?: string, options?: { count?: string; head?: boolean }) {
        query.columns = columns ?? null;
        if (options?.count) query.countRequested = true;
        return builder;
      },
    };

    // Filters and transforms. Only the ones `features/properties/service.ts` and
    // `scope.ts` actually use; anything else should fail the test rather than be
    // silently accepted.
    for (const method of ['eq', 'in', 'or', 'order', 'limit', 'neq', 'is'] as const) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push({ method, args });
        return builder;
      };
    }

    return builder;
  }

  const client = {
    from(table: string) {
      return {
        select(columns?: string, options?: { count?: string; head?: boolean }) {
          const query = newQuery(table, 'select');
          query.columns = columns ?? null;
          if (options?.count) query.countRequested = true;
          queries.push(query);
          return makeBuilder(query);
        },
        insert(payload: unknown) {
          const query = newQuery(table, 'insert');
          query.payload = payload;
          queries.push(query);
          return makeBuilder(query);
        },
        update(payload: unknown) {
          const query = newQuery(table, 'update');
          query.payload = payload;
          queries.push(query);
          return makeBuilder(query);
        },
      };
    },
  };

  return { client: client as unknown as AppSupabaseClient, queries };
}

function newQuery(table: string, operation: QueryRecord['operation']): QueryRecord {
  return {
    table,
    operation,
    columns: null,
    payload: undefined,
    calls: [],
    terminator: null,
    countRequested: false,
  };
}

/* ------------------------------------------------------------- assertions -- */

/** The statements issued against one table, in order. */
export function queriesFor(
  fake: FakeClient,
  table: string,
  operation?: QueryRecord['operation'],
): QueryRecord[] {
  return fake.queries.filter(
    (query) => query.table === table && (!operation || query.operation === operation),
  );
}

/** The value of an `.eq(column, …)` call on a statement, or `undefined`. */
export function eqValue(query: QueryRecord, column: string): unknown {
  return query.calls.find((call) => call.method === 'eq' && call.args[0] === column)?.args[1];
}

/** The value list of an `.in(column, […])` call, or `undefined`. */
export function inValues(query: QueryRecord, column: string): unknown[] | undefined {
  const call = query.calls.find((c) => c.method === 'in' && c.args[0] === column);
  return call ? (call.args[1] as unknown[]) : undefined;
}

/** Every `.or(...)` expression on a statement. */
export function orFilters(query: QueryRecord): string[] {
  return query.calls.filter((call) => call.method === 'or').map((call) => String(call.args[0]));
}

/** The `.limit(n)` the statement asked for. */
export function limitValue(query: QueryRecord): number | undefined {
  const call = query.calls.find((c) => c.method === 'limit');
  return call ? (call.args[0] as number) : undefined;
}
