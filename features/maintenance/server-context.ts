/**
 * Page-side session and membership resolution for the maintenance screens.
 *
 * The API routes get their context from `withApiHandler`. Server components do not go
 * through it — they are not HTTP handlers — so this is the equivalent for a page, built
 * from the same Wave 0 pieces and in the same order:
 *
 *   `createServerClient()` → the caller-scoped client, anon key, RLS in force
 *   `getSession()`         → `auth.getUser()`, which validates the JWT against the auth
 *                            server rather than decoding a cookie locally
 *   `resolveMembership()`  → role, organization, tenant id and provider id, all from
 *                            trusted `organization_members` rows
 *
 * A dedicated module rather than three lines per page, because the one thing that must
 * never vary between the four maintenance screens is where the role comes from. Reading
 * it from a cookie, a header, a query string or a prop handed down from a client
 * component would break CLAUDE.md rule 5 in a place that looks like presentation code.
 *
 * `null` is a legitimate answer. An authenticated user with no active membership — signed
 * up, invitation not yet redeemed — gets an empty screen with an explanation, not a
 * crash and not a redirect loop into pages that need a membership to work.
 *
 * This is a convenience boundary and not a security one. `middleware.ts` gates the route
 * group, every mutation goes through an API route that re-authorizes, and RLS denies
 * independently. If this file were deleted, no data would become reachable.
 */

import { getSession } from '@/lib/auth/session';
import { resolveMembership, type Membership } from '@/lib/auth/roles';
import { createLogger, type Logger } from '@/lib/observability/logger';
import { createServerClient } from '@/lib/supabase/server';
import type { AppSupabaseClient } from '@/lib/supabase/types';

export interface MaintenancePageContext {
  supabase: AppSupabaseClient;
  membership: Membership | null;
  logger: Logger;
}

export async function maintenancePageContext(): Promise<MaintenancePageContext> {
  const supabase = await createServerClient();
  const session = await getSession(supabase);
  const membership = session ? await resolveMembership(session.userId, supabase) : null;

  return {
    supabase,
    membership,
    // Pages have no request id of their own. A stable label keeps page-side queries
    // greppable in the log without pretending to a correlation id they do not have.
    logger: createLogger({ requestId: 'page', base: { route: '/maintenance' } }),
  };
}
