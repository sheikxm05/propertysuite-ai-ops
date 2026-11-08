#!/usr/bin/env node
/**
 * make-jwts.mjs — real authenticated sessions for the ten RLS test principals.
 *
 * Lane w0-l6. This is the ONLY place that mints credentials for the isolation suite,
 * so the CLI and the Vitest harness cannot drift apart. The harness consumes it
 * through tests/_harness/jwt-factory.ts.
 *
 * Ten principals: five organization roles x two organizations. Two extra secondary
 * tenants (one per organization) exist so "a tenant cannot read another tenant's row"
 * can be asserted from a real second session rather than inferred.
 *
 * Every session here is a genuine Supabase Auth sign-in against the local stack. The
 * suite then talks to PostgREST with the anon key plus that user's bearer token, which
 * is why RLS is actually in force. The service-role key is used for one thing only:
 * creating the auth users. Never for an assertion.
 *
 *   node scripts/make-jwts.mjs                 # table of principals, tokens redacted
 *   node scripts/make-jwts.mjs --json          # machine readable, tokens redacted
 *   node scripts/make-jwts.mjs --reveal        # full tokens (local disposable stack only)
 *   node scripts/make-jwts.mjs --principal a_tenant --reveal
 *   node scripts/make-jwts.mjs --list          # catalog only, no network calls
 *
 * Exit codes: 0 ok, 1 runtime failure, 2 usage or environment problem.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { statusEnv } from './supabase-local.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Local-only password. Deliberately committed: it unlocks nothing except throwaway
 * users on a disposable Docker Postgres. It must never be reused against a hosted
 * project, which is why resolveStackCredentials refuses a non-local URL unless
 * PS_ALLOW_REMOTE_STACK is set explicitly.
 */
export const TEST_PASSWORD = 'propertysuite-local-only-2a7f1c';

export const ORGANIZATIONS = {
  A: { key: 'A', slug: 'alpha-property-management', name: 'Alpha Property Management' },
  B: { key: 'B', slug: 'beta-property-management', name: 'Beta Property Management' },
};

/** Mirrors public.member_role in 0001. Shape only — role semantics live in §4. */
export const MEMBER_ROLE_KEYS = [
  'organization_admin',
  'property_manager',
  'property_owner',
  'tenant',
  'service_provider',
];

/**
 * Deterministic UUIDs derived from a stable key, so every fixture write is an upsert
 * and re-running the suite without a database reset is idempotent.
 */
