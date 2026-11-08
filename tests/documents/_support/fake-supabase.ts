/**
 * An in-memory stand-in for the PostgREST query builder.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CAN AND CANNOT PROVE. Read before adding a test that relies on it.
 * ---------------------------------------------------------------------------
 * It models **Postgres row semantics**, not Row Level Security. Specifically it does
 * model, faithfully:
 *
 *   * `UPDATE … WHERE id = ? AND status = ? AND attempts = ? RETURNING *` returning zero
 *     rows when the predicate no longer matches — which is the compare-and-swap the job
 *     claim depends on, and the only way to test "two workers, one job" without a
 *     database.
 *   * `unique` violations as SQLSTATE `23505`, which is what makes a duplicate enqueue
 *     return the existing row rather than a second one.
 *   * `maybeSingle()` returning `{ data: null }` for no rows, which is the shape an
 *     RLS-hidden row arrives in.
 *
 * It does **not** model RLS, and no test here may claim it does. A fake that enforced
 * policies would make every isolation test pass by construction — the exact failure the
 * project brief warns about. Cross-organization isolation is proven by `tests/rls/**`
 * against a real database with real policies, and by the end-to-end suite.
 *
 * What the tests in this directory *can* prove about isolation is the complementary
 * half, and it is not nothing: that the **server-side layer denies independently**. By
 * seeding this fake with a row from another organization — simulating a database that
 * handed one over, i.e. an RLS bug — the tests show `assertSameOrganization` and
 * `assertDocumentReadable` refusing it anyway. That is the second of the two
 * enforcement layers, tested on the assumption that the first has failed, which is what
 * `CLAUDE.md` asks for.
 * ---------------------------------------------------------------------------
 *
 * Deliberately narrow: it implements the operators this lane actually calls. An
 * unsupported operator throws rather than silently returning everything, because a fake
 * that quietly ignores a filter turns a passing test into a lie.
 */

import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;

export interface PostgrestLikeError {
  code: string;
  message: string;
}

interface Result<T> {
  data: T;
  error: PostgrestLikeError | null;
}

type Filter = (row: Row) => boolean;

/**
 * A table's rows, the columns under a `unique` constraint, and its column defaults.
 *
 * `defaults` is not a convenience. Every table in this schema declares
 * `id uuid primary key default gen_random_uuid()`, and `documents.verification_status`
 * declares `default 'pending'` — and the application *relies* on both: `enqueueJob`
 * never sends an `id`, and `insertDocument` deliberately omits
 * `verification_status` so that no code path in the lane can create a document in any
 * other state.
 *
 * A fake without defaults inserts rows with `id: undefined`, and then
 * `UPDATE … WHERE id = undefined` matches *every* such row. That is not a cosmetic
 * inaccuracy: it silently turned a batch of seven jobs into one claim that completed all
 * of them, and the test that caught it was an assertion about batch size rather than
 * about correctness. Modelling the defaults is what makes the compare-and-swap tests
 * mean anything.
 */
export interface TableSeed {
  rows: Row[];
  unique?: readonly string[];
  /** Column defaults, applied to an inserted row for any column it does not name. */
  defaults?: () => Row;
}

export interface FakeDatabaseOptions {
  /** Forced failure for the next matching operation, by table and verb. */
  failures?: readonly {
    table: string;
    verb: 'select' | 'insert' | 'update';
    error: PostgrestLikeError;
  }[];
}

/* -------------------------------------------------------------- the client -- */

export class FakeDatabase {
  readonly tables = new Map<string, TableSeed>();
  /** Every operation, in order, so a test can assert on *which tables* were written. */
  readonly operations: { table: string; verb: string; patch?: Row }[] = [];
  private readonly failures: { table: string; verb: string; error: PostgrestLikeError }[];

  constructor(seed: Record<string, TableSeed> = {}, options: FakeDatabaseOptions = {}) {
    for (const [table, value] of Object.entries(seed)) {
      this.tables.set(table, {
        rows: value.rows.map((row) => ({ ...row })),
        ...(value.unique ? { unique: value.unique } : {}),
        ...(value.defaults ? { defaults: value.defaults } : {}),
      });
    }
    this.failures = [...(options.failures ?? [])];
  }

  /**
   * Column defaults for `table`.
   *
   * `id` is defaulted for every table, because every table in `0001` declares
   * `default gen_random_uuid()`. Anything table-specific comes from the seed.
   */
  defaultsFor(table: string): Row {
    const seeded = this.tables.get(table)?.defaults?.() ?? {};
    return { id: randomUUID(), ...seeded };
  }

  rows(table: string): Row[] {
    const entry = this.tables.get(table);
    if (!entry) {
      const created: TableSeed = { rows: [] };
      this.tables.set(table, created);
      return created.rows;
    }
    return entry.rows;
  }

  uniqueColumns(table: string): readonly string[] {
    return this.tables.get(table)?.unique ?? [];
  }

