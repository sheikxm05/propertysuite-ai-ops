/**
 * supabase-js driver — PostgREST over HTTPS with a real Supabase Auth JWT per
 * principal. Lane w0-l6. This is the default and the authoritative transport: it is
 * the one the application itself uses.
 *
 * Each principal signs in for real through `scripts/make-jwts.mjs` and talks to the
 * API with the anon key plus its own bearer token, which is exactly how a browser
 * session reaches the database. The service-role client seeds fixtures and never
 * satisfies an assertion.
 *
 * Unlike the pg driver there is no per-operation transaction: PostgREST has no way to
 * roll one back. That is acceptable where this driver runs — a disposable local Docker
 * stack — and is why the pg driver, which runs against a real cloud project, wraps and
 * rolls back every statement instead.
 */

import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type {
  DbResult,
  Principal,
  QueryOptions,
  RlsDriver,
  Row,
  SetupClient,
  UpsertOptions,
} from './driver';
import {
  loadJwtFactory,
  type JwtFactoryModule,
  type MemberRole,
  type OrgKey,
  type PrincipalSession,
  type StackCredentials,
} from './jwt-factory';

const toError = (error: PostgrestError | null): DbResult['error'] =>
  error
    ? { code: error.code ?? null, message: error.message, details: error.details ?? null }
    : null;

function applyFilters(
  builder: ReturnType<ReturnType<SupabaseClient['from']>['select']>,
  eq: Row | undefined,
) {
  let query = builder;
  for (const [column, value] of Object.entries(eq ?? {})) {
    query = value === null ? query.is(column, null) : query.eq(column, value as string);
  }
  return query;
}

interface SupabaseIdentity {
  key: string;
  org: OrgKey;
  role: MemberRole | 'anon';
}

class SupabasePrincipal implements Principal {
  constructor(
    private readonly client: SupabaseClient,
    private readonly session: SupabaseIdentity,
  ) {}

  get key(): string {
    return this.session.key;
  }
  get org(): OrgKey {
    return this.session.org;
  }
  get role(): MemberRole | 'anon' {
    return this.session.role;
  }
  describe(): string {
    return `${this.session.role} of organization ${this.session.org} (${this.session.key})`;
  }

