/**
 * The caller's context, for server components and server actions. Lane w1-l1.
 *
 * `withApiHandler` does this for route handlers. Pages and server actions are not route
 * handlers and cannot use it — it returns a `Response`, and it refuses a caller with no
 * membership, which is precisely the state a newly signed-up user is in. So this module
 * is the equivalent seam for the rendering and action paths, and it is written to be the
 * *only* one: a page that resolved its own session would be a page that could forget to.
 *
 * What it guarantees, and what it does not:
 *
 *  - The session is verified by `supabase.auth.getUser()`, which validates the JWT
 *    against the auth server. Never `getSession()`, which trusts a cookie.
 *  - Membership comes from `resolveMembership()` — trusted rows, no client input. There
 *    is no parameter here through which a caller could name an organization.
 *  - It is **not** the authorization layer. A page that must enforce a role calls
 *    `assertAuthorized`/`authorize` from `lib/auth/authorize.ts` on top of this, and RLS
 *    denies independently underneath it. A convenience boundary, not a security one.
 */

import { redirect } from 'next/navigation';

import { getSession, type AuthenticatedSession } from '@/lib/auth/session';
import { resolveMembership, type Membership } from '@/lib/auth/roles';
import { createServerClient } from '@/lib/supabase/server';
import type { AppSupabaseClient } from '@/lib/supabase/types';

/** Frozen by amendment A17 and named literally in `middleware.ts`. */
export const SIGN_IN_PATH = '/sign-in';

/** Where a signed-in visitor lands. */
export const DASHBOARD_PATH = '/dashboard';

export interface ServerContext {
  supabase: AppSupabaseClient;
  session: AuthenticatedSession;
  /**
   * `null` for an authenticated user who belongs to nothing yet — a legitimate state
   * between signing up and accepting an invitation or creating an organization. Callers
   * must handle it; it is not an error.
   */
  membership: Membership | null;
}

/**
 * The caller's context, or `null` when there is no verified session.
 *
 * Returns rather than redirects, so a server action can answer with a form error instead
 * of throwing a redirect from inside a submission.
 */
export async function currentContext(): Promise<ServerContext | null> {
  const supabase = await createServerClient();
  const session = await getSession(supabase);
  if (!session) return null;

  const membership = await resolveMembership(session.userId, supabase);
  return { supabase, session, membership };
}

/**
 * The caller's context, or a redirect to sign-in.
 *
 * `middleware.ts` already gates the `(dashboard)` route group, so in practice this
 * redirect fires only for a session that expired between the edge check and the render.
 * It is kept because "the middleware will have handled it" is exactly the assumption
 * that turns a layout into the only thing standing between a visitor and a page.
 */
export async function requireContext(): Promise<ServerContext> {
  const context = await currentContext();
  if (!context) redirect(SIGN_IN_PATH);
  return context;
}
