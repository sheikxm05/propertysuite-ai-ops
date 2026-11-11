/**
 * A persistent `psql` session. Lane w0-l6.
 *
 * `pg` is not in the frozen dependency list (§5.1) and no lane may install one, so the
 * direct-Postgres driver speaks to the database through the `psql` binary. Three
 * measurements against the live Supavisor pooler shaped this file:
 *
 *   - spawn + TLS + pooler auth          ~3.2 s
 *   - twenty statements sent one by one  ~6.0 s  (~0.3 s per round trip)
 *   - twenty statements as ONE batch     ~0.1 s
 *
 * So: one long-lived process for the whole run, and every operation compressed into a
 * single round trip by joining its statements with psql's `\;` batch separator. The
 * naive shape — one `psql -c` per assertion — would have taken over half an hour and
 * produced a gate too slow for anyone to run.
 *
 * Errors are captured SERVER-side, inside a PL/pgSQL exception handler, and returned on
 * stdout as part of the result payload. That matters more than it looks: psql writes
 * errors to stderr, a separate pipe with no ordering guarantee against stdout, so
 * correlating "which of 1,600 operations produced this error" would be guesswork.
 * Catching `sqlstate` in SQL makes the association exact — and this suite cares very
 * much about the exact SQLSTATE.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

export interface PostgresConnection {
  host: string;
  port: string;
  user: string;
  database: string;
  password: string;
}

export class PostgresUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgresUnavailableError';
  }
}

function envFile(name: string): Record<string, string> {
  const path = resolve(ROOT, name);
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/**
 * Resolves connection details from the environment, then `.env.test` / `.env.local`,
 * then `DATABASE_URL`. Never logs, returns or stringifies the password.
 */
export function resolvePostgresConnection(): PostgresConnection {
  const files = { ...envFile('.env.test'), ...envFile('.env.local') };
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = process.env[name] || files[name];
      if (value) return value;
    }
    return undefined;
  };

  let host = pick('SUPABASE_DB_HOST', 'PGHOST');
  let port = pick('SUPABASE_DB_PORT', 'PGPORT');
  let user = pick('SUPABASE_DB_USER', 'PGUSER');
  let database = pick('SUPABASE_DB_NAME', 'PGDATABASE');
  let password = pick('SUPABASE_DB_PASSWORD', 'PGPASSWORD');

  const url = pick('DATABASE_URL');
  if (url && (!host || !user || !password)) {
    try {
      const parsed = new URL(url);
      host = host || parsed.hostname;
      port = port || parsed.port || undefined;
      user = user || decodeURIComponent(parsed.username);
      password = password || decodeURIComponent(parsed.password);
      database = database || parsed.pathname.replace(/^\//, '');
    } catch {
      // Fall through to the missing-variable report below.
    }
  }

  const missing = [
    ['SUPABASE_DB_HOST', host],
    ['SUPABASE_DB_USER', user],
    ['SUPABASE_DB_PASSWORD', password],
  ]
    .filter((entry) => !entry[1])
    .map((entry) => String(entry[0]));

  if (missing.length > 0) {
    throw new PostgresUnavailableError(
      [
        `Cannot resolve a Postgres connection: missing ${missing.join(', ')}.`,
        '',
        'The direct-Postgres driver needs connection details in .env.local:',
        '  SUPABASE_DB_HOST, SUPABASE_DB_PORT, SUPABASE_DB_USER,',
        '  SUPABASE_DB_NAME, SUPABASE_DB_PASSWORD   (or DATABASE_URL)',
        '',
        'Session mode on port 5432 is required: the direct db.*.supabase.co host does',
        'not resolve over IPv4, and transaction mode would discard the `set local role`',
        'that makes a principal a principal.',
      ].join('\n'),
    );
  }

  return {
    host: String(host),
    port: port || '5432',
    user: String(user),
    database: database || 'postgres',
    password: String(password),
  };
}

export interface PsqlOutput {
  /** The `__RESULT__` payload, or undefined when the batch never reached it. */
  payload?: string;
  stdout: string;
  stderr: string;
}

const RESULT_PREFIX = '__RESULT__';

/**
 * One psql process, with operations serialised through a promise queue. Two concurrent
 * writes to one stdin would interleave two batches into an unparseable stream, and the
 * RLS suite is sequential by design anyway: one shared fixture, one database.
 */
