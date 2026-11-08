/**
 * Browser Supabase client.
 *
 * Carries the anon key and the user's session cookie, so Row Level Security applies to
 * every statement. Nothing privileged is reachable from here — the service-role client
 * lives behind the `server-only` import boundary (see `./server-only/service-role.ts`).
 *
 * `createBrowserClient` is a singleton by default, so repeated calls during a React
 * render do not open new connections or re-read cookies.
 */

'use client';

import { createBrowserClient } from '@supabase/ssr';

import { publicEnv } from '@/lib/env';

import type { AppSupabaseClient } from './types';

let cached: AppSupabaseClient | null = null;

/** The browser client. Safe to call from any client component. */
export function createClient(): AppSupabaseClient {
  if (cached) return cached;
  cached = createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return cached;
}
