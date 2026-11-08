/**
 * The route surface of `/api/v1/tenants` and `/api/v1/tenancies`.
 *
 * WHAT THIS CAN AND CANNOT TEST, STATED PLAINLY
 * `withApiHandler` authenticates with `supabase.auth.getUser()`, which validates the JWT
 * against the auth server. Driving a handler end to end therefore needs a reachable
 * Supabase project and a real token, and at the time this lane ran the anon and
 * service-role keys for the live project were not available — so there is no HTTP-level
 * test of these handlers anywhere in this lane, and this file does not pretend otherwise.
 * Faking `getUser` would have removed the only thing a route-level test adds over the
 * service-level tests next to it.
 *
 * What it does assert is the *shape* of the surface, which is checkable statically and is
 * where a rule gets broken quietly:
 *
 *   - no `DELETE` export on a tenant-scoped resource (CLAUDE.md rule 6), and no `PUT`
 *     either, which would be a whole-record overwrite of a row with withheld columns;
 *   - the method set matches `docs/api-contracts.md`.
 *
 * The role gates live inside each handler's closure and are not reachable from here;
 * they are asserted against the §4 matrix in `tests/tenants/authorization.test.ts` and
 * enforced a second time inside each service function.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Importing a route module loads `lib/env.ts`, which parses the browser-visible
 * configuration **eagerly** — "a misconfigured deployment dies at boot rather than on a
 * user's first request". The anon key for the live project is not available to this lane,
 * so without a placeholder the import itself throws and the method set cannot be read.
 *
 * These two values are therefore stubbed, and only these two. Nothing authenticates and
 * no handler runs, so no stubbed value is ever used for anything: this is enough
 * configuration to *load* the module, not enough to call it. `vi.unstubAllEnvs` restores
 * the environment afterwards, and Vitest isolates the module registry per test file, so
 * no other suite observes the stub.
 */
beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'route-shape-test-placeholder-not-a-key');

  // Warm the module graph here rather than inside the first `it`. A route module pulls
  // in Next, Supabase and the whole of `lib/`, which takes several seconds to transform
  // on a cold cache — comfortably inside the hook timeout and uncomfortably close to the
  // per-test one.
  await import('@/app/api/v1/tenants/route');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'] as const;

async function exportedMethods(load: () => Promise<Record<string, unknown>>) {
  const exports = await load();
  return HTTP_METHODS.filter((method) => typeof exports[method] === 'function');
}

describe('/api/v1/tenants', () => {
  it('exposes list and create only', async () => {
    const methods = await exportedMethods(() => import('@/app/api/v1/tenants/route'));

    expect(methods).toEqual(['GET', 'POST']);
  });

  it('exposes read and patch on the item, and no delete', async () => {
    const methods = await exportedMethods(() => import('@/app/api/v1/tenants/[tenantId]/route'));

    expect(methods).toEqual(['GET', 'PATCH']);
    expect(methods).not.toContain('DELETE');
    // A PUT would overwrite a row whose columns the caller may not all read.
    expect(methods).not.toContain('PUT');
  });
});

describe('/api/v1/tenancies', () => {
  it('exposes list and create only', async () => {
    const methods = await exportedMethods(() => import('@/app/api/v1/tenancies/route'));

    expect(methods).toEqual(['GET', 'POST']);
  });

  it('exposes read and patch on the item, and no delete', async () => {
    const methods = await exportedMethods(() => import('@/app/api/v1/tenancies/[tenancyId]/route'));

    expect(methods).toEqual(['GET', 'PATCH']);
    expect(methods).not.toContain('DELETE');
    expect(methods).not.toContain('PUT');
  });
});