  async select(table: string, options: QueryOptions = {}): Promise<DbResult> {
    let query = applyFilters(this.client.from(table).select(options.columns ?? 'id'), options.eq);
    if (options.limit !== undefined) query = query.limit(options.limit);
    const { data, error } = await query;
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  async insert(table: string, row: Row, returning = 'id'): Promise<DbResult> {
    const { data, error } = await this.client.from(table).insert(row).select(returning);
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  async update(table: string, patch: Row, eq: Row, returning = 'id'): Promise<DbResult> {
    const { data, error } = await applyFilters(
      // `update().select()` returns the affected rows, which is the only way to tell
      // "RLS hid the row" (zero rows, no error) from "the update happened".
      this.client.from(table).update(patch).select(returning) as never,
      eq,
    );
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  async remove(table: string, eq: Row, returning = 'id'): Promise<DbResult> {
    const { data, error } = await applyFilters(
      this.client.from(table).delete().select(returning) as never,
      eq,
    );
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  truncate(table: string): Promise<DbResult & { unsupported?: boolean }> {
    // PostgREST exposes no TRUNCATE verb. Reported as unsupported rather than passed
    // over in silence, because the privilege genuinely is granted to `authenticated`
    // and only a trigger refuses it — see the pg driver.
    return Promise.resolve({
      data: null,
      error: { code: null, message: `TRUNCATE ${table} is not expressible over PostgREST` },
      unsupported: true,
    });
  }

  /** Storage is HTTP-only, so it is exposed here rather than on the interface. */
  storage(): SupabaseClient['storage'] {
    return this.client.storage;
  }
}

class SupabaseSetup implements SetupClient {
  constructor(private readonly service: SupabaseClient) {}

  async upsert(table: string, rows: Row[], options: UpsertOptions = {}): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.service.from(table).upsert(rows, {
      onConflict: options.conflictColumn ?? 'id',
      ignoreDuplicates: options.ignoreDuplicates ?? false,
    });
    if (error) {
      throw new Error(
        `Fixture seeding failed on ${table}: ${error.message}` +
          (error.details ? ` (${error.details})` : '') +
          '\nThis is a seeding failure, not an RLS result. Check that migrations applied:' +
          '\n  node scripts/reset-db.mjs',
      );
    }
  }

  async insert(table: string, row: Row): Promise<DbResult> {
    const { data, error } = await this.service.from(table).insert(row).select('id');
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  async update(table: string, patch: Row, eq: Row): Promise<DbResult> {
    const { data, error } = await applyFilters(
      this.service.from(table).update(patch).select('id') as never,
      eq,
    );
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  async remove(table: string, eq: Row): Promise<DbResult> {
    const { data, error } = await applyFilters(
      this.service.from(table).delete().select('id') as never,
      eq,
    );
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  async select(table: string, options: QueryOptions = {}): Promise<DbResult> {
    let query = applyFilters(this.service.from(table).select(options.columns ?? 'id'), options.eq);
    if (options.limit !== undefined) query = query.limit(options.limit);
    const { data, error } = await query;
    return { data: (data as Row[] | null) ?? null, error: toError(error) };
  }

  async hasColumn(table: string, column: string): Promise<boolean> {
    const { error } = await this.service.from(table).select(column).limit(1);
    return !error;
  }

  client(): SupabaseClient {
    return this.service;
  }
}

export class SupabaseDriver implements RlsDriver {
  readonly name = 'supabase' as const;
  readonly supportsHttpStorage = true;

  private factory: JwtFactoryModule | undefined;
  private creds: StackCredentials | undefined;
  private sessions: Map<string, PrincipalSession> | undefined;
  private setupClient: SupabaseSetup | undefined;

  describe(): string {
    const host = this.creds ? new URL(this.creds.url).host : 'unresolved';
    return `supabase driver — PostgREST at ${host} with real Supabase Auth JWTs`;
  }

  private async ready(): Promise<{ factory: JwtFactoryModule; creds: StackCredentials }> {
    if (!this.factory) this.factory = await loadJwtFactory();
    if (!this.creds) this.creds = this.factory.resolveStackCredentials();
    return { factory: this.factory, creds: this.creds };
  }

  async preflight(): Promise<void> {
    const { creds } = await this.ready();
    const probe = await fetch(`${creds.url}/rest/v1/`, {
      headers: { apikey: creds.anonKey },
    }).catch((error: unknown) => error as Error);

    if (probe instanceof Error) {
      throw new Error(
        `Resolved ${creds.url} but could not reach it: ${probe.message}\n\n` +
          'Start the stack:\n' +
          '  node scripts/supabase-local.mjs doctor   # tells you exactly what is missing\n' +
          '  npm run db:start\n',
      );
    }
  }

  setup(): SetupClient {
    if (!this.setupClient) {
      if (!this.factory || !this.creds) {
        throw new Error('SupabaseDriver.setup() called before preflight()');
      }
      this.setupClient = new SupabaseSetup(this.factory.createServiceRoleClient(this.creds));
    }
    return this.setupClient;
  }

  async ensureAuthUsers(): Promise<Map<string, string>> {
    const { factory, creds } = await this.ready();
    const users = await factory.ensureAuthUsers(creds);
    return new Map([...users.values()].map((u) => [u.key, u.userId]));
  }

  /** Uploads a minimal PDF to every seeded path through the Storage API. */
  async seedStorageObjects(
    bucket: string,
    fixture: { A: { objects: Record<string, string> }; B: { objects: Record<string, string> } },
  ): Promise<{ seeded: boolean; reason?: string }> {
    const body = new Uint8Array([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a,
    ]);
    const service = (this.setup() as SupabaseSetup).client();
    const paths = [...Object.values(fixture.A.objects), ...Object.values(fixture.B.objects)];
    for (const path of paths) {
      const { error } = await service.storage
        .from(bucket)
        .upload(path, body, { contentType: 'application/pdf', upsert: true });
      if (error) return { seeded: false, reason: `${path}: ${error.message}` };
    }
    return { seeded: true };
  }

  async principal(key: string): Promise<Principal> {
    const { factory, creds } = await this.ready();
    if (!this.sessions) this.sessions = await factory.createSessions(creds);
    const session = this.sessions.get(key);
    if (!session) throw new Error(`Unknown principal ${key}`);
    return new SupabasePrincipal(factory.createSessionClient(creds, session.accessToken), session);
  }

  /** The unauthenticated caller: the anon key and no bearer token. */
  async anonymous(): Promise<Principal> {
    const { factory, creds } = await this.ready();
    return new SupabasePrincipal(factory.createAnonClient(creds), {
      key: 'anon',
      org: 'A',
      role: 'anon',
    });
  }

  async dispose(): Promise<void> {
    // Nothing to close: supabase-js holds no persistent connection.
  }
}

export { SupabasePrincipal };
