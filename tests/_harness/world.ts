/**
 * The seeded world: credentials, ten real sessions, one client per principal, and the
 * fixture ids. Lane w0-l6.
 *
 * Memoized per process. The RLS suite runs in a single fork (see vitest.config.ts), so
 * the two organizations are seeded once and every test file shares them.
 *
 * `service` is present for fixture work only. Nothing in tests/rls may make an
 * assertion through it: the service-role key bypasses RLS, so an assertion made with it
 * would pass against a database with no policies at all.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadJwtFactory,
  type JwtFactoryModule,
  type MemberRole,
  type OrgKey,
  type PrincipalSession,
  type StackCredentials,
} from './jwt-factory';
import { seedFixture, seedStorageObjects, type Fixture, type OrgFixture } from './fixtures';

/** Amendment A5 (§5.8): the bucket id is frozen as `documents`. */
export const STORAGE_BUCKET = 'documents';

export interface World {
  factory: JwtFactoryModule;
  creds: StackCredentials;
  fixture: Fixture;
  sessions: Map<string, PrincipalSession>;
  /** Authenticated clients, keyed by principal key. The only clients an assertion may use. */
  clients: Map<string, SupabaseClient>;
  anon: SupabaseClient;
  /** Fixture setup only — never an assertion. */
  service: SupabaseClient;
  storage: { seeded: boolean; reason?: string };
}

let worldPromise: Promise<World> | undefined;

async function build(): Promise<World> {
  const factory = await loadJwtFactory();
  const creds = factory.resolveStackCredentials();
  const fixture = await seedFixture(factory, creds);
  const sessions = await factory.createSessions(creds);

  const clients = new Map<string, SupabaseClient>();
  for (const [key, session] of sessions) {
    clients.set(key, factory.createSessionClient(creds, session.accessToken));
  }

  const service = factory.createServiceRoleClient(creds);
  const storage = await seedStorageObjects(service, STORAGE_BUCKET, fixture);

  return {
    factory,
    creds,
    fixture,
    sessions,
    clients,
    anon: factory.createAnonClient(creds),
    service,
    storage,
  };
}

export function getWorld(): Promise<World> {
  if (!worldPromise) worldPromise = build();
  return worldPromise;
}

/* ----------------------------------------------------------------- lookups -- */

export const principalKey = (org: OrgKey, slot: string) => `${org.toLowerCase()}_${slot}`;

/** The frozen ten: the core principal for a role in an organization. */
const SLOT_FOR_ROLE: Readonly<Record<MemberRole, string>> = {
  organization_admin: 'admin',
  property_manager: 'manager',
  property_owner: 'owner',
  tenant: 'tenant',
  service_provider: 'provider',
};

export const keyForRole = (org: OrgKey, role: MemberRole) => principalKey(org, SLOT_FOR_ROLE[role]);

export function clientFor(world: World, org: OrgKey, role: MemberRole): SupabaseClient {
  const key = keyForRole(org, role);
  const client = world.clients.get(key);
  if (!client) throw new Error(`No authenticated client for ${key}`);
  return client;
}

export function clientForKey(world: World, key: string): SupabaseClient {
  const client = world.clients.get(key);
  if (!client) throw new Error(`No authenticated client for ${key}`);
  return client;
}

export function sessionFor(world: World, org: OrgKey, role: MemberRole): PrincipalSession {
  const key = keyForRole(org, role);
  const session = world.sessions.get(key);
  if (!session) throw new Error(`No session for ${key}`);
  return session;
}

export const org = (world: World, key: OrgKey): OrgFixture => world.fixture[key];

export const otherOrg = (key: OrgKey): OrgKey => (key === 'A' ? 'B' : 'A');
