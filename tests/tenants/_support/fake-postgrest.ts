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
 * The fake applies **no row policy** of its own. It returns whatever the filters select.
 * That is deliberate: if a service relied on RLS to scope a query, the test would see the
 * unscoped rows and fail, which is exactly the signal wanted. A fake that re-implemented
 * the policies would hide the one defect this suite can catch.
 *
 * WHAT IT *DOES* REIMPLEMENT, AND WHY THAT IS NOT THE SAME THING
 * --------------------------------------------------------------
 * Migration `0004_agentic.sql` closed a measured PII leak by moving two columns out of
 * row-level security altogether and into the GRANT system plus a `security definer`
 * function. Those are not policies, and modelling them here is not the fake marking its
 * own homework:
 *
 *   - **Column privileges.** 0004 revoked table-level SELECT on `tenants` and granted
 *     back `id, organization_id, profile_id, full_name, created_at`. `email` and `phone`
 *     are now unreadable by *every* role through PostgREST, staff included, because all
 *     five application roles share the single Postgres role `authenticated` and a grant
 *     cannot branch on the caller. A `select` naming either column therefore fails here
 *     with SQLSTATE 42501, exactly as the database would. See `REVOKED_COLUMNS`.
 *   - **`tenant_contact()`.** The one remaining read path for those two columns. It is
 *     `security definer`, so it is *not* subject to RLS and the fake must answer it
 *     itself or hydration silently returns nulls — which would make a provider's
 *     name-only projection look correct no matter what the service did. It answers for
 *     organization staff and for the tenant themselves, and raises 42501 for everybody
 *     else, including a `service_provider` holding an assigned ticket. The refusal is
 *     the load-bearing half: a fake that handed rows to every caller would lie in
 *     precisely the direction this whole change exists to prevent.
 *
 * Both need to know who is calling, which RLS never required of this fake. Pass the same
 * `Membership` the service under test was given, as `config.caller`. Omitting it models
 * an unauthenticated session, and `tenant_contact` answers `28000` accordingly.
 *
 * The chainable surface below is only as wide as this lane uses. An unsupported method is
 * an explicit throw, not a silent no-op, so a service that starts using `.rpc('rpc_x')`
 * or `.textSearch()` fails loudly here instead of appearing to pass.
 */

import type { Membership } from '@/lib/auth/roles';
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
  /**
   * Who is calling, for the `security definer` functions that read their own caller
   * rather than relying on row level security — today, `tenant_contact`.
   *
   * Pass the very `Membership` handed to the service under test, so that the fake and
   * the service cannot disagree about the identity. Omitted means "no session", which is
   * what an unauthenticated PostgREST request looks like to those functions.
   */
  caller?: Membership | null;
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

/**
 * Columns the `authenticated` role may no longer SELECT, by table.
 *
 * `tenants.email` / `tenants.phone` were revoked by `0004_agentic.sql`: a
 * `service_provider` could read both straight through PostgREST for every tenant it had
 * been assigned to, because row level security filters rows and not columns. Nothing
 * reads them through a `select` any more — staff and the tenant themselves go through
 * `tenant_contact()` — so naming either one is a defect, and the fake answers it the way
 * Postgres does rather than quietly returning the value.
 */
const REVOKED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tenants: ['email', 'phone'],
};

/** `is_org_staff()`: the two roles with RW on `tenants` in the §4 matrix. */
const STAFF_ROLES: readonly string[] = ['organization_admin', 'property_manager'];

