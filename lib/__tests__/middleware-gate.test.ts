/**
 * The edge middleware gate.
 *
 * The case worth reading is `/accept-invitation`. The gate redirects a signed-in visitor
 * away from the auth pages, which is right for `/sign-in` and `/sign-up` — but
 * `0003`'s `accept_invitation(p_token)` requires `auth.uid()`, so the one auth slug that
 * *needs* an authenticated caller was the one the gate bounced. A17 froze the slug and
 * the gate made it a dead end for its only purpose.
 *
 * `updateSession` is mocked so the session verdict can be set per test; the real one
 * needs a Supabase project and belongs to the integration suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock('@/lib/supabase/middleware', async () => {
  const { NextResponse } = await import('next/server');
  return {
    updateSession: async (request: NextRequest) => ({
      userId: mocks.userId,
      response: NextResponse.next({ request }),
    }),
  };
});

import { middleware } from '@/middleware';

const BASE = 'https://app.example.test';

function visit(path: string): NextRequest {
  return new NextRequest(new Request(`${BASE}${path}`, { method: 'GET' }));
}

/** The `Location` header of a redirect, or `null` when the request passed through. */
function redirectTo(response: Response): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  return location.startsWith(BASE) ? location.slice(BASE.length) : location;
}

beforeEach(() => {
  mocks.userId = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an unauthenticated visitor', () => {
  const protectedPaths = [
    '/dashboard',
    '/properties',
    '/properties/abc',
    '/tenancies',
    '/tenants',
    '/maintenance',
    '/documents',
    '/organization',
    '/members',
  ];

  for (const path of protectedPaths) {
    it(`is sent to /sign-in from ${path}`, async () => {
      const response = await middleware(visit(path));
      const target = redirectTo(response);
      expect(target).toBeTruthy();
      expect(target?.startsWith('/sign-in')).toBe(true);
    });
  }

  it('carries the requested path so sign-in can return them to it', async () => {
    const target = redirectTo(await middleware(visit('/properties/abc')));
    expect(target).toBe('/sign-in?next=%2Fproperties%2Fabc');
  });

  it('is not redirected away from an auth page', async () => {
    for (const path of ['/sign-in', '/sign-up', '/forgot-password', '/accept-invitation']) {
      expect(redirectTo(await middleware(visit(path))), path).toBeNull();
    }
  });
});

describe('a signed-in visitor', () => {
  beforeEach(() => {
    mocks.userId = 'auth-user-1';
  });

  it('passes straight through a protected page', async () => {
    expect(redirectTo(await middleware(visit('/dashboard')))).toBeNull();
  });

  it('is sent onward from /sign-in', async () => {
    expect(redirectTo(await middleware(visit('/sign-in')))).toBe('/dashboard');
  });

  it('is sent onward from /sign-up and /forgot-password', async () => {
    expect(redirectTo(await middleware(visit('/sign-up')))).toBe('/dashboard');
    expect(redirectTo(await middleware(visit('/forgot-password')))).toBe('/dashboard');
  });

  it('REACHES /accept-invitation — the slug that needs a session (FIX 2)', async () => {
    // accept_invitation requires auth.uid(). Bouncing a signed-in invitee here made the
    // frozen slug unusable for the one thing it exists to do.
    expect(redirectTo(await middleware(visit('/accept-invitation')))).toBeNull();
  });

  it('reaches a tokenised accept-invitation path too', async () => {
    expect(redirectTo(await middleware(visit('/accept-invitation/tok-abc123')))).toBeNull();
  });
});

describe('the return-to parameter cannot become an open redirect', () => {
  beforeEach(() => {
    mocks.userId = 'auth-user-1';
  });

  it('refuses an absolute URL to another origin', async () => {
    const target = redirectTo(await middleware(visit('/sign-in?next=https://evil.example/x')));
    expect(target).toBe('/dashboard');
  });

  it('refuses a protocol-relative URL', async () => {
    const target = redirectTo(await middleware(visit('/sign-in?next=//evil.example/x')));
    expect(target).toBe('/dashboard');
  });

  it('accepts a protected application path', async () => {
    const target = redirectTo(await middleware(visit('/sign-in?next=%2Fproperties')));
    expect(target).toBe('/properties');
  });

  it('refuses a path that is not a protected application page', async () => {
    const target = redirectTo(await middleware(visit('/sign-in?next=%2Fsign-up')));
    expect(target).toBe('/dashboard');
  });
});
