/**
 * A deliberately stupid PostgREST double.
 *
 * What it does: records the statement a repository function built — table, kind,
 * filters, ordering, limit, inserted values — and returns whatever the test told it to
 * return. What it does NOT do: evaluate a filter, apply row-level security, or decide
 * anything.
 *
 * That split is the point, and it is why this is not "mocking away the thing under
 * test". The things under test in this suite are the decisions my lane makes:
 *
 *   which filters a role's list query carries        (acceptance criterion 7)
 *   which transitions are refused, and with which status code
 *   which columns a role may write
 *   how many activity rows a transition produces
 *   whether a derived `(property_id, property_unit_id)` pair can ever disagree
 *
 * Every one of those is observable in the recorded statement or in the thrown error, and
 * none of them depends on the database behaving in any particular way. A fake that
 * *implemented* filtering could let a missing `.eq('assigned_provider_id', ...)` pass by
 * returning the right rows for the wrong reason; this one cannot, because it returns
 * exactly what the test said regardless of the filters — so the only way to assert
 * provider isolation is to assert the filter itself.
 *
 * WHAT THIS SUITE CANNOT PROVE, stated plainly: that Postgres enforces the same rules.
 * The RLS policies, the `enforce_ticket_transition()` trigger and the append-only
 * guarantee on `maintenance_activities` are the second enforcement layer and are proven
 * against a real database by `tests/rls/**` (lane w0-l6). At the time this lane was
 * written the anon and service_role keys for the live project were not available, so
 * supabase-js could not authenticate and no HTTP-level test against the real policies
 * was possible from here. Those assertions belong in the RLS suite anyway: a feature
 * lane proving its own RLS with its own fixtures would be proving its fixtures.
 */

export type StatementKind = 'select' | 'insert' | 'update';

export interface RecordedFilter {
  op: 'eq' | 'neq' | 'in' | 'is' | 'gt' | 'lt' | 'gte' | 'lte';
  column: string;
  value: unknown;
}

export interface RecordedStatement {
  table: string;
  kind: StatementKind;
  columns: string | null;
  /** True when the caller asked for a count (`{ count: 'exact' }`). */
  counted: boolean;
  filters: RecordedFilter[];
  /** Raw `.or(...)` expressions, which is how the keyset cursor is applied. */
  or: string[];
  order: { column: string; ascending: boolean }[];
  limit: number | null;
  /** Rows handed to `.insert()`, always normalised to an array. */
  values: Record<string, unknown>[];
  /** The object handed to `.update()`. */
  patch: Record<string, unknown> | null;
  cardinality: 'many' | 'single' | 'maybeSingle';
}

export interface FakeResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

/** Decides what a statement returns. Receives the fully built statement. */
export type Responder = (statement: RecordedStatement) => FakeResult;

export interface FakePostgrest {
  /** Every statement issued, in order. */
  readonly statements: RecordedStatement[];
  /** Statements against one table, optionally of one kind. */
  on(table: string, kind?: StatementKind): RecordedStatement[];
  /** The value to hand to a repository function. */
  client: unknown;
}

/**
 * Builds the double.
 *
 * `responder` is called once per statement, at the moment the statement is awaited, so
 * it can branch on the filters it sees — which is how a test models "`findTicket`
 * returns this row, `findUnit` returns that one" without the fake knowing anything about
 * either.
 */
export function fakePostgrest(responder: Responder): FakePostgrest {
  const statements: RecordedStatement[] = [];

  const client = {
    from(table: string) {
      return new StatementBuilder(table, statements, responder);
    },
  };

  return {
    statements,
    on(table, kind) {
      return statements.filter((s) => s.table === table && (kind === undefined || s.kind === kind));
    },
    client,
  };
}

/** Chainable, thenable, and mutates one `RecordedStatement` — exactly like PostgREST. */
class StatementBuilder implements PromiseLike<FakeResult> {
  private readonly statement: RecordedStatement;

  constructor(
    table: string,
    private readonly sink: RecordedStatement[],
    private readonly responder: Responder,
  ) {
    this.statement = {
      table,
      kind: 'select',
      columns: null,
      counted: false,
      filters: [],
      or: [],
      order: [],
      limit: null,
      values: [],
      patch: null,
      cardinality: 'many',
    };
  }

  select(columns?: string, options?: { count?: string; head?: boolean }): this {
    this.statement.columns = columns ?? null;
    if (options?.count) this.statement.counted = true;
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.statement.kind = 'insert';
    this.statement.values = Array.isArray(values) ? values : [values];
    return this;
  }

  update(patch: Record<string, unknown>): this {
    this.statement.kind = 'update';
    this.statement.patch = patch;
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.filter('eq', column, value);
  }
  neq(column: string, value: unknown): this {
    return this.filter('neq', column, value);
  }
  in(column: string, value: unknown): this {
    return this.filter('in', column, value);
  }
  is(column: string, value: unknown): this {
    return this.filter('is', column, value);
  }
  gt(column: string, value: unknown): this {
    return this.filter('gt', column, value);
  }
  lt(column: string, value: unknown): this {
    return this.filter('lt', column, value);
  }

  or(expression: string): this {
    this.statement.or.push(expression);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.statement.order.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number): this {
    this.statement.limit = count;
    return this;
  }

  single(): Promise<FakeResult> {
    this.statement.cardinality = 'single';
    return this.settle();
  }

  maybeSingle(): Promise<FakeResult> {
    this.statement.cardinality = 'maybeSingle';
    return this.settle();
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.settle().then(onFulfilled, onRejected);
  }

  private filter(op: RecordedFilter['op'], column: string, value: unknown): this {
    this.statement.filters.push({ op, column, value });
    return this;
  }

  /** Records the statement, then asks the responder. Recording first so a throwing
   *  responder still leaves the statement visible to the test. */
  private async settle(): Promise<FakeResult> {
    this.sink.push(this.statement);
    const result = this.responder(this.statement);
    return {
      data: result.data ?? null,
      error: result.error ?? null,
      count: result.count ?? null,
    };
  }
}

/* ------------------------------------------------------------------ helpers -- */

/** The value of an `eq` filter on `column`, or `undefined`. */
export function eqValue(statement: RecordedStatement, column: string): unknown {
  return statement.filters.find((f) => f.op === 'eq' && f.column === column)?.value;
}

/** The value of the `in` filter on `column`, or `undefined`. */
export function inValues(statement: RecordedStatement, column: string): unknown {
  return statement.filters.find((f) => f.op === 'in' && f.column === column)?.value;
}
