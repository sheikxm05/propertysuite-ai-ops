/**
 * A scriptable Supabase double for the AI route tests. Lane w1-l5.
 *
 * WHY A DOUBLE AND NOT THE REAL CLIENT
 * ------------------------------------
 * `tests/_harness/**` (lane w0-l6) provides the real thing, and the RLS suite uses it —
 * correctly, because a claim about a *policy* can only be proven against Postgres. These
 * tests make a different kind of claim: that the handler never *attempts* a privileged
 * write. That is a statement about which calls are issued, and a double is the only way
 * to observe calls that must not happen. A real client would prove the opposite thing —
 * that the database refused — which is already the RLS suite's job.
 *
 * The double therefore **records every operation** and answers from a script. Nothing in
 * here is authorization: a test that asserted "the tenant could not read X" against this
 * object would be asserting what the script said, which is why these tests only assert
 * call shape and never assert isolation.
 */

export interface RecordedOperation {
  readonly table: string;
  readonly op: 'select' | 'insert' | 'rpc';
  readonly filters: Readonly<Record<string, unknown>>;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly args?: Readonly<Record<string, unknown>>;
}

export type Row = Record<string, unknown>;

export interface SupabaseScript {
  /** Rows a `select` on `table` returns. Filters are passed for inspection, not applied. */
  select?: (table: string, filters: Record<string, unknown>) => Row[];
  /** The row an `insert` returns. Defaults to the inserted values plus a generated id. */
  insert?: (table: string, values: Row) => Row;
  /** An `rpc` result. Defaults to `true`, which is what `can_access_unit` returns on success. */
  rpc?: (fn: string, args: Record<string, unknown>) => unknown;
}

export interface FakeSupabase {
  /** Every operation issued, in order. The assertion surface of these tests. */
  readonly operations: readonly RecordedOperation[];
  /** Tables an `insert` was attempted on. */
  insertedTables(): string[];
  from(table: string): QueryBuilder;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: null }>;
}

interface Result {
  data: unknown;
  error: { code: string } | null;
  count?: number | null;
}

class QueryBuilder implements PromiseLike<Result> {
  private op: 'select' | 'insert' | null = null;
  private readonly filters: Record<string, unknown> = {};
  private values: Row | null = null;
  private wantCount = false;
  private headOnly = false;
  private cardinality: 'many' | 'maybe' | 'one' = 'many';

  constructor(
    private readonly table: string,
    private readonly sink: RecordedOperation[],
    private readonly script: SupabaseScript,
  ) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (this.op === null) this.op = 'select';
    if (options?.count) this.wantCount = true;
    if (options?.head) this.headOnly = true;
    return this;
  }

  insert(values: Row): this {
    this.op = 'insert';
    this.values = values;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters[column] = value;
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters[column] = [...values];
    return this;
  }

  order(): this {
    return this;
  }

  maybeSingle(): this {
    this.cardinality = 'maybe';
    return this;
  }

  single(): this {
    this.cardinality = 'one';
    return this;
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): Result {
    if (this.op === 'insert') {
      const values = this.values ?? {};
      this.sink.push({ table: this.table, op: 'insert', filters: { ...this.filters }, values });
      const row = this.script.insert?.(this.table, values) ?? {
        id: `generated-${this.table}-id`,
        ...values,
      };
      return { data: this.cardinality === 'many' ? [row] : row, error: null };
    }

    this.sink.push({ table: this.table, op: 'select', filters: { ...this.filters } });
    const rows = this.script.select?.(this.table, { ...this.filters }) ?? [];

    if (this.wantCount || this.headOnly) {
      return { data: this.headOnly ? null : rows, error: null, count: rows.length };
    }
    if (this.cardinality === 'many') return { data: rows, error: null };

    const first = rows[0] ?? null;
    if (first === null && this.cardinality === 'one') {
      return { data: null, error: { code: 'PGRST116' } };
    }
    return { data: first, error: null };
  }
}

/** Builds a recording, scripted client. Cast at the call site: it is a double, not a client. */
export function createFakeSupabase(script: SupabaseScript = {}): FakeSupabase {
  const operations: RecordedOperation[] = [];

  return {
    operations,
    insertedTables: () =>
      operations.filter((entry) => entry.op === 'insert').map((entry) => entry.table),
    from: (table: string) => new QueryBuilder(table, operations, script),
    rpc: (fn: string, args: Record<string, unknown> = {}) => {
      operations.push({ table: `rpc:${fn}`, op: 'rpc', filters: {}, args });
      const data = script.rpc ? script.rpc(fn, args) : true;
      return Promise.resolve({ data, error: null });
    },
  };
}
