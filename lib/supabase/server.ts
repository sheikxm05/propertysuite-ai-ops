/**
 * Server-side Supabase clients that carry the caller's identity.
 *
 * Two flavours, because Next.js gives server code two different cookie stores:
 *
 *  - `createServerClient()` — for server components, server actions and route handlers.
 *    Reads cookies from `next/headers`. Writes are attempted and swallowed, because a
 *    server component rendered during streaming is not allowed to set a cookie; the
 *    edge middleware (`middleware.ts`) is what actually refreshes the session.
 *  - `createRouteHandlerClient(request)` — for `withApiHandler`. Reads cookies off the
 *    incoming `Request` and records any refreshed cookies so the wrapper can copy them
 *    onto the outgoing response.
 *
 * Both use the anon key, so **Row Level Security is in force**. That is the point: the
 * application-space checks in `lib/auth/authorize.ts` are the second layer, not the
 * only one. See CLAUDE.md goal 1.
 */

import { createServerClient as createSsrClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { publicEnv } from '@/lib/env';

import type { AppSupabaseClient } from './types';

/** A cookie the Supabase client asked us to write back to the caller. */
export interface PendingCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

/**
 * Client for server components, server actions and route handlers that use
 * `next/headers`. `cookies()` is async in Next 15, so this is too.
 */
export async function createServerClient(): Promise<AppSupabaseClient> {
  const store = await cookies();

  return createSsrClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) {
              store.set(name, value, options);
            }
          } catch {
            // Thrown when called from a server component. Harmless: the middleware
            // refreshes the session cookie on the next navigation. Swallowing here is
            // the documented @supabase/ssr pattern, not an oversight.
          }
        },
      },
    },
  );
}

/** A caller-scoped client plus the cookies it wants written back. */
export interface RouteHandlerClient {
  supabase: AppSupabaseClient;
  /** Cookies the client refreshed during the request. Copy onto the response. */
  pendingCookies: PendingCookie[];
}

/**
 * Client for `withApiHandler`. Cookies are read from the request and refreshes are
 * collected rather than written immediately, because a route handler can only set
 * cookies on a `Response` it has already constructed.
 */
export function createRouteHandlerClient(request: Request): RouteHandlerClient {
  const pendingCookies: PendingCookie[] = [];
  const incoming = parseCookieHeader(request.headers.get('cookie'));

  const supabase = createSsrClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => incoming,
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            pendingCookies.push({ name, value, options });
          }
        },
      },
    },
  );

  return { supabase, pendingCookies };
}

/**
 * Minimal `Cookie:` header parser. Deliberately not a dependency: the header is a
 * `name=value; name=value` list and values arriving from Supabase are URI-encoded.
 */
export function parseCookieHeader(header: string | null): { name: string; value: string }[] {
  if (!header) return [];
  const out: { name: string; value: string }[] = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    out.push({ name, value: safeDecode(raw) });
  }
  return out;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
