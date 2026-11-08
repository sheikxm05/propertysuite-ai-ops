/**
 * Edge middleware — the gate in front of the `(dashboard)` route group.
 *
 * Two jobs:
 *
 *  1. **Refresh the session cookie.** Middleware is the only place that can read request
 *     cookies and write response cookies, so this is where `@supabase/ssr` refreshes an
 *     expiring token. Skipping it produces intermittent logouts that look like a bug in
 *     every page but are a bug in none of them.
 *  2. **Redirect an unauthenticated visitor** away from a protected page, carrying the
 *     path they wanted so sign-in can return them to it.
 *
 * What it deliberately does **not** do:
 *
 *  - It is not an authorization layer. It knows only whether a session verifies, never
 *    which organization or role the caller has. Membership comes from trusted rows via
 *    `resolveMembership`, which needs a database round trip that does not belong on the
 *    edge in front of every asset request. A page that must enforce a role does it in
 *    the server component or through `withApiHandler`.
 *  - It does not guard `/api/**`. A route handler must answer an unauthenticated caller
 *    with the frozen `UNAUTHENTICATED` envelope and a 401, not with a 307 to an HTML
 *    login page. `withApiHandler` does that.
 *
 * Route-group note: `(dashboard)` is a Next.js route group, so it contributes nothing to
 * the URL. The protected prefixes below are the actual URLs of the pages under
 * `app/(dashboard)/`, enumerated from the `app/(dashboard)/…` ownership entries in
 * `lanes.json`. They are listed literally because `config.matcher` must be statically
 * analysable.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/middleware';

/** URL prefixes rendered by `app/(dashboard)/**`. Keep in step with `lanes.json`. */
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/organization',
  '/members',
  '/properties',
  '/tenancies',
  '/tenants',
  '/maintenance',
  '/documents',
] as const;

/** URL prefixes rendered by `app/(auth)/**`. A signed-in visitor is sent onward. */
const AUTH_PREFIXES = ['/login', '/sign-up', '/forgot-password', '/accept-invitation'] as const;

/** Where an unauthenticated visitor is sent. */
const SIGN_IN_PATH = '/login';

/** Where an already-authenticated visitor on an auth page is sent. */
const SIGNED_IN_HOME = '/dashboard';

/** Query parameter carrying the originally requested path. */
const RETURN_TO = 'next';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Always refresh, even on an auth page: a visitor arriving at /login with a valid but
  // stale cookie should be recognised rather than asked to sign in again.
  const { userId, response } = await updateSession(request);

  if (!userId && isProtected(pathname)) {
    const target = request.nextUrl.clone();
    target.pathname = SIGN_IN_PATH;
    target.search = '';
    target.searchParams.set(RETURN_TO, safeReturnTo(request.nextUrl));
    return copyCookies(NextResponse.redirect(target), response);
  }

  if (userId && isAuthPage(pathname)) {
    const target = request.nextUrl.clone();
    target.pathname = resolveReturnTo(request.nextUrl.searchParams.get(RETURN_TO));
    target.search = '';
    return copyCookies(NextResponse.redirect(target), response);
  }

  return response;
}

/**
 * Matcher.
 *
 * Static assets, the Next.js build output and favicons are excluded: running an auth
 * verification per image is latency with no benefit. `/api/**` is excluded for the
 * reason in the file header.
 */
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/dashboard',
    '/organization/:path*',
    '/organization',
    '/members/:path*',
    '/members',
    '/properties/:path*',
    '/properties',
    '/tenancies/:path*',
    '/tenancies',
    '/tenants/:path*',
    '/tenants',
    '/maintenance/:path*',
    '/maintenance',
    '/documents/:path*',
    '/documents',
    '/login',
    '/sign-up',
    '/forgot-password',
    '/accept-invitation/:path*',
    '/accept-invitation',
  ],
};

/* ---------------------------------------------------------------- helpers -- */

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isAuthPage(pathname: string): boolean {
  return AUTH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * The path to return to after sign-in, as a **relative** path.
 *
 * An open redirect is a real vulnerability here: `?next=https://evil.example` on a login
 * link would hand a freshly authenticated user to another origin. Only the pathname and
 * query survive, so the value can never leave this origin.
 */
function safeReturnTo(url: URL): string {
  const path = url.pathname + (url.search ?? '');
  return path.startsWith('/') && !path.startsWith('//') ? path : SIGNED_IN_HOME;
}

function resolveReturnTo(candidate: string | null): string {
  if (!candidate) return SIGNED_IN_HOME;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return SIGNED_IN_HOME;
  // Only a protected application path is an acceptable destination; bouncing back to an
  // auth page would loop.
  const pathname = candidate.split('?')[0] ?? '';
  return isProtected(pathname) ? candidate : SIGNED_IN_HOME;
}

/** Moves refreshed session cookies onto a redirect, which would otherwise drop them. */
function copyCookies(target: NextResponse, source: NextResponse): NextResponse {
  for (const cookie of source.cookies.getAll()) {
    target.cookies.set(cookie);
  }
  return target;
}
