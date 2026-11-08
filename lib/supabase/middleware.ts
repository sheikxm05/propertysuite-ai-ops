/**
 * Edge-middleware Supabase client.
 *
 * Middleware is the only place in a Next.js application that can both read the request's
 * cookies and write the response's, which is why `@supabase/ssr` insists the session
 * refresh happens here. A missing or broken middleware client is the usual cause of
 * "random logouts" and "token refresh storms" in a Supabase SSR application.
 *
 * `updateSession` returns the user *and* the response the refreshed cookies were written
 * to. The caller must return that response — or copy its cookies onto whatever it
 * returns instead — or the refreshed token is dropped and the next request re-refreshes.
 */

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { publicEnv } from '@/lib/env';

export interface SessionRefreshResult {
  /** The verified user id, or `null` when there is no valid session. */
  userId: string | null;
  /** The response carrying refreshed cookies. Must be returned or merged. */
  response: NextResponse;
}

/**
 * Verifies and refreshes the session cookie.
 *
 * Uses `getUser()`, not `getSession()`: the former validates the token with the auth
 * server, the latter trusts whatever the cookie decoded to. In middleware — the gate in
 * front of every dashboard page — only the verified answer is worth having.
 */
export async function updateSession(request: NextRequest): Promise<SessionRefreshResult> {
  // Start from a pass-through response so cookies written below survive.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) {
            request.cookies.set(name, value);
          }
          // Rebuild from the mutated request so a downstream server component sees the
          // refreshed cookie in the same pass, then write them to the response too.
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data, error } = await supabase.auth.getUser();
  const userId = error || !data?.user ? null : data.user.id;

  return { userId, response };
}