export function fixtureId(key) {
  const h = createHash('sha1').update(`propertysuite:fixture:v1:${key}`).digest('hex');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `8${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join('-');
}

function titleCase(slot) {
  return slot
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function principal(org, role, slot) {
  const key = `${org.toLowerCase()}_${slot}`;
  return {
    key,
    org,
    role,
    slot,
    /** One of the frozen ten (five roles x two organizations). */
    core: !slot.endsWith('2'),
    email: `${slot}@${ORGANIZATIONS[org].slug}.test`,
    fullName: `${titleCase(slot)} ${org}`,
    profileId: fixtureId(`profile:${key}`),
    memberId: fixtureId(`member:${key}`),
  };
}

/** The frozen ten, plus the two secondary tenants. */
export const PRINCIPALS = [
  principal('A', 'organization_admin', 'admin'),
  principal('A', 'property_manager', 'manager'),
  principal('A', 'property_owner', 'owner'),
  principal('A', 'tenant', 'tenant'),
  principal('A', 'service_provider', 'provider'),
  principal('B', 'organization_admin', 'admin'),
  principal('B', 'property_manager', 'manager'),
  principal('B', 'property_owner', 'owner'),
  principal('B', 'tenant', 'tenant'),
  principal('B', 'service_provider', 'provider'),
  principal('A', 'tenant', 'tenant2'),
  principal('B', 'tenant', 'tenant2'),
];

export const CORE_PRINCIPALS = PRINCIPALS.filter((p) => p.core);

export function principalByKey(key) {
  const found = PRINCIPALS.find((p) => p.key === key);
  if (!found) {
    throw new Error(
      `Unknown principal "${key}". Known: ${PRINCIPALS.map((p) => p.key).join(', ')}`,
    );
  }
  return found;
}

/* ------------------------------------------------------- stack credentials -- */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'host.docker.internal']);

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let v = line.slice(eq + 1).trim();
    const quoted =
      (v.startsWith('"') && v.endsWith('"')) || (v.startsWith(String.fromCharCode(39)) && v.endsWith(String.fromCharCode(39)));
    if (quoted) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export class StackUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StackUnavailableError';
  }
}

/**
 * Resolution order: explicit environment, then .env.test / .env.local, then
 * `supabase status -o env`. Nothing is defaulted silently — a missing key produces an
 * actionable message rather than a confusing 401 twenty assertions later.
 */
export function resolveStackCredentials(options = {}) {
  const { requireServiceRole = true, allowStatusProbe = true } = options;
  const files = {
    ...parseEnvFile(resolve(ROOT, '.env.test')),
    ...parseEnvFile(resolve(ROOT, '.env.local')),
  };
  const pick = (...names) => {
    for (const n of names) {
      if (process.env[n]) return process.env[n];
      if (files[n]) return files[n];
    }
    return undefined;
  };

  let url = pick('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'API_URL');
  let anonKey = pick('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'ANON_KEY');
  let serviceRoleKey = pick('SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY');

  if (allowStatusProbe && (!url || !anonKey || (requireServiceRole && !serviceRoleKey))) {
    const status = statusEnv();
    url = url || status.API_URL;
    anonKey = anonKey || status.ANON_KEY;
    serviceRoleKey = serviceRoleKey || status.SERVICE_ROLE_KEY;
  }

  const missing = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!anonKey) missing.push('SUPABASE_ANON_KEY');
  if (requireServiceRole && !serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    throw new StackUnavailableError(
      [
        `Cannot resolve the local Supabase stack: missing ${missing.join(', ')}.`,
        '',
        'Fix it with one of:',
        '  1. npm run db:start                      # starts the stack, prints all three',
        '  2. node scripts/supabase-local.mjs env    # export lines to paste into .env.local',
        '  3. set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY yourself',
        '',
        'The isolation suite needs a real Postgres with RLS active. It will not run',
        'against mocks, and it must never run against a shared or hosted project.',
      ].join('\n'),
    );
  }

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new StackUnavailableError(`SUPABASE_URL is not a URL: ${url}`);
  }
  if (!LOCAL_HOSTS.has(host) && !process.env.PS_ALLOW_REMOTE_STACK) {
    throw new StackUnavailableError(
      [
        `Refusing to run the isolation suite against a non-local host (${host}).`,
        'It creates users, seeds data and attempts deletes. Point it at the local',
        'Docker stack, or set PS_ALLOW_REMOTE_STACK=1 if you genuinely mean it.',
      ].join('\n'),
    );
  }

  return { url, anonKey, serviceRoleKey };
}

/* ------------------------------------------------------------------ clients -- */

const NO_PERSIST = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

/** Service role. Bypasses RLS. Fixture setup and auth-user creation ONLY. */
export function createServiceRoleClient(creds) {
  if (!creds.serviceRoleKey) throw new Error('serviceRoleKey is required');
  return createClient(creds.url, creds.serviceRoleKey, NO_PERSIST);
}

/** Unauthenticated anon client — used to sign in, and to prove anon sees nothing. */
export function createAnonClient(creds) {
  return createClient(creds.url, creds.anonKey, NO_PERSIST);
}

/**
 * A client acting as one real authenticated user: the anon key for API access, the
 * user's access token for identity. This is the only client shape an assertion may use.
 */
export function createSessionClient(creds, accessToken) {
  return createClient(creds.url, creds.anonKey, {
    ...NO_PERSIST,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/* -------------------------------------------------------------- auth users -- */

async function findUserByEmail(service, email) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (users.length < 200) return undefined;
  }
  return undefined;
}

/**
 * Idempotent: creates the auth user if absent, otherwise reuses it and resets the
 * password, so a half-seeded database cannot leave a principal unable to sign in.
 */
export async function ensureAuthUser(service, p) {
  const { data, error } = await service.auth.admin.createUser({
    email: p.email,
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: p.fullName, fixture_key: p.key },
  });
  if (!error && data?.user) return data.user;

  const existing = await findUserByEmail(service, p.email);
  if (!existing) {
    throw new Error(
      `Could not create or find auth user ${p.email}: ${error?.message ?? 'unknown error'}`,
    );
  }
  const reset = await service.auth.admin.updateUserById(existing.id, {
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (reset.error) {
    throw new Error(`Could not reset password for ${p.email}: ${reset.error.message}`);
  }
  return reset.data?.user ?? existing;
}

export async function ensureAuthUsers(creds, principals = PRINCIPALS) {
  const service = createServiceRoleClient(creds);
  const users = new Map();
  for (const p of principals) {
    const user = await ensureAuthUser(service, p);
    users.set(p.key, { ...p, userId: user.id });
  }
  return users;
}

/* ---------------------------------------------------------------- sessions -- */

export async function signIn(creds, p) {
  const anon = createAnonClient(creds);
  const { data, error } = await anon.auth.signInWithPassword({
    email: p.email,
    password: TEST_PASSWORD,
  });
  if (error || !data?.session) {
    throw new Error(
      `Sign-in failed for ${p.key} (${p.email}): ${error?.message ?? 'no session returned'}`,
    );
  }
  return {
    ...p,
    userId: data.user?.id ?? data.session.user.id,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at ?? null,
  };
}

/**
 * Ensures the users exist, then signs every one of them in. Returns a Map keyed by
 * principal key; each value is a real session carrying a real JWT.
 */
export async function createSessions(creds, principals = PRINCIPALS) {
  await ensureAuthUsers(creds, principals);
  const sessions = new Map();
  for (const p of principals) {
    sessions.set(p.key, await signIn(creds, p));
  }
  return sessions;
}

/* --------------------------------------------------------------------- cli -- */

const redact = (token) => `${token.slice(0, 12)}...${token.slice(-6)} (${token.length} chars)`;

function parseArgs(argv) {
  const flags = new Set();
  let principalKey;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--principal') principalKey = argv[++i];
    else if (a.startsWith('--')) flags.add(a.slice(2));
  }
  return { flags, principalKey };
}

function table(rows) {
  if (rows.length === 0) return '(none)';
  const cols = Object.keys(rows[0]);
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length))]),
  );
  const line = (cells) => cols.map((c) => String(cells[c] ?? '').padEnd(widths[c])).join('  ');
  return [
    line(Object.fromEntries(cols.map((c) => [c, c]))),
    cols.map((c) => '-'.repeat(widths[c])).join('  '),
    ...rows.map(line),
  ].join('\n');
}

async function main(argv) {
  const { flags, principalKey } = parseArgs(argv);

  if (flags.has('help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    return 0;
  }

  const selected = principalKey ? [principalByKey(principalKey)] : PRINCIPALS;

  if (flags.has('list')) {
    const rows = selected.map((p) => ({
      key: p.key,
      organization: p.org,
      role: p.role,
      email: p.email,
      one_of_ten: p.core,
    }));
    console.log(flags.has('json') ? JSON.stringify(rows, null, 2) : table(rows));
    return 0;
  }

  const creds = resolveStackCredentials();
  const sessions = await createSessions(creds, selected);
  const reveal = flags.has('reveal');

  const rows = [...sessions.values()].map((s) => ({
    key: s.key,
    organization: s.org,
    role: s.role,
    email: s.email,
    user_id: s.userId,
    access_token: reveal ? s.accessToken : redact(s.accessToken),
  }));

  if (flags.has('json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(table(rows));
    if (!reveal) {
      console.log('\nTokens are redacted. Re-run with --reveal if you need the full JWT.');
      console.log('Never paste a token into a chat transcript, a log line or an issue.');
    }
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      if (err instanceof StackUnavailableError) {
        console.error(`\n${err.message}\n`);
        process.exit(2);
      }
      console.error(`\nmake-jwts failed: ${err?.message ?? err}\n`);
      process.exit(1);
    });
}
