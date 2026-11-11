/**
 * Direct-Postgres driver. Lane w0-l6.
 *
 * Impersonates a principal the way PostgREST does, then rolls the statement back:
 *
 *   begin                                              -- one transaction per operation
 *   set local statement_timeout = '30s'
 *   set local role authenticated                       -- RLS now applies to us
 *   select set_config('request.jwt.claims', {...}, true)   -- auth.uid() reads this
 *   do $$ ... <the statement, errors caught> ... $$
 *   select '__RESULT__' || current_setting('ps.result', true)
 *   rollback                                           -- the database is left as found
 *
 * Joined with psql's `\;` so the whole thing is a single round trip (see psql.ts for
 * why that matters: 0.3 s versus 6 s for the same work).
 *
 * The rollback is not just hygiene. This driver runs against a real cloud project, not
 * a disposable container, so no assertion may leave a row behind. It also makes every
 * run idempotent: an allowed INSERT is proven by its RETURNING clause inside the
 * transaction and then undone, so a second run starts from the same state.
 *
 * The exception handler is what makes the result trustworthy. `sqlstate` is captured in
 * SQL and returned in the payload, so `expectInsertDenied` can insist on 42501 and
 * distinguish a real authorization refusal from a bad fixture payload — which is the
 * difference between a test that proves something and a test that looks like it does.
 */

import type {
  DbError,
  DbResult,
  Principal,
  QueryOptions,
  RlsDriver,
  SetupClient,
  UpsertOptions,
} from './driver';
import type { MemberRole, OrgKey, PrincipalDescriptor } from './jwt-factory';
import { loadJwtFactory } from './jwt-factory';
import {
  PsqlSession,
  resolvePostgresConnection,
  PostgresUnavailableError,
  type PostgresConnection,
  type PsqlOutput,
} from './psql';
import {
  deleteStatement,
  insertStatement,
  lit,
  qualify,
  quote,
  selectStatement,
  updateStatement,
  upsertStatements,
  whereClause,
  type Row,
} from './sql';

/** A statement, and how its rows should be collected. */
type Shape = 'query' | 'command';

/**
 * Wraps a statement so that its rows come back as JSON and its failure comes back as a
 * structured error rather than as a stderr line nobody can correlate.
 *
 * `select ... into v from (<stmt>) t` cannot host a data-modifying CTE in a sub-SELECT,
 * so a RETURNING statement is collected with `with __t as (...) select ... from __t`,
 * which is legal at the top level of a PL/pgSQL SELECT INTO.
 */
function wrap(
  statement: string,
  shape: Shape,
  modifying: boolean,
  leading: readonly string[] = [],
): string {
  // jsonb_agg, not json_agg: `json_agg` pretty-prints and puts a newline between
  // elements, which would split a multi-row result across lines and break the
  // one-line-per-result wire format. jsonb_agg emits compact output.
  const collect = modifying
    ? `with __t as (${statement}) select coalesce(jsonb_agg(__t)::text, '[]') into v from __t`
    : `select coalesce(jsonb_agg(__t)::text, '[]') into v from (${statement}) __t`;

  const body = shape === 'command' ? `execute ${quote(statement)}; v := '[]';` : `${collect};`;

  // Leading statements share the single exception handler below. The first failure
  // aborts the block, rolls back everything in it, and is the error that gets reported.
  // Giving each statement its own handler — the first shape of this function — meant
  // only the LAST statement's outcome was ever read, so a seeding error in any earlier
  // statement was swallowed and surfaced later as a bogus "the trigger disagrees with
  // the state machine".
  const preamble = leading.map((s) => `  execute ${quote(s)};`);

  return [
    'do $ps_do$',
    'declare v text;',
    'begin',
    ...preamble,
    `  ${body}`,
    `  perform set_config('ps.result', v, true);`,
    'exception when others then',
    "  perform set_config('ps.result',",
    "    json_build_object('__error__',",
    "      json_build_object('code', sqlstate, 'message', sqlerrm))::text, true);",
    'end',
    '$ps_do$',
  ].join('\n');
}

interface ParsedPayload {
  data: Row[] | null;
  error: DbError | null;
}

