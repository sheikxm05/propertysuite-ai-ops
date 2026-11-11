/**
 * The seeded world: a driver, the fixture ids, and one authenticated principal per
 * test identity. Lane w0-l6.
 *
 * Memoized per process. The RLS suite runs in a single fork (see vitest.config.ts), so
 * the two organizations are seeded once and every test file shares them.
 *
 * `setup` is the privileged client — service-role over HTTP, table owner over psql.
 * Both bypass RLS. Neither may ever satisfy an assertion: a test written against them
 * would pass against a database with no policies at all. It exists to build the world
 * and to answer "did that write actually land?", never "was the caller allowed to?".
 */

import type { Principal, RlsDriver, SetupClient } from './driver';
import { selectedDriverName } from './driver';
import { PgDriver } from './driver-pg';
import { SupabaseDriver } from './driver-supabase';
import { loadJwtFactory, type JwtFactoryModule, type MemberRole, type OrgKey } from './jwt-factory';
import { seedFixture, type Fixture, type OrgFixture } from './fixtures';

/** Amendment A5 (§5.8): the bucket id is frozen as `documents`. */
export const STORAGE_BUCKET = 'documents';

export interface World {
  driver: RlsDriver;
  factory: JwtFactoryModule;
  fixture: Fixture;
  /** Authenticated principals by key. The only clients an assertion may use. */
  principals: Map<string, Principal>;
  /** The unauthenticated caller. */
  anon: Principal;
  /** Fixture setup and write-verification only — never an access assertion. */
  setup: SetupClient;
  storage: { seeded: boolean; reason?: string };
  /** Scratch tickets created during the run, removed on teardown. */
  scratchTickets: string[];
}

let worldPromise: Promise<World> | undefined;

/**
 * supabase-js stays the default when the stack keys are present, per the brief. The pg
 * driver is chosen when only a connection string exists, and either can be forced with
 * `PS_RLS_DRIVER`.
 */
export async function buildDriver(): Promise<RlsDriver> {
  const requested = selectedDriverName();
  if (requested === 'pg') return new PgDriver();
  if (requested === 'supabase') return new SupabaseDriver();

  const factory = await loadJwtFactory();
  try {
    factory.resolveStackCredentials({ allowStatusProbe: true });
    return new SupabaseDriver();
  } catch (stackError) {
    try {
      return new PgDriver();
    } catch (pgError) {
      throw new Error(
        [
          'Neither execution driver can run.',
          '',
          '  supabase-js (default, needs the anon + service-role keys and a reachable API):',
          `    ${stackError instanceof Error ? stackError.message.split('\n')[0] : String(stackError)}`,
          '',
          '  direct Postgres (PS_RLS_DRIVER=pg, needs only a connection string):',
          `    ${pgError instanceof Error ? pgError.message.split('\n')[0] : String(pgError)}`,
          '',
          'Start the local stack with `npm run db:start`, or put the database connection',
          'details in .env.local and set PS_RLS_DRIVER=pg.',
        ].join('\n'),
      );
    }
  }
}

async function build(): Promise<World> {
  const driver = await buildDriver();
  await driver.preflight();

  const factory = await loadJwtFactory();
  const setup = driver.setup();

  // Auth users first: profiles carry a NOT NULL, UNIQUE auth_user_id, and 0003 creates
  // the profile row from an auth.users trigger.
  const userIdByPrincipal = await driver.ensureAuthUsers();
  const fixture = await seedFixture(setup, factory, userIdByPrincipal);

  const principals = new Map<string, Principal>();
  for (const descriptor of factory.PRINCIPALS) {
    principals.set(descriptor.key, await driver.principal(descriptor.key));
  }

  const storage = await driver.seedStorageObjects(STORAGE_BUCKET, fixture);
  const anon = await driver.anonymous();

  return { driver, factory, fixture, principals, anon, setup, storage, scratchTickets: [] };
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

export function clientFor(world: World, org: OrgKey, role: MemberRole): Principal {
  return clientForKey(world, keyForRole(org, role));
}

export function clientForKey(world: World, key: string): Principal {
  const client = world.principals.get(key);
  if (!client) throw new Error(`No authenticated principal for ${key}`);
  return client;
}

export const org = (world: World, key: OrgKey): OrgFixture => world.fixture[key];

export const otherOrg = (key: OrgKey): OrgKey => (key === 'A' ? 'B' : 'A');

/** Registers a scratch ticket so teardown can remove it. */
export function trackScratchTicket(world: World, ticketId: string): string {
  world.scratchTickets.push(ticketId);
  return ticketId;
}
