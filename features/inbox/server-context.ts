/**
 * Page-side session and membership resolution for the inbox screens.
 *
 * The same pattern `features/maintenance/server-context.ts` establishes, for the same
 * reason: a server component is not an HTTP handler, so it does not pass through
 * `withApiHandler`, and the one thing that must never vary between the inbox's two
 * screens is where the caller's role comes from.
 *
 *   `createServerClient()` → caller-scoped client, anon key, RLS in force
 *   `getSession()`         → `auth.getUser()`, validated against the auth server
 *   `resolveMembership()`  → role, organization and tenant id, from trusted rows
 *
 * A convenience boundary, not a security one. `middleware.ts` gates the route group,
 * every mutation goes through an API route that re-authorizes from `ctx.membership`, and
 * RLS denies independently. Deleting this file would make no row reachable.
 */

import { resolveMembership, type Membership } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { createLogger, type Logger } from '@/lib/observability/logger';
import { createServerClient } from '@/lib/supabase/server';
import type { AppSupabaseClient } from '@/lib/supabase/types';

export interface InboxPageContext {
  supabase: AppSupabaseClient;
  membership: Membership | null;
  logger: Logger;
}

export async function inboxPageContext(): Promise<InboxPageContext> {
  const supabase = await createServerClient();
  const session = await getSession(supabase);
  const membership = session ? await resolveMembership(session.userId, supabase) : null;

  return {
    supabase,
    membership,
    // Pages have no request id. A stable label keeps page-side queries greppable in the
    // log without pretending to a correlation id they do not have.
    logger: createLogger({ requestId: 'page', base: { route: '/inbox' } }),
  };
}
