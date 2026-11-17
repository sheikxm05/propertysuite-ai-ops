/**
 * Page-side session and membership resolution for `/assistant`.
 *
 * The same three steps every server-rendered surface in this app uses, in the same
 * order, built from the same Wave 0 pieces:
 *
 *   `createServerClient()` → the caller-scoped client, anon key, RLS in force
 *   `getSession()`         → `auth.getUser()`, which validates the JWT against the auth
 *                            server rather than decoding a cookie locally
 *   `resolveMembership()`  → role and organization, from trusted `organization_members`
 *                            rows and from no request-supplied value whatsoever
 *
 * `withApiHandler` does this for route handlers; a page is not a route handler, so this
 * is the equivalent seam. It exists as a module rather than three lines inlined in
 * `page.tsx` for one reason: on this screen the role decides whether an Approve button
 * is drawn, and the role must therefore come from exactly one place that is obviously
 * not a cookie, a header, a query string or a prop (CLAUDE.md rule 5).
 *
 * It is a convenience boundary, not a security one. `app/(dashboard)/layout.tsx`
 * redirects an unauthenticated visitor, the approve endpoint re-authorizes,
 * `approve_agent_proposal(p_id)` re-checks `is_org_staff()`, and RLS denies
 * independently. Deleting this file would make no data reachable.
 */

import { getSession } from '@/lib/auth/session';
import { resolveMembership, type Membership } from '@/lib/auth/roles';
import { createLogger, type Logger } from '@/lib/observability/logger';
import { createServerClient } from '@/lib/supabase/server';
import type { AppSupabaseClient } from '@/lib/supabase/types';

export interface AssistantPageContext {
  supabase: AppSupabaseClient;
  /**
   * `null` for an authenticated user who belongs to no organization yet. A legitimate
   * state, not an error: the page explains it rather than crashing or redirecting.
   */
  membership: Membership | null;
  logger: Logger;
}

export async function assistantPageContext(): Promise<AssistantPageContext> {
  const supabase = await createServerClient();
  const session = await getSession(supabase);
  const membership = session ? await resolveMembership(session.userId, supabase) : null;

  return {
    supabase,
    membership,
    // A page has no request id of its own. A stable label keeps page-side work greppable
    // in the log without pretending to a correlation id it does not have.
    logger: createLogger({ requestId: 'page', base: { route: '/assistant' } }),
  };
}
