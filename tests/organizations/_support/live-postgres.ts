/**
 * A direct-Postgres runner for this lane's live test. Lane w1-l1 test support.
 *
 * **Why this exists when `tests/_harness/**` already has a pg driver.** w0-l6's driver
 * is built around that lane's ten-principal fixture world and its policy-coverage
 * report, both of which are still in flight, and it is not this lane's file. This runner
 * is twenty lines of process plumbing and no contract: no schema, no type, no enum, no
 * error code is redefined here, so it duplicates nothing CLAUDE.md rule 4 protects. If
 * the two ever disagree about what Postgres said, Postgres is still the arbiter.
 *
 * **Why `psql` and not a driver.** `pg` is not in the frozen §5.1 dependency list and no
 * lane may install one. `.env.local` has no anon or service-role key either, so
 * `@supabase/supabase-js` cannot authenticate against the project at all. What it *does*
 * have is `DATABASE_URL` and the Supavisor credentials, and `psql` is on the path — so
 * the one transport available is also the one that reaches RLS most directly.
 *
 * **How a principal is impersonated.** Exactly the way PostgREST does it:
 *
 *     set local role authenticated;
 *     select set_config('request.jwt.claims',
 *       json_build_object('sub', <auth_user_id>, 'role', 'authenticated')::text, true);
 *
 * `auth.uid()` reads `request.jwt.claims->>'sub'`, so `current_profile_id()`,
 * `has_org_role()` and every policy predicate resolve through the same code path a real
 * JWT takes. The session role is reset at the end of each transaction.
 *
 * **The rule that makes the whole file meaningful:** an assertion must never run as the
 * table owner. The owner bypasses RLS, so an assertion made as the owner would pass
 * against a database with no policies at all. `asOwner` exists only for fixtures and
 * cleanup, and no test below asserts a *permission* through it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..');

export interface PostgresEnvironment {
  host: string;
  port: string;
  user: string;
  database: string;
  password: string;
}

/** The result of one statement batch. `code` is the SQLSTATE when it failed. */
export interface SqlResult {
  ok: boolean;
  /** The last non-empty line of tuple output — the value the batch selected. */
  value: string;
  lines: string[];
  code: string | null;
  /** The leading `snake_case` token of a `0003` exception, when there is one. */
  token: string | null;
  message: string;
}

/** Reads the connection out of `.env.local`. No value is ever printed or logged. */
export function readPostgresEnvironment(): PostgresEnvironment | null {
  const path = resolve(ROOT, '.env.local');
  if (!existsSync(path)) return null;

  const values: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }

  const host = values.SUPABASE_DB_HOST;
  const port = values.SUPABASE_DB_PORT;
  const user = values.SUPABASE_DB_USER;
  const database = values.SUPABASE_DB_NAME;
  const password = values.SUPABASE_DB_PASSWORD;
  if (!host || !port || !user || !database || !password) return null;

  return { host, port, user, database, password };
}

/** Is a live run possible at all? Used to decide whether to skip rather than fail. */
export function liveRunPossible(): boolean {
  if (!readPostgresEnvironment()) return false;
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one statement batch and returns what Postgres said.
 *
 * `VERBOSITY=verbose` makes psql prefix an error with its SQLSTATE, which several
 * assertions check exactly — amendment A2 maps `42501` to 403 and `P0001` to 409, and a
 * test that only matched on the message text would not notice the mapping changing.
 */
export function createRunner(connection: PostgresEnvironment) {
  const environment = {
    ...process.env,
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGDATABASE: connection.database,
    PGPASSWORD: connection.password,
    PGCONNECT_TIMEOUT: '30',
    PGAPPNAME: 'propertysuite-w1l1-live',
    PGCLIENTENCODING: 'UTF8',
  };

  function run(statement: string): SqlResult {
    try {
      const stdout = execFileSync(
        'psql',
        [
          '--no-psqlrc',
          '-q',
          '-A',
          '-t',
          '-v',
          'VERBOSITY=verbose',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          statement,
        ],
        { encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        ok: true,
        value: lines[lines.length - 1] ?? '',
        lines,
        code: null,
        token: null,
        message: '',
      };
    } catch (thrown) {
      const stderr = String((thrown as { stderr?: unknown }).stderr ?? '');
      // `ERROR:  42501: member_invite_forbidden: only an organization_admin may ...`
      const detail = /ERROR:\s+([0-9A-Z]{5}):\s*(.*)/.exec(stderr);
      const message = detail?.[2] ?? stderr.split(/\r?\n/)[0] ?? 'unknown failure';
      return {
        ok: false,
        value: '',
        lines: [],
        code: detail?.[1] ?? null,
        token: /^([a-z][a-z0-9_]{3,63}):/.exec(message)?.[1] ?? null,
        message,
      };
    }
  }

  /**
   * Runs `body` as `authenticated`, carrying `authUserId` as the JWT subject.
   *
   * Committed, because the lifecycle under test spans several calls and a rolled-back
   * invitation cannot be accepted by the next one. Cleanup is explicit instead.
   */
  function asPrincipal(authUserId: string, body: string): SqlResult {
    return run(
      [
        'begin',
        'set local role authenticated',
        `select set_config('request.jwt.claims', json_build_object('sub', ${literal(authUserId)}, 'role', 'authenticated')::text, true)`,
        body,
        'reset role',
        'commit',
      ].join('; '),
    );
  }

  /** Fixtures and cleanup only. **Never an assertion** — the owner bypasses RLS. */
  function asOwner(body: string): SqlResult {
    return run(body);
  }

  return { run, asPrincipal, asOwner };
}

/** A SQL string literal with quotes doubled. Values here are test-authored, not input. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The last line of tuple output, parsed as the JSON an RPC returned. */
export function jsonValue<T>(result: SqlResult): T {
  return JSON.parse(result.value) as T;
}