function parsePayload(out: PsqlOutput): ParsedPayload {
  if (out.payload === undefined) {
    const detail = (out.stderr || out.stdout || '').trim().slice(0, 600);
    throw new PostgresUnavailableError(
      `The psql batch produced no result payload. This is a harness fault, not an RLS ` +
        `outcome, so it is raised rather than reported as a denial.\n${detail}`,
    );
  }
  const raw = out.payload.trim();
  if (raw === '' || raw === '<<missing>>') {
    return { data: [], error: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PostgresUnavailableError(`Could not parse the psql payload: ${raw.slice(0, 400)}`);
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && '__error__' in parsed) {
    const err = (parsed as { __error__: { code: string; message: string } }).__error__;
    return { data: null, error: { code: err.code, message: err.message } };
  }
  return { data: Array.isArray(parsed) ? (parsed as Row[]) : [], error: null };
}

const CLAIMS_TAG = '$ps_claims$';

/** The same claim set PostgREST puts on the connection for a signed-in user. */
function claimsFor(authUserId: string): string {
  const claims = JSON.stringify({
    sub: authUserId,
    role: 'authenticated',
    aud: 'authenticated',
  });
  return `select set_config('request.jwt.claims', ${CLAIMS_TAG}${claims}${CLAIMS_TAG}, true)`;
}

interface PgIdentity {
  key: string;
  org: OrgKey;
  role: MemberRole | 'anon';
  /** Absent for the anonymous caller, which has no identity to attach. */
  authUserId?: string;
  sessionRole: 'authenticated' | 'anon';
}

class PgPrincipal implements Principal {
  constructor(
    private readonly session: PsqlSession,
    private readonly descriptor: PgIdentity,
  ) {}

  get key(): string {
    return this.descriptor.key;
  }
  get org(): OrgKey {
    return this.descriptor.org;
  }
  get role(): MemberRole | 'anon' {
    return this.descriptor.role;
  }
  describe(): string {
    return `${this.descriptor.role} of organization ${this.descriptor.org} (${this.descriptor.key})`;
  }

  private async act(statement: string, shape: Shape, modifying: boolean): Promise<DbResult> {
    const batch = [
      'begin',
      "set local statement_timeout = '30s'",
      // Fail fast and legibly on contention. Without this, a lock held by a leftover
      // session shows up 30 seconds later as a statement timeout that escapes the
      // PL/pgSQL handler (a cancellation is not reliably catchable), which then looks
      // like a database fault rather than "something else is holding a lock".
      "set local lock_timeout = '10s'",
      // Everything after this line runs with RLS in force. Nothing before it asserts.
      `set local role ${this.descriptor.sessionRole}`,
      ...(this.descriptor.authUserId ? [claimsFor(this.descriptor.authUserId)] : []),
      wrap(statement, shape, modifying),
      'reset role',
      `select '__RESULT__' || coalesce(current_setting('ps.result', true), '<<missing>>')`,
      'rollback',
    ].join('\n\\;\n');

    const out = await this.session.run(batch);
    if (out.payload === undefined) {
      // The batch died before reaching its `rollback`, so the session is sitting in a
      // failed transaction and every later operation would fail with 25P02. Clear it,
      // then report. Recovering matters: otherwise one timeout cascades into dozens of
      // bogus failures and the real cause scrolls off the top.
      await this.session.recover();
    }
    return parsePayload(out);
  }

  select(table: string, options: QueryOptions = {}): Promise<DbResult> {
    return this.act(
      selectStatement(table, { ...options, columns: options.columns ?? 'id' }),
      'query',
      false,
    );
  }

  insert(table: string, row: Row, returning = 'id'): Promise<DbResult> {
    return this.act(insertStatement(table, row, returning), 'query', true);
  }

  update(table: string, patch: Row, eq: Row, returning = 'id'): Promise<DbResult> {
    return this.act(updateStatement(table, patch, eq, returning), 'query', true);
  }

  remove(table: string, eq: Row, returning = 'id'): Promise<DbResult> {
    return this.act(deleteStatement(table, eq, returning), 'query', true);
  }

  truncate(table: string): Promise<DbResult> {
    return this.act(`truncate table ${qualify(table)}`, 'command', false);
  }
}

class PgSetup implements SetupClient {
  constructor(private readonly session: PsqlSession) {}

  /** Owner-role statements, committed. Fixture setup only — never an assertion. */
  private async run(statements: string[], shape: Shape = 'query'): Promise<DbResult> {
    if (statements.length === 0) return { data: [], error: null };
    const last = statements[statements.length - 1] as string;
    const leading = statements.slice(0, -1);

    const batch = [
      'begin',
      "set local statement_timeout = '60s'",
      wrap(last, shape, /returning/i.test(last), leading),
      `select '__RESULT__' || coalesce(current_setting('ps.result', true), '<<missing>>')`,
      'commit',
    ].join('\n\\;\n');

    const out = await this.session.run(batch);
    if (out.payload === undefined) await this.session.recover();
    return parsePayload(out);
  }

  async upsert(table: string, rows: Row[], options: UpsertOptions = {}): Promise<void> {
    if (rows.length === 0) return;
    const statements = upsertStatements(
      table,
      rows,
      options.conflictColumn ?? 'id',
      options.ignoreDuplicates ?? false,
    );
    const result = await this.run(statements, 'command');
    if (result.error) {
      throw new Error(
        `Fixture seeding failed on ${table}: ${result.error.code} ${result.error.message}\n` +
          'This is a seeding failure, not an RLS result. Check that all three migrations ' +
          'are applied.',
      );
    }
  }

  insert(table: string, row: Row): Promise<DbResult> {
    return this.run([insertStatement(table, row, 'id')]);
  }

  update(table: string, patch: Row, eq: Row): Promise<DbResult> {
    return this.run([updateStatement(table, patch, eq, 'id')]);
  }

  remove(table: string, eq: Row): Promise<DbResult> {
    return this.run([deleteStatement(table, eq, 'id')]);
  }

  select(table: string, options: QueryOptions = {}): Promise<DbResult> {
    return this.run([selectStatement(table, { ...options, columns: options.columns ?? 'id' })]);
  }

  async hasColumn(table: string, column: string): Promise<boolean> {
    const [schema, name] = table.includes('.') ? table.split('.') : ['public', table];
    const result = await this.run([
      `select 1 as present from information_schema.columns where table_schema = ${lit(
        schema,
      )} and table_name = ${lit(name)} and column_name = ${lit(column)}`,
    ]);
    return (result.data ?? []).length > 0;
  }

  /** Raw owner-side statement. Used by the storage fixture, which PostgREST cannot seed. */
  raw(statement: string): Promise<DbResult> {
    return this.run([statement], /returning/i.test(statement) ? 'query' : 'command');
  }
}

export class PgDriver implements RlsDriver {
  readonly name = 'pg' as const;
  /** PostgREST is not in play, so signed URLs and expiry cannot be exercised. */
  readonly supportsHttpStorage = false;

  private readonly session: PsqlSession;
  private readonly connection: PostgresConnection;
  private readonly setupClient: PgSetup;
  private principals: Map<string, PrincipalDescriptor & { authUserId: string }> | undefined;

  constructor() {
    this.connection = resolvePostgresConnection();
    this.session = new PsqlSession(this.connection);
    this.setupClient = new PgSetup(this.session);
  }

  describe(): string {
    return (
      `pg driver — psql to ${this.connection.user}@${this.connection.host}:${this.connection.port}/` +
      `${this.connection.database}, impersonating via set local role authenticated`
    );
  }

  async preflight(): Promise<void> {
    const probe = await this.setupClient.select('organizations', { columns: 'id', limit: 1 });
    if (probe.error) {
      throw new PostgresUnavailableError(
        `Connected, but could not read public.organizations: ${probe.error.code} ` +
          `${probe.error.message}. Are the migrations applied?`,
      );
    }

    // Prove the impersonation path works before 900 assertions depend on it. If
    // `set local role authenticated` silently did nothing, every test would run as the
    // table owner, RLS would be bypassed, and the whole suite would pass meaninglessly.
    const identity = await this.session.run(
      [
        'begin',
        'set local role authenticated',
        claimsFor('00000000-0000-4000-8000-000000000000'),
        wrap(
          `select current_user as who, coalesce((select auth.uid())::text, '<null>') as uid`,
          'query',
          false,
        ),
        'reset role',
        `select '__RESULT__' || coalesce(current_setting('ps.result', true), '<<missing>>')`,
        'rollback',
      ].join('\n\\;\n'),
    );
    const parsed = parsePayload(identity);
    const row = (parsed.data ?? [])[0] as { who?: string; uid?: string } | undefined;
    if (parsed.error || row?.who !== 'authenticated') {
      throw new PostgresUnavailableError(
        'Could not impersonate `authenticated`. Every assertion would then run as the ' +
          'table owner, which bypasses RLS and would make the entire suite pass ' +
          `meaninglessly. Got: ${JSON.stringify(parsed.error ?? row)}`,
      );
    }
    if (row.uid !== '00000000-0000-4000-8000-000000000000') {
      throw new PostgresUnavailableError(
        `auth.uid() did not read request.jwt.claims->>'sub' (got ${String(row.uid)}). ` +
          'Principal identity would be absent and every scoped policy would deny.',
      );
    }
  }

  setup(): SetupClient {
    return this.setupClient;
  }

  /** Owner-side escape hatch for fixtures PostgREST cannot write (storage.objects). */
  rawSetup(): PgSetup {
    return this.setupClient;
  }

  /**
   * Creates the auth.users rows the principals need, idempotently, and adopts the
   * deterministic profile ids.
   *
   * 0003 creates a profile from an `auth.users` AFTER INSERT trigger with a generated
   * id, so the row is re-pointed at this lane's deterministic id immediately after
   * insert, while nothing references it yet. Without that, the fixture's own profile
   * upsert would collide on the unique `auth_user_id`.
   */
  async ensurePrincipals(): Promise<Map<string, PrincipalDescriptor & { authUserId: string }>> {
    if (this.principals) return this.principals;
    const factory = await loadJwtFactory();
    const resolved = new Map<string, PrincipalDescriptor & { authUserId: string }>();

    for (const p of factory.PRINCIPALS) {
      const authUserId = factory.fixtureId(`auth-user:${p.key}`);
      const statements = [
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
           email_confirmed_at, created_at, updated_at, raw_user_meta_data)
         values (${lit(authUserId)}, '00000000-0000-0000-0000-000000000000',
           'authenticated', 'authenticated', ${lit(p.email)}, ${lit('fixture-not-a-password')},
           now(), now(), now(), ${lit({ full_name: p.fullName, fixture_key: p.key })})
         on conflict (id) do nothing`,
        `update public.profiles set id = ${lit(p.profileId)}
           where auth_user_id = ${lit(authUserId)} and id <> ${lit(p.profileId)}`,
      ];
      const result = await this.setupClient.raw(statements.join(';\n'));
      if (result.error) {
        throw new Error(
          `Could not create the auth user for ${p.key}: ${result.error.code} ` +
            `${result.error.message}`,
        );
      }
      resolved.set(p.key, { ...p, authUserId });
    }

    this.principals = resolved;
    return resolved;
  }

  async ensureAuthUsers(): Promise<Map<string, string>> {
    const principals = await this.ensurePrincipals();
    return new Map([...principals.values()].map((p) => [p.key, p.authUserId]));
  }

  /**
   * Seeds `storage.objects` directly. There is no Storage HTTP API in play here, and
   * the storage policies are plain RLS on that table, so a row is all the suite needs
   * to ask "may this principal see this path?".
   */
  async seedStorageObjects(
    bucket: string,
    fixture: { A: { objects: Record<string, string> }; B: { objects: Record<string, string> } },
  ): Promise<{ seeded: boolean; reason?: string }> {
    const paths = [...Object.values(fixture.A.objects), ...Object.values(fixture.B.objects)];
    for (const path of paths) {
      const result = await this.setupClient.raw(
        // `on conflict do nothing` with no target on purpose: storage.objects enforces
        // its (bucket_id, name) uniqueness through an index whose definition has
        // changed across Supabase versions, and naming a target that does not match it
        // exactly fails with 42P10. Targetless DO NOTHING swallows any unique
        // violation, which is all the fixture needs.
        `insert into storage.objects (bucket_id, name, owner, metadata)
         values (${lit(bucket)}, ${lit(path)}, null, ${lit({ mimetype: 'application/pdf', size: 23 })})
         on conflict do nothing`,
      );
      if (result.error) {
        return {
          seeded: false,
          reason: `${path}: ${result.error.code} ${result.error.message}`,
        };
      }
    }
    return { seeded: true };
  }

  async principal(key: string): Promise<Principal> {
    const principals = await this.ensurePrincipals();
    const descriptor = principals.get(key);
    if (!descriptor) throw new Error(`Unknown principal ${key}`);
    return new PgPrincipal(this.session, {
      key: descriptor.key,
      org: descriptor.org,
      role: descriptor.role,
      authUserId: descriptor.authUserId,
      sessionRole: 'authenticated',
    });
  }

  anonymous(): Promise<Principal> {
    // `set local role anon` with no claims: exactly what PostgREST does for a request
    // carrying only the anon key.
    return Promise.resolve(
      new PgPrincipal(this.session, {
        key: 'anon',
        org: 'A',
        role: 'anon',
        sessionRole: 'anon',
      }),
    );
  }

  async dispose(): Promise<void> {
    await this.session.close();
  }
}

export { whereClause };