  takeFailure(table: string, verb: string): PostgrestLikeError | null {
    const index = this.failures.findIndex((f) => f.table === table && f.verb === verb);
    if (index < 0) return null;
    const [failure] = this.failures.splice(index, 1);
    return failure?.error ?? null;
  }

  /** Tables that received a write. Used to prove a handler touched nothing else. */
  writtenTables(): string[] {
    return [...new Set(this.operations.filter((op) => op.verb !== 'select').map((op) => op.table))];
  }
}

/**
 * A query over one table. Mirrors the subset of the builder this lane uses, and is
 * awaitable at any point like the real one.
 */
class FakeQuery implements PromiseLike<Result<Row[]>> {
  private readonly filters: Filter[] = [];
  private orderBy: { column: string; ascending: boolean; nullsFirst: boolean }[] = [];
  private rowLimit: number | null = null;

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string,
    private readonly verb: 'select' | 'insert' | 'update',
    private readonly pending: { inserts?: Row[]; patch?: Row } = {},
  ) {}

  select(_columns?: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  lte(column: string, value: string): this {
    this.filters.push((row) => typeof row[column] === 'string' && (row[column] as string) <= value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  /**
   * The PostgREST `or` expressions this lane emits, and only those:
   *
   *   `next_run_at.is.null,next_run_at.lte.<iso>`
   *   `created_at.lt.<iso>,and(created_at.eq.<iso>,id.lt.<uuid>)`
   *
   * Parsed rather than pattern-matched on the whole string, so a change to either
   * expression is reflected here instead of silently passing.
   */
  or(expression: string): this {
    const clauses = splitTopLevel(expression);
    const predicates = clauses.map((clause) => parseClause(clause));
    this.filters.push((row) => predicates.some((predicate) => predicate(row)));
    return this;
  }

  order(column: string, options?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orderBy.push({
      column,
      ascending: options?.ascending ?? true,
      nullsFirst: options?.nullsFirst ?? false,
    });
    return this;
  }

  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  async maybeSingle(): Promise<Result<Row | null>> {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    return { data: data[0] ?? null, error: null };
  }

  async single(): Promise<Result<Row | null>> {
    const { data, error } = await this.run();
    if (error) return { data: null, error };
    if (data.length !== 1) {
      // PostgREST's own code for "`.single()` matched no rows", which
      // `lib/api/errors.ts` maps to NOT_FOUND.
      return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
    }
    return { data: data[0] ?? null, error: null };
  }

  then<R1 = Result<Row[]>, R2 = never>(
    onfulfilled?: ((value: Result<Row[]>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }

  private async run(): Promise<Result<Row[]>> {
    const forced = this.db.takeFailure(this.table, this.verb);
    if (forced) {
      this.db.operations.push({ table: this.table, verb: this.verb });
      return { data: [], error: forced };
    }

    if (this.verb === 'insert') return this.runInsert();
    if (this.verb === 'update') return this.runUpdate();
    return this.runSelect();
  }

  private runSelect(): Result<Row[]> {
    this.db.operations.push({ table: this.table, verb: 'select' });
    let rows = this.db.rows(this.table).filter((row) => this.filters.every((f) => f(row)));
    rows = this.sort(rows);
    if (this.rowLimit !== null) rows = rows.slice(0, this.rowLimit);
    return { data: rows.map((row) => ({ ...row })), error: null };
  }

  private runInsert(): Result<Row[]> {
    this.db.operations.push({ table: this.table, verb: 'insert' });
    const unique = this.db.uniqueColumns(this.table);
    const existing = this.db.rows(this.table);
    const inserted: Row[] = [];

    for (const candidate of this.pending.inserts ?? []) {
      for (const column of unique) {
        const value = candidate[column];
        if (value === undefined || value === null) continue;
        if (existing.some((row) => row[column] === value)) {
          return {
            data: [],
            error: { code: '23505', message: `duplicate key value violates unique constraint` },
          };
        }
      }
      // Defaults first, so a column the insert names wins and one it omits is filled —
      // which is what Postgres does, and what the application depends on.
      const row: Row = { ...this.db.defaultsFor(this.table) };
      for (const [column, value] of Object.entries(candidate)) {
        if (value !== undefined) row[column] = value;
      }
      existing.push(row);
      inserted.push({ ...row });
    }

    return { data: inserted, error: null };
  }

  private runUpdate(): Result<Row[]> {
    this.db.operations.push({ table: this.table, verb: 'update', patch: this.pending.patch });
    const updated: Row[] = [];
    for (const row of this.db.rows(this.table)) {
      if (!this.filters.every((f) => f(row))) continue;
      Object.assign(row, this.pending.patch ?? {});
      updated.push({ ...row });
    }
    return { data: updated, error: null };
  }

  private sort(rows: Row[]): Row[] {
    if (this.orderBy.length === 0) return rows;
    return [...rows].sort((left, right) => {
      for (const { column, ascending, nullsFirst } of this.orderBy) {
        const a = left[column];
        const b = right[column];
        if (a === b) continue;
        if (a === null || a === undefined) return nullsFirst ? -1 : 1;
        if (b === null || b === undefined) return nullsFirst ? 1 : -1;
        const comparison = String(a) < String(b) ? -1 : 1;
        return ascending ? comparison : -comparison;
      }
      return 0;
    });
  }
}

/* ------------------------------------------------------------------ facade -- */

export interface FakeStorageOptions {
  /** Objects by path. Absent means Storage returns a not-found error. */
  objects?: Record<string, Uint8Array>;
  signedUploadUrl?: string | null;
  signedDownloadUrl?: string | null;
  /** Forces an error from the signing calls. */
  signingError?: { message: string } | null;
}

export interface FakeClientOptions {
  storage?: FakeStorageOptions;
  /** Records `log_audit` calls so a test can assert a mutation was audited. */
  rpc?: Record<string, unknown>;
}

export interface FakeClient {
  from(table: string): {
    select(columns?: string): FakeQuery;
    insert(values: Row | Row[]): FakeQuery;
    update(patch: Row): FakeQuery;
  };
  storage: {
    from(bucket: string): {
      createSignedUploadUrl(
        path: string,
      ): Promise<Result<{ signedUrl: string; token: string; path: string } | null>>;
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<Result<{ signedUrl: string } | null>>;
      download(path: string): Promise<Result<Blob | null>>;
    };
  };
  rpc(name: string, args: Row): Promise<Result<unknown>>;
  /** Test-only inspection. */
  readonly db: FakeDatabase;
  readonly signedUrlRequests: { path: string; expiresIn: number | null }[];
  readonly rpcCalls: { name: string; args: Row }[];
}

export function createFakeClient(db: FakeDatabase, options: FakeClientOptions = {}): FakeClient {
  const signedUrlRequests: { path: string; expiresIn: number | null }[] = [];
  const rpcCalls: { name: string; args: Row }[] = [];
  const storage = options.storage ?? {};

  return {
    db,
    signedUrlRequests,
    rpcCalls,

    from(table: string) {
      return {
        select: (columns?: string) => new FakeQuery(db, table, 'select').select(columns),
        insert: (values: Row | Row[]) =>
          new FakeQuery(db, table, 'insert', {
            inserts: Array.isArray(values) ? values : [values],
          }),
        update: (patch: Row) => new FakeQuery(db, table, 'update', { patch }),
      };
    },

    storage: {
      from(bucket: string) {
        return {
          async createSignedUploadUrl(path: string) {
            signedUrlRequests.push({ path, expiresIn: null });
            if (storage.signingError)
              return { data: null, error: { code: '', message: storage.signingError.message } };
            return {
              data: {
                signedUrl:
                  storage.signedUploadUrl ??
                  `https://storage.test/object/upload/sign/${bucket}/${path}?token=upload-token`,
                token: 'upload-token',
                path,
              },
              error: null,
            };
          },
          async createSignedUrl(path: string, expiresIn: number) {
            signedUrlRequests.push({ path, expiresIn });
            if (storage.signingError)
              return { data: null, error: { code: '', message: storage.signingError.message } };
            return {
              data: {
                signedUrl:
                  storage.signedDownloadUrl ??
                  `https://storage.test/object/sign/${bucket}/${path}?token=download-token`,
              },
              error: null,
            };
          },
          async download(path: string) {
            const bytes = storage.objects?.[path];
            if (!bytes) {
              return {
                data: null,
                error: {
                  code: '404',
                  message: 'Object not found',
                  statusCode: '404',
                } as PostgrestLikeError,
              };
            }
            return { data: new Blob([bytes as unknown as BlobPart]), error: null };
          },
        };
      },
    },

    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args });
      return { data: options.rpc?.[name] ?? null, error: null };
    },
  };
}

/* ------------------------------------------------------------ or-expression -- */

/** Splits `a,b,and(c,d)` on top-level commas only. */
function splitTopLevel(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of expression) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function parseClause(clause: string): Filter {
  const trimmed = clause.trim();

  if (trimmed.startsWith('and(') && trimmed.endsWith(')')) {
    const inner = splitTopLevel(trimmed.slice(4, -1)).map(parseClause);
    return (row) => inner.every((predicate) => predicate(row));
  }

  const firstDot = trimmed.indexOf('.');
  const secondDot = trimmed.indexOf('.', firstDot + 1);
  if (firstDot < 0 || secondDot < 0) throw new Error(`unsupported or-clause: ${clause}`);

  const column = trimmed.slice(0, firstDot);
  const operator = trimmed.slice(firstDot + 1, secondDot);
  const value = trimmed.slice(secondDot + 1);

  switch (operator) {
    case 'is':
      if (value !== 'null') throw new Error(`unsupported is-value: ${value}`);
      return (row) => row[column] === null || row[column] === undefined;
    case 'eq':
      return (row) => String(row[column]) === value;
    case 'lt':
      return (row) => row[column] != null && String(row[column]) < value;
    case 'lte':
      return (row) => row[column] != null && String(row[column]) <= value;
    default:
      throw new Error(`unsupported or-operator: ${operator}`);
  }
}
