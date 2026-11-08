/**
 * The service-role Supabase client. **This client bypasses Row Level Security.**
 *
 * Three layers keep it out of the browser:
 *
 *  1. **Path.** It lives under `server-only/`, and `eslint.config.mjs` restricts
 *     imports matching `**\/server-only/**` to server-side code. A client component
 *     that imports it fails lint. The module also sits under `lib/supabase/`, so the
 *     companion `**\/lib/supabase/service-role*` rule covers the shorter path a future
 *     refactor might reach for.
 *  2. **Secret boundary.** The key is read through `lib/server-only/secrets.ts`, which
 *     is itself server-only and throws if evaluated in a browser. Next.js additionally
 *     never inlines a non-`NEXT_PUBLIC_` variable into the client bundle, so even a
 *     successful import would yield no key.
 *  3. **Runtime assertion.** `createServiceRoleClient()` throws if `window` exists.
 *
 * Usage rules, which no lint rule can express:
 *
 *  - Never use it to satisfy an assertion in a test. It bypasses RLS, so every isolation
 *    test would pass meaninglessly.
 *  - Never use it to serve a user-facing read. Reads go through the caller-scoped client
 *     so RLS is the first of the two enforcement layers.
 *  - Use it only for system writes the caller is not the author of — the audit trail,
 *    background jobs, invitation acceptance — and always after
 *    `lib/auth/authorize.ts` has already allowed the operation in application space.
 */

/**
 * Build-time guard. The `server-only` package resolves to a module that throws under any
 * condition but React's `react-server`, so importing this file from a client component is
 * a BUILD failure — not a lint error, and not a runtime assertion that fires after the
 * bundle has already shipped. The ESLint `server-only` path rule and the
 * `assertServerRuntime` call below are both kept: three independent guards, each
 * catching what the others cannot.
 */
import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { assertServerRuntime, publicEnv } from '@/lib/env';
import { supabaseServiceRoleKey } from '@/lib/server-only/secrets';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

let cached: PrivilegedSupabaseClient | null = null;

/**
 * The privileged client, created once per server process.
 *
 * Session persistence and auto-refresh are off: there is no user session here, and a
 * background refresh timer holding a service-role key in memory on a serverless
 * instance is a liability with no benefit.
 */
export function createServiceRoleClient(): PrivilegedSupabaseClient {
  assertServerRuntime('createServiceRoleClient()');
  if (cached) return cached;

  cached = createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, supabaseServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        // Makes privileged traffic identifiable in Supabase's request logs, so an
        // unexpected RLS-bypassing query is visible rather than anonymous.
        'x-propertysuite-client': 'service-role',
      },
    },
  });

  return cached;
}

/**
 * The privileged client, or `null` when no service-role credential is configured.
 *
 * Used by `withApiHandler`'s audit path: a developer running unit tests without a local
 * Supabase stack should get a logged warning, not a crash on every mutation.
 */
export function tryCreateServiceRoleClient(): PrivilegedSupabaseClient | null {
  try {
    return createServiceRoleClient();
  } catch {
    return null;
  }
}
