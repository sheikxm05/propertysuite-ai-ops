/**
 * SQL literal and statement construction for the direct-Postgres driver. Lane w0-l6.
 *
 * Only ever used to build the *same* operations the supabase-js driver issues, so the
 * two transports stay behaviourally identical. Nothing here is reachable from
 * application code.
 *
 * Values are inlined as literals rather than bound as parameters because the transport
 * is `psql` reading a script, which has no bind protocol. Every value therefore goes
 * through `lit()`, and every identifier through `ident()`. Fixture data is written by
 * this lane and contains no user input, but the escaping is still exact: a test harness
 * that mangles an apostrophe produces a failing assertion that looks like a security
 * finding.
 */

/** A single-quoted literal with embedded quotes doubled. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A double-quoted identifier. Table and column names only. */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Refusing to build SQL with a suspicious identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * JS value to SQL literal. Deliberately conservative: numbers are quoted too, because
 * `numeric(12,2)` columns are seeded from strings like '95000.00' and Postgres casts a
 * quoted literal to the target column type without any float rounding on the way.
 */
export function lit(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Cannot serialise ${String(value)} to SQL`);
    return quote(String(value));
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `'{}'`;
    return `array[${value.map((v) => lit(v)).join(',')}]`;
  }
  if (value instanceof Date) return quote(value.toISOString());
  if (typeof value === 'object') return `${quote(JSON.stringify(value))}::jsonb`;
  return quote(String(value));
}

/** `public.table`, or `storage.objects` when the name is already schema-qualified. */
export function qualify(table: string): string {
  if (table.includes('.')) {
    const [schema, name] = table.split('.');
    return `${ident(String(schema))}.${ident(String(name))}`;
  }
  return `public.${ident(table)}`;
}

export type Row = Record<string, unknown>;

/** `col = value and col2 = value2`, or `true` when there is no filter. */
export function whereClause(eq: Row | undefined): string {
  const entries = Object.entries(eq ?? {});
  if (entries.length === 0) return 'true';
  return entries
    .map(([col, value]) =>
      value === null ? `${ident(col)} is null` : `${ident(col)} = ${lit(value)}`,
    )
    .join(' and ');
}

/** A column list for a RETURNING or SELECT clause. `*` and comma lists are accepted. */
export function columnList(columns: string | undefined): string {
  const raw = (columns ?? '*').trim();
  if (raw === '*') return '*';
  return raw
    .split(',')
    .map((c) => ident(c.trim()))
    .join(', ');
}

export function selectStatement(
  table: string,
  options: { columns?: string; eq?: Row; limit?: number } = {},
): string {
  const limit = options.limit === undefined ? '' : ` limit ${Math.trunc(options.limit)}`;
  return `select ${columnList(options.columns)} from ${qualify(table)} where ${whereClause(
    options.eq,
  )}${limit}`;
}

export function insertStatement(table: string, row: Row, returning: string): string {
  const cols = Object.keys(row);
  if (cols.length === 0) throw new Error(`Refusing to INSERT an empty row into ${table}`);
  return (
    `insert into ${qualify(table)} (${cols.map((c) => ident(c)).join(', ')}) ` +
    `values (${cols.map((c) => lit(row[c])).join(', ')}) ` +
    `returning ${columnList(returning)}`
  );
}

export function updateStatement(table: string, patch: Row, eq: Row, returning: string): string {
  const sets = Object.entries(patch)
    .map(([col, value]) => `${ident(col)} = ${lit(value)}`)
    .join(', ');
  if (!sets) throw new Error(`Refusing to UPDATE ${table} with an empty patch`);
  return (
    `update ${qualify(table)} set ${sets} where ${whereClause(eq)} ` +
    `returning ${columnList(returning)}`
  );
}

export function deleteStatement(table: string, eq: Row, returning: string): string {
  return `delete from ${qualify(table)} where ${whereClause(eq)} returning ${columnList(
    returning,
  )}`;
}

/**
 * `insert ... on conflict (id) do update set ...` over a set of rows.
 *
 * Fixture seeding only. Deterministic ids plus an upsert are what make a re-run against
 * an un-reset database idempotent instead of a pile of duplicates.
 */
export function upsertStatements(
  table: string,
  rows: Row[],
  conflictColumn = 'id',
  ignoreDuplicates = false,
): string[] {
  return rows.map((row) => {
    const cols = Object.keys(row);
    const updates = cols
      .filter((c) => c !== conflictColumn)
      .map((c) => `${ident(c)} = excluded.${ident(c)}`)
      .join(', ');
    // `do nothing` is not an optimisation for append-only tables, it is the only legal
    // form: maintenance_activities has a trigger that refuses UPDATE outright, so a
    // re-seed that tried to update an existing activity row would be rejected — by the
    // very guarantee the suite is there to assert.
    const doClause = updates && !ignoreDuplicates ? `do update set ${updates}` : 'do nothing';
    return (
      `insert into ${qualify(table)} (${cols.map((c) => ident(c)).join(', ')}) ` +
      `values (${cols.map((c) => lit(row[c])).join(', ')}) ` +
      `on conflict (${ident(conflictColumn)}) ${doClause}`
    );
  });
}
