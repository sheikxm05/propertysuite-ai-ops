/**
 * Session verification.
 *
 * `supabase.auth.getUser()` is used throughout, never `supabase.auth.getSession()`.
 * The difference matters: `getSession()` decodes the JWT that arrived in a cookie and
 * trusts it, while `getUser()` sends it to the auth server for verification. A cookie is
 * attacker-controlled, so on the server only the verified call is acceptable.
 *
 * The exported names are the frozen ones (`getSession`, `requireSession`); the
 * implementation underneath is the verified call.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { createServerClient } from '@/lib/supabase/server';
import type { AppSupabaseClient } from '@/lib/supabase/types';

/**
 * A verified caller.
 *
 * Carries the minimum needed downstream. `email` is present because Supabase Auth owns
 * it and an invitation flow needs it, but it is **not** on the logger's allowlist, so it
 * cannot reach a log line by accident.
 */
export interface AuthenticatedSession {
  userId: string;
  email: string | null;
  /** When the user last authenticated, from the verified user record. */
  lastSignInAt: string | null;
}

/**
 * The verified session, or `null` when there is none.
 *
 * Returns `null` for an absent, expired or tampered token alike. Distinguishing them
 * for the caller would be a disclosure and is of no use to a legitimate client, which
 * simply needs to sign in again.
 */
export async function getSession(client?: AppSupabaseClient): Promise<AuthenticatedSession | null> {
  const supabase = client ?? (await createServerClient());
  return getSessionFromClient(supabase);
}

/** `getSession` against a client the caller already built. Used by `withApiHandler`. */
export async function getSessionFromClient(
  client: AppSupabaseClient,
): Promise<AuthenticatedSession | null> {
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;

  const user = data.user;
  return {
    userId: user.id,
    email: user.email ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
  };
}

/**
 * The verified session, or a thrown 401.
 *
 * Used by server components and by `withApiHandler`. The thrown error carries no detail:
 * `UNAUTHENTICATED` with its frozen message is all a client gets, and all it needs.
 */
export async function requireSession(client?: AppSupabaseClient): Promise<AuthenticatedSession> {
  const session = await getSession(client);
  if (!session) {
    throw new ApiRouteError('UNAUTHENTICATED', {
      logFields: { reason: 'no_verified_session' },
    });
  }
  return session;
}

/** `requireSession` against a client the caller already built. */
export async function requireSessionFromClient(
  client: AppSupabaseClient,
): Promise<AuthenticatedSession> {
  const session = await getSessionFromClient(client);
  if (!session) {
    throw new ApiRouteError('UNAUTHENTICATED', {
      logFields: { reason: 'no_verified_session' },
    });
  }
  return session;
}