export class PsqlSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private pending: { marker: string; settle: (out: PsqlOutput) => void } | undefined;
  private counter = 0;
  private closed = false;
  private exitReason: string | undefined;

  constructor(private readonly connection: PostgresConnection) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const child = spawn('psql', ['--no-psqlrc', '-q', '-A', '-t', '-f', '-'], {
      env: {
        ...process.env,
        PGHOST: this.connection.host,
        PGPORT: this.connection.port,
        PGUSER: this.connection.user,
        PGDATABASE: this.connection.database,
        PGPASSWORD: this.connection.password,
        PGCONNECT_TIMEOUT: '30',
        PGAPPNAME: 'propertysuite-rls-suite',
        PGCLIENTENCODING: 'UTF8',
      },
      windowsHide: true,
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.drain();
    });
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
    });
    child.on('exit', (code, signal) => {
      this.closed = true;
      this.exitReason = `psql exited with code ${code ?? 'null'}, signal ${signal ?? 'none'}`;
      this.drain(true);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      this.closed = true;
      this.exitReason =
        error.code === 'ENOENT'
          ? 'psql is not on PATH. Install the PostgreSQL client tools, or use the ' +
            'Docker/supabase-js driver instead.'
          : `psql failed to start: ${error.message}`;
      this.drain(true);
    });

    // A Vitest worker is not guaranteed to run an `afterAll`, and the pool may kill it
    // outright. Without this the psql process outlives the run, holding a session-mode
    // pooler connection open — and the pooler has a finite number of them, so a few
    // aborted runs would start failing to connect for reasons that look like the
    // database being down.
    process.once('exit', () => {
      try {
        child.kill();
      } catch {
        // Nothing useful to do while the process is exiting.
      }
    });

    // Verbose errors carry the SQLSTATE, which several assertions check exactly.
    child.stdin.write('\\set VERBOSITY verbose\n\\set ON_ERROR_STOP off\n');
    this.child = child;
    return child;
  }

  private drain(force = false): void {
    const waiter = this.pending;
    if (!waiter) return;
    const index = this.stdoutBuffer.indexOf(waiter.marker);
    if (index === -1 && !force) return;

    const consumed = index === -1 ? this.stdoutBuffer : this.stdoutBuffer.slice(0, index);
    this.stdoutBuffer = index === -1 ? '' : this.stdoutBuffer.slice(index + waiter.marker.length);

    const payloadLine = consumed.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));
    const stderr = this.stderrBuffer;
    this.stderrBuffer = '';
    this.pending = undefined;

    waiter.settle({
      ...(payloadLine === undefined ? {} : { payload: payloadLine.slice(RESULT_PREFIX.length) }),
      stdout: consumed,
      stderr,
    });
  }

  /** Sends one `\;`-joined batch and waits for its result. Serialised. */
  run(batch: string): Promise<PsqlOutput> {
    const task = this.queue.then(() => this.send(batch));
    // Keep the chain alive when a send rejects, so one failure does not wedge every
    // later operation behind a rejected promise.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private send(batch: string): Promise<PsqlOutput> {
    const child = this.start();
    if (this.closed) {
      return Promise.reject(
        new PostgresUnavailableError(this.exitReason ?? 'the psql session is closed'),
      );
    }

    const marker = `__END__${++this.counter}__`;
    return new Promise<PsqlOutput>((settle, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.marker === marker) {
          this.pending = undefined;
          reject(
            new PostgresUnavailableError(
              `psql did not answer within 120s. Last stderr: ${this.stderrBuffer.slice(-500)}`,
            ),
          );
        }
      }, 120_000);

      this.pending = {
        marker,
        settle: (out) => {
          clearTimeout(timer);
          settle(out);
        },
      };

      // The batch MUST end in a semicolon. Without one psql keeps it in its query
      // buffer and sends nothing, while `\echo` — which is client-side — prints the end
      // marker immediately. The result is a reply with no payload that looks like a
      // database fault and is really a missing character.
      const terminated = batch.trimEnd().endsWith(';') ? batch.trimEnd() : `${batch.trimEnd()};`;

      // `\echo` is client-side, so the end marker costs no round trip.
      child.stdin.write(`${terminated}\n\\echo ${marker}\n`);
    });
  }

  /**
   * Clears a failed transaction so the session can be reused.
   *
   * Called when a batch produced no payload, which means it aborted before its own
   * `rollback`. One unrecovered abort would otherwise turn every subsequent assertion
   * into `25P02: current transaction is aborted` — dozens of failures with one cause,
   * none of them about RLS.
   */
  async recover(): Promise<void> {
    if (this.closed || !this.child) return;
    try {
      await this.run('rollback');
    } catch {
      // Already unusable; close() will deal with it.
    }
  }

  async close(): Promise<void> {
    if (!this.child || this.closed) return;
    const child = this.child;
    await new Promise<void>((done) => {
      child.once('exit', () => done());
      child.stdin.end('\\q\n');
      setTimeout(() => {
        child.kill();
        done();
      }, 5_000);
    });
    this.closed = true;
  }
}
