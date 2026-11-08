/**
 * Entry route. Lane w1-l1 — this file replaces the `SEAM FOR LANE w1-l1` block w0-l1
 * left here.
 *
 * It resolves nothing and renders nothing: a verified session goes to `/dashboard`, and
 * everyone else to `/sign-in`. There is no landing page in this build, and `/` is not in
 * `middleware.ts`'s matcher, so this is the only gate on it.
 *
 * The session is read through `getSession()`, which is `supabase.auth.getUser()`
 * underneath — the JWT is verified against the auth server rather than decoded from a
 * cookie. The difference matters even for a redirect: trusting a cookie here would send
 * a forged session to the dashboard, where the real check would then fail in a less
 * legible way.
 *
 * Membership is deliberately *not* resolved here. A user who is authenticated but
 * belongs to nothing yet is in a legitimate state — signed up, invitation not yet
 * redeemed — and `/dashboard` is where that state is handled. Redirecting them somewhere
 * else from here would duplicate that decision in two files.
 */

import { redirect } from 'next/navigation';

import { getSession } from '@/lib/auth/session';

export default async function Home() {
  const session = await getSession();
  redirect(session ? '/dashboard' : '/sign-in');
}
