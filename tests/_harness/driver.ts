/**
 * The execution-driver abstraction. Lane w0-l6.
 *
 * The suite asserts RLS behaviour, and RLS lives in Postgres. How a statement reaches
 * Postgres is a transport detail, so there are two transports:
 *
 *   supabase  PostgREST over HTTPS with a real Supabase Auth JWT per principal.
 *             Needs the anon and service-role keys, i.e. a running stack.
 *   pg        `psql` straight to Postgres, impersonating a principal exactly the way
 *             PostgREST does:
 *                 set local role authenticated;
 *                 select set_config('request.jwt.claims',
 *                   json_build_object('sub', <auth_user_id>, 'role','authenticated')::text, true);
 *             `auth.uid()` reads `request.jwt.claims->>'sub'`, so this is the same code
 *             path a real JWT takes. Needs only a connection string.
 *
 * The driver swaps the transport and NOTHING else. Same cases, same expectations, same
 * strictness about SQLSTATEs. Both answer the same `Principal` interface, so no test
 * file knows which one it is running on.
 *
 * Two rules hold in both drivers, and they are the whole reason the suite means
 * anything:
 *
 *   1. Fixtures are written by the privileged client — service-role over HTTP, the
 *      table owner over psql. Both bypass RLS. Neither may ever satisfy an assertion.
 *   2. Assertions run as `authenticated` with a principal's identity attached. Under
 *      psql the session role is switched for the statement and reset afterwards; an
 *      assertion made while the session is still the owner would pass against a
 *      database with no policies at all.
 */

import type { MemberRole, OrgKey } from './jwt-factory';
import type { Row } from './sql';

export type { Row } from './sql';

export interface DbError {
  code: string | null;
  message: string;
  details?: string | null;
}

export interface DbResult {
  data: Row[] | null;
  error: DbError | null;
}

export interface QueryOptions {
  /** Comma-separated column list. Defaults to `id`. */
  columns?: string;
  /** Equality filters, ANDed together. */
  eq?: Row;
  limit?: number;
}

/**
 * One authenticated principal's view of the database. Every assertion in tests/rls
 * goes through this and nothing else.
 */
export interface Principal {
  readonly key: string;
  readonly org: OrgKey;
  /**
   * `anon` is not a member role — it is the absence of one. It is included here so the
   * "an unauthenticated caller reads nothing" assertions go through the same interface
   * as every other principal instead of reaching for a raw client.
   */
  readonly role: MemberRole | 'anon';
  describe(): string;
  select(table: string, options?: QueryOptions): Promise<DbResult>;
  insert(table: string, row: Row, returning?: string): Promise<DbResult>;
  update(table: string, patch: Row, eq: Row, returning?: string): Promise<DbResult>;
  remove(table: string, eq: Row, returning?: string): Promise<DbResult>;
  /**
   * TRUNCATE. Supabase's default grants leave this privilege with `authenticated` on
   * every table, and 0002 revoked only UPDATE and DELETE on maintenance_activities —
   * so the trigger is the only thing standing between a client and the whole activity
   * history. PostgREST cannot express TRUNCATE, so this is pg-driver only and reports
   * `unsupported` elsewhere rather than silently passing.
   */
  truncate(table: string): Promise<DbResult & { unsupported?: boolean }>;
}

/**
 * The privileged client. Fixture setup only: seeding, scratch rows, and reading back a
 * value the suite needs to know but is not asserting an access decision about.
 */
export interface UpsertOptions {
  conflictColumn?: string;
  /**
   * Insert-or-skip instead of insert-or-update. Required for append-only tables, where
   * an UPDATE is refused by a trigger no matter who is asking.
   */
  ignoreDuplicates?: boolean;
}

export interface SetupClient {
  upsert(table: string, rows: Row[], options?: UpsertOptions): Promise<void>;
  insert(table: string, row: Row): Promise<DbResult>;
  update(table: string, patch: Row, eq: Row): Promise<DbResult>;
  remove(table: string, eq: Row): Promise<DbResult>;
  select(table: string, options?: QueryOptions): Promise<DbResult>;
  /** Does this column exist? Used to probe for schema features rather than assume. */
  hasColumn(table: string, column: string): Promise<boolean>;
}

export type DriverName = 'supabase' | 'pg';

export interface RlsDriver {
  readonly name: DriverName;
  /** One line for the run header, with no credential in it. */
  describe(): string;
  /** Throws with an actionable message when the database is not reachable. */
  preflight(): Promise<void>;
  setup(): SetupClient;
  /**
   * Creates the authentication identities the principals need, idempotently, and
   * returns the auth user id per principal key. `profiles.auth_user_id` is NOT NULL and
   * UNIQUE, so this has to happen before any fixture row is written.
   */
  ensureAuthUsers(): Promise<Map<string, string>>;
  /** Builds an authenticated principal. Must never return a privileged client. */
  principal(key: string): Promise<Principal>;
  /** The unauthenticated caller: `anon` with no identity attached. */
  anonymous(): Promise<Principal>;
  /**
   * Puts a PDF-shaped object at every seeded path so the storage suite has something
   * real to ask for. Returns a reason rather than throwing, so a storage-less
   * environment reports itself instead of failing the whole run at seed time.
   */
  seedStorageObjects(
    bucket: string,
    fixture: { A: { objects: Record<string, string> }; B: { objects: Record<string, string> } },
  ): Promise<{ seeded: boolean; reason?: string }>;
  /** True when HTTP-level storage behaviour (signed URLs, expiry) can be exercised. */
  readonly supportsHttpStorage: boolean;
  dispose(): Promise<void>;
}

/**
 * `PS_RLS_DRIVER=pg|supabase` selects explicitly. Otherwise: supabase-js when the
 * anon and service-role keys are present (the Docker path stays the default, as
 * briefed), falling back to direct Postgres when only a connection string exists.
 */
export function selectedDriverName(): DriverName | undefined {
  const requested = (process.env.PS_RLS_DRIVER ?? '').trim().toLowerCase();
  if (requested === 'pg' || requested === 'postgres' || requested === 'psql') return 'pg';
  if (requested === 'supabase' || requested === 'supabase-js') return 'supabase';
  if (requested !== '') {
    throw new Error(
      `Unknown PS_RLS_DRIVER "${requested}". Use "supabase" (PostgREST with real JWTs) ` +
        'or "pg" (psql with set local role authenticated).',
    );
  }
  return undefined;
}
