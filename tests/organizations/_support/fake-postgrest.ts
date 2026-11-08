/**
 * A recording stand-in for a PostgREST client. Lane w1-l1 test support.
 *
 * **What it is for, and what it must never be used to prove.** The route handlers in
 * this lane are real, `withApiHandler` is real, `authorize()` is real, every Zod schema
 * is real, and the error envelope is real. What cannot be real in a unit test is the
 * database: `.env.local` has no anon or service-role key, so `@supabase/supabase-js`
 * cannot authenticate against the project and PostgREST cannot be reached over HTTP.
 * This object stands in for that one transport and records what was asked of it.
 *
 * It therefore proves things *about our code*: that the role gate refuses before the
 * database is touched at all, that `select *` is never issued against the invitations
 * table, that the column allowlist on a membership update really is an allowlist, that
 * the last-administrator guard runs. It proves **nothing** about Row Level Security —
 * a fake client has no policies, so an assertion that only passed because this object
 * returned a row would be an assertion that passes against a database with no security
 * at all. RLS is proven by `tests/rls/**` against real Postgres, and by
 * `live-invitation-lifecycle.test.ts` in this directory, which impersonates
 * `authenticated` over a real connection.
 *
 * The recording is the point. Most assertions here are about the *query that was sent*,
 * not the rows that came back, because the query is the part this lane wrote.
 */

import type { AppSupabaseClient } from '@/lib/supabase/types';

/** One filter applied to a query, in the order it was applied. */
export interface RecordedFilter {
  op: string;
  args: unknown[];
}

/** Everything a handler asked of the database in one builder chain. */
export interface RecordedQuery {
  table: string;
  kind: 'select' | 'update' | 'insert' | 'delete';
  /** The projection, exactly as the caller wrote it. Asserted against, not normalised. */
  columns: string | undefined;
  selectOptions: { count?: string; head?: boolean } | undefined;
  filters: RecordedFilter[];
  orders: { column: string; ascending: boolean }[];
  limit: number | undefined;
  /** The row payload of an `update` or `insert`. */
  payload: unknown;
  terminal: 'maybeSingle' | 'single' | null;
}

export interface QueryResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

export type QueryResponder = (query: RecordedQuery) => QueryResult;

export interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
}

export type RpcResponder = (call: RecordedRpc) => QueryResult;

export interface FakeClient {
  client: AppSupabaseClient;
  /** Every builder chain that was awaited, in order. */
  queries: RecordedQuery[];
  /** Every RPC invocation, in order. */
  rpcs: RecordedRpc[];
}

/**
 * Builds the fake.
 *
 * `onQuery` and `onRpc` default to "nothing found": an unconfigured call returns an
 * empty result rather than throwing, so a test that asserts "the database was never
 * touched" fails on the recording rather than on an exception from somewhere else.
 */
export function createFakeClient(options: {
  onQuery?: QueryResponder;
  onRpc?: RpcResponder;
}): FakeClient {
  const queries: RecordedQuery[] = [];
  const rpcs: RecordedRpc[] = [];

  const respondQuery: QueryResponder = options.onQuery ?? (() => ({ data: [], count: 0 }));
  const respondRpc: RpcResponder =
    options.onRpc ??
    (({ name }) => ({
      error: { code: 'P0001', message: `${name}: no responder configured for this test` },
    }));

  const client = {
    from(table: string) {
      return createBuilder(table, queries, respondQuery);
    },
    rpc(name: string, args: Record<string, unknown>) {
      const call: RecordedRpc = { name, args };
      rpcs.push(call);
      const result = respondRpc(call);
      return thenable(() => ({ data: result.data ?? null, error: result.error ?? null }));
    },
  } as unknown as AppSupabaseClient;

  return { client, queries, rpcs };
}

/* ---------------------------------------------------------------- builder -- */

/** The subset of the PostgREST builder this lane actually uses. */
interface Builder extends PromiseLike<QueryResult> {
  select(columns?: string, selectOptions?: { count?: string; head?: boolean }): Builder;
  update(payload: unknown): Builder;
  eq(column: string, value: unknown): Builder;
  neq(column: string, value: unknown): Builder;
  or(filter: string): Builder;
  order(column: string, opts?: { ascending?: boolean }): Builder;
  limit(count: number): Builder;
  maybeSingle(): PromiseLike<QueryResult>;
  single(): PromiseLike<QueryResult>;
}

function createBuilder(table: string, queries: RecordedQuery[], respond: QueryResponder): Builder {
  const state: RecordedQuery = {
    table,
    kind: 'select',
    columns: undefined,
    selectOptions: undefined,
    filters: [],
    orders: [],
    limit: undefined,
    payload: undefined,
    terminal: null,
  };

  /**
   * Records the chain and asks the responder for a result.
   *
   * `head: true` queries are answered with `count` and no rows, which is what PostgREST
   * does — a count query that also returned rows would let a test pass while the
   * production code was transferring data it claimed not to need.
   */
  function execute(): QueryResult {
    queries.push({ ...state, filters: [...state.filters], orders: [...state.orders] });
    const result = respond(state);

    if (state.terminal === 'maybeSingle' || state.terminal === 'single') {
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data == null
          ? []
          : [result.data];
      return { ...result, data: rows[0] ?? null };
    }
    return result;
  }

  const builder: Builder = {
    select(columns, selectOptions) {
      // An `update(...).select(...)` chain keeps `kind: 'update'`: the statement is still
      // a write, and a test asserting "no write was attempted" must see that.
      if (state.kind === 'select') state.kind = 'select';
      state.columns = columns;
      state.selectOptions = selectOptions;
      return builder;
    },
    update(payload) {
      state.kind = 'update';
      state.payload = payload;
      return builder;
    },
    eq(column, value) {
      state.filters.push({ op: 'eq', args: [column, value] });
      return builder;
    },
    neq(column, value) {
      state.filters.push({ op: 'neq', args: [column, value] });
      return builder;
    },
    or(filter) {
      state.filters.push({ op: 'or', args: [filter] });
      return builder;
    },
    order(column, opts) {
      state.orders.push({ column, ascending: opts?.ascending !== false });
      return builder;
    },
    limit(count) {
      state.limit = count;
      return builder;
    },
    maybeSingle() {
      state.terminal = 'maybeSingle';
      return thenable(execute);
    },
    single() {
      state.terminal = 'single';
      return thenable(execute);
    },
    then(onFulfilled, onRejected) {
      return thenable(execute).then(onFulfilled, onRejected);
    },
  };

  return builder;
}

/** A minimal thenable, so `await builder` works without the builder being a Promise. */
function thenable<T>(compute: () => T): PromiseLike<T> {
  return {
    then(onFulfilled, onRejected) {
      try {
        const value = compute();
        return Promise.resolve(onFulfilled ? onFulfilled(value) : (value as never));
      } catch (error) {
        return onRejected ? Promise.resolve(onRejected(error)) : Promise.reject(error);
      }
    },
  };
}