/** A string field of a fixture row, or null. Rows are `Record<string, unknown>`. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function createFakeClient(config: FakeClientConfig): FakeClient {
  const queries: RecordedQuery[] = [];
  const failures = config.failures ?? {};

  const tableRows = (table: string): Row[] => {
    config.tables[table] ??= [];
    return config.tables[table];
  };

  /**
   * `public.tenant_contact(p_organization_id, p_tenant_id)` — the only read path left for
   * tenant contact details, transcribed from `0004_agentic.sql`.
   *
   * Three branches, in the function's own order, because the order is the boundary:
   *
   *  1. Organization staff, for the organization they are staff of → every tenant in it,
   *     or the one named. A null `p_tenant_id` means "all of them", which is why a list
   *     page can hydrate in one round trip instead of one call per row.
   *  2. The tenant themselves → their own row and no other. The matrix gives `tenant`
   *     "R self only" on `tenants`, and that cell includes their own contact details, so
   *     a staff-only accessor would make that row of the matrix unsatisfiable. Resolved
   *     through `tenants.profile_id`, which is what `current_tenant_id(org)` does.
   *  3. Everybody else — `property_owner`, `service_provider` *including one holding the
   *     assigned ticket*, and any member of another organization → SQLSTATE 42501.
   *
   * Branch 3 is why this is modelled at all. `hydrateContacts()` treats an error as "keep
   * the nulls", so a fake that returned rows to all callers would make the provider's
   * name-only projection pass whether or not the service projected — the one thing these
   * tests exist to measure. It is `security definer`, so it reads the raw fixture table:
   * that is the real function's behaviour, and the reason its organization filter is
   * load-bearing rather than decorative.
   */
  const tenantContact = (args: Row): Result<unknown> => {
    const organizationId = text(args.p_organization_id);
    const tenantId = text(args.p_tenant_id);
    const caller = config.caller ?? null;

    if (organizationId === null) {
      return pgError(
        '22023',
        'tenant_contact_organization_required: p_organization_id must be supplied',
      );
    }
    if (!caller) {
      return pgError(
        '28000',
        'authentication_required: tenant_contact needs an authenticated session',
      );
    }

    const contactsOf = (rows: readonly Row[]) =>
      rows.map((row) => ({
        tenant_id: text(row.id),
        email: text(row.email),
        phone: text(row.phone),
      }));

    const inOrganization = tableRows('tenants').filter(
      (row) => text(row.organization_id) === organizationId,
    );

    // `is_org_staff(p_organization_id)` — staff *of the organization asked about*, so a
    // manager of organization A passing organization B's id falls through to 42501.
    if (STAFF_ROLES.includes(caller.role) && caller.organization.id === organizationId) {
      const rows = inOrganization.filter((row) => tenantId === null || text(row.id) === tenantId);
      return { data: contactsOf(rows), error: null };
    }

    // `current_tenant_id(p_organization_id)`: the caller's own `tenants` row, if any.
    const own = inOrganization.find((row) => text(row.profile_id) === caller.profile.id) ?? null;
    if (own && (tenantId === null || tenantId === text(own.id))) {
      return { data: contactsOf([own]), error: null };
    }

    return pgError(
      '42501',
      'tenant_contact_forbidden: only organization staff, or the tenant themselves, may read tenant contact details',
    );
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
      if (failure) return Promise.resolve<Result<unknown>>({ data: null, error: failure });

      // `tenant_contact` is modelled for real — see the comment on it. Every other RPC in
      // this lane is an audit append whose return value nothing reads, so it keeps the
      // opaque stub rather than growing a second half-implemented function.
      if (name === 'tenant_contact') return Promise.resolve(tenantContact(args));

      return Promise.resolve<Result<unknown>>({
        data: `audit-${queries.length}`,
        error: null,
      });
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

    // Privileges are checked before the statement runs, and before any configured
    // failure, because that is the order Postgres uses: a revoked column is refused
    // whether or not the query would have matched a row. The select list is checked for
    // every op — an `insert ... returning email` needs SELECT on `email` just as a plain
    // read does, so `.insert(...).select(...)` is not a way around the revoke.
    const revoked = revokedColumnsIn(recorded.table, recorded.select);
    if (revoked.length > 0) {
      return {
        data: [],
        error: {
          // PostgREST surfaces the SQLSTATE verbatim, and `errorCodeForSqlState` maps
          // 42501 to FORBIDDEN — so a service that selects a column it may not read
          // turns a legitimate request into a 403 for its own caller. That is the
          // production symptom this guard reproduces.
          code: '42501',
          message:
            `permission denied for table ${recorded.table} ` +
            `(column${revoked.length > 1 ? 's' : ''} ${revoked.join(', ')}). ` +
            'Migration 0004 revoked SELECT on these columns for every role; read them ' +
            'through the tenant_contact(p_organization_id, p_tenant_id) RPC instead.',
        },
      };
    }

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

/** A raised exception, in the shape PostgREST hands back to the client. */
function pgError(code: string, message: string): Result<null> {
  return { data: null, error: { code, message } };
}

/** The `select` list as a column array. One parser, used by the guard and by `project`. */
function selectColumns(selectList: string | null): string[] {
  if (!selectList) return [];
  return selectList
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}

/**
 * Which columns of this `select` the `authenticated` role may no longer read.
 *
 * Empty for every table but `tenants`, and empty for `tenants` too unless the list names
 * `email` or `phone`. A `select *` is reported as naming both: the revoke makes `*`
 * itself fail in Postgres, and this lane never issues one anyway.
 */
function revokedColumnsIn(table: string, selectList: string | null): string[] {
  const revoked = REVOKED_COLUMNS[table];
  if (!revoked || selectList === null) return [];

  const columns = selectColumns(selectList);
  if (columns.includes('*')) return [...revoked];
  return revoked.filter((column) => columns.includes(column));
}

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

  const columns = selectColumns(selectList);

  const projected: Row = {};
  for (const column of columns) {
    if (column in row) projected[column] = row[column];
  }
  return projected;
}
