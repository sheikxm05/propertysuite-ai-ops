/**
 * `withPrivilegedApiHandler` — `withApiHandler` plus an RLS-bypassing client on `ctx`.
 *
 * §5.2's context declares `serviceRole?`, optional. This module is what makes it
 * present, and the dependency direction is the whole design:
 *
 *     lib/api/with-handler.ts            → knows nothing about service-role
 *     lib/api/server-only/…              → imports both, injects one into the other
 *
 * Inverting it that way means the mandatory wrapper — the module every one of the ~30
 * Wave 1 routes imports — has no path to a privileged client at all. If the wrapper
 * imported it directly, the `server-only` boundary in `eslint.config.mjs` would be
 * satisfied by a single file and then silently bypassed by every route that imports that
 * file. Here, a route that wants privilege has to import this module by name, and lint
 * permits that only from server-side code.
 *
 * When to reach for it, which is rarely:
 *
 *  - Writing a row the caller is not the author of and `0003` has no RPC for.
 *  - A background job with no `auth.uid()` at all.
 *
 * When **not** to:
 *
 *  - Audit rows. `lib/audit/write.ts` calls the security-definer `log_audit` as the
 *    caller, on purpose: the function attributes the row to `current_profile_id()` and
 *    refuses a caller who is not an active member. Service-role would skip both.
 *  - Any user-facing read. Reads go through `ctx.supabase` so RLS is the first of the
 *    two enforcement layers rather than an untested one.
 *  - Satisfying an assertion in a test. It bypasses RLS, so the test would pass whatever
 *    the policies say.
 */

/**
 * Build-time guard. The `server-only` package resolves to a module that throws under any
 * condition but React's `react-server`, so importing this file from a client component is
 * a BUILD failure — not a lint error, and not a runtime assertion that fires after the
 * bundle has already shipped. The ESLint `server-only` path rule is kept as well, and the
 * service-role client this module injects carries its own runtime assertion: three
 * independent guards, each catching what the others cannot.
 */
import 'server-only';

import {
  createApiHandler,
  type ApiHandler,
  type RouteHandler,
  type WithApiHandlerOptions,
} from '@/lib/api/with-handler';
import { tryCreateServiceRoleClient } from '@/lib/supabase/server-only/service-role';

/**
 * The frozen `withApiHandler` contract, with `ctx.serviceRole` populated.
 *
 * `ctx.serviceRole` is still typed optional and can still be `undefined` — when no
 * service-role credential is configured, `tryCreateServiceRoleClient` returns `null`
 * rather than throwing, so a developer running unit tests without a local Supabase stack
 * gets a handler that must handle the absence rather than a crash at import time.
 */
export function withPrivilegedApiHandler<TBody = undefined, TQuery = undefined>(
  options: WithApiHandlerOptions<TBody, TQuery>,
  handler: ApiHandler<TBody, TQuery>,
): RouteHandler {
  return createApiHandler(options, handler, {
    serviceRoleFactory: tryCreateServiceRoleClient,
  });
}
