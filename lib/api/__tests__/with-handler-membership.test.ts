/**
 * `withApiHandler`'s `membership: 'required' | 'optional'` mode.
 *
 * Onboarding is the only reason the optional mode exists. A user who has just signed up
 * and is calling `create_organization`, or an invitee calling `accept_invitation`, is
 * authenticated and has **no membership** — which is the correct state, not a denial.
 * Before this, those two flows had to be exposed as server actions as well, so one flow
 * had two transports.
 *
 * The property these tests exist to protect is that the mode is opt-in and never
 * inferred. A route that forgets to declare it gets `'required'` and fails closed;
 * inferring "optional" from the absence of a `roles` list would silently open every
 * unlisted route to a caller with no membership.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  state: {
    sessionThrows: null as unknown,
    membershipThrows: null as unknown,
    hasMembership: true,
    role: 'organization_admin' as string,
  },
  auditCalls: [] as { action: string; organizationId: string }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createRouteHandlerClient: () => ({
    supabase: { marker: 'caller-scoped-client' },
    pendingCookies: [],
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSessionFromClient: async () => {
    if (mocks.state.sessionThrows) throw mocks.state.sessionThrows;
    return { userId: 'auth-user-1', email: 'new.user@example.com', lastSignInAt: null };
  },
}));

vi.mock('@/lib/auth/roles', () => {
  const fixture = () => ({
    memberId: 'member-1',
    role: mocks.state.role,
    status: 'active',
    profile: { id: 'profile-1', authUserId: 'auth-user-1', fullName: 'A Person' },
    organization: { id: 'org-1', name: 'Org A', slug: 'org-a', status: 'active' },
    tenantId: null,
    providerId: null,
  });

  return {
    // The optional path. Returns null for a caller with no membership — not an error.
    resolveMembership: async () => (mocks.state.hasMembership ? fixture() : null),
    // The required path. Throws when there is none.
    requireMembership: async () => {
      if (mocks.state.membershipThrows) throw mocks.state.membershipThrows;
      if (!mocks.state.hasMembership) {
        throw new (class extends Error {})('no membership');
      }
      return fixture();
    },
    membershipLogFields: (m: { organization: { id: string }; role: string }) => ({
      organization_id: m.organization.id,
      role: m.role,
    }),
  };
});

vi.mock('@/lib/audit/write', () => ({
  writeAuditLog: async (_client: unknown, entry: { action: string; organizationId: string }) => {
    mocks.auditCalls.push(entry);
    return { written: true, auditId: 'audit-1', reason: null };
  },
}));

import { resetRateLimits } from '@/lib/rate-limit';

import { ApiRouteError } from '../errors';
import { created, ok } from '../responses';
import { withApiHandler } from '../with-handler';

const BASE = 'https://app.example.test';

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function codeOf(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '';
}

beforeEach(() => {
  mocks.state.sessionThrows = null;
  mocks.state.membershipThrows = null;
  mocks.state.hasMembership = true;
  mocks.state.role = 'organization_admin';
  mocks.auditCalls.length = 0;
  resetRateLimits();
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the default is required', () => {
  it('refuses a caller with no membership when the mode is not declared', async () => {
    mocks.state.hasMembership = false;
    mocks.state.membershipThrows = new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'no_active_membership' },
    });

    const response = await withApiHandler({}, (ctx) => ok(null, ctx.requestId))(
      post('/api/v1/organizations', {}),
    );

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('FORBIDDEN');
  });

  it("behaves identically when 'required' is declared explicitly", async () => {
    mocks.state.hasMembership = false;
    mocks.state.membershipThrows = new ApiRouteError('FORBIDDEN');

    const response = await withApiHandler({ membership: 'required' }, (ctx) =>
      ok(null, ctx.requestId),
    )(post('/api/v1/organizations', {}));

    expect(response.status).toBe(403);
  });
});

describe('the optional mode admits an onboarding caller', () => {
  it('runs the handler with a null membership', async () => {
    mocks.state.hasMembership = false;
    let seen: unknown = 'unset';

    const response = await withApiHandler({ membership: 'optional' }, (ctx) => {
      seen = ctx.membership;
      return created({ id: 'org-new' }, ctx.requestId);
    })(post('/api/v1/organizations', { name: 'New Org' }));

    expect(response.status).toBe(201);
    expect(seen).toBeNull();
  });

  it('still populates membership when the caller has one', async () => {
    mocks.state.hasMembership = true;
    let organizationId: string | null = null;

    await withApiHandler({ membership: 'optional' }, (ctx) => {
      organizationId = ctx.membership?.organization.id ?? null;
      return ok(null, ctx.requestId);
    })(post('/api/v1/organizations', {}));

    expect(organizationId).toBe('org-1');
  });

  it('is not optional identity — authentication is still required', async () => {
    mocks.state.hasMembership = false;
    mocks.state.sessionThrows = new ApiRouteError('UNAUTHENTICATED');

    const response = await withApiHandler({ membership: 'optional' }, (ctx) =>
      ok(null, ctx.requestId),
    )(post('/api/v1/organizations', {}));

    expect(response.status).toBe(401);
    expect(await codeOf(response)).toBe('UNAUTHENTICATED');
  });
});

describe('a route that declares both optional membership and roles', () => {
  it('is refused rather than ignored — there is no role to check', async () => {
    mocks.state.hasMembership = false;

    const response = await withApiHandler(
      { membership: 'optional', roles: ['organization_admin'] },
      (ctx) => ok(null, ctx.requestId),
    )(post('/api/v1/organizations', {}));

    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe('FORBIDDEN');
  });

  it('honours the role gate normally once a membership exists', async () => {
    mocks.state.hasMembership = true;
    mocks.state.role = 'organization_admin';

    const response = await withApiHandler(
      { membership: 'optional', roles: ['organization_admin'] },
      (ctx) => ok(null, ctx.requestId),
    )(post('/api/v1/organizations', {}));

    expect(response.status).toBe(200);
  });

  it('refuses a membership whose role is not listed', async () => {
    mocks.state.hasMembership = true;
    mocks.state.role = 'tenant';

    const response = await withApiHandler(
      { membership: 'optional', roles: ['organization_admin'] },
      (ctx) => ok(null, ctx.requestId),
    )(post('/api/v1/organizations', {}));

    expect(response.status).toBe(403);
  });
});

describe('the other stages still run', () => {
  it('validates the body', async () => {
    mocks.state.hasMembership = false;

    const response = await withApiHandler(
      { membership: 'optional', bodySchema: z.object({ name: z.string().min(2) }) },
      (ctx) => ok(null, ctx.requestId),
    )(post('/api/v1/organizations', { name: '' }));

    expect(response.status).toBe(400);
    expect(await codeOf(response)).toBe('VALIDATION_ERROR');
  });

  it('rate-limits, keyed on the verified session user rather than an IP', async () => {
    mocks.state.hasMembership = false;
    const route = withApiHandler(
      { membership: 'optional', rateLimit: { key: 'onboard', perMinute: 1 } },
      (ctx) => ok(null, ctx.requestId),
    );

    expect((await route(post('/api/v1/organizations', {}))).status).toBe(200);
    const limited = await route(post('/api/v1/organizations', {}));
    expect(limited.status).toBe(429);
    expect(await codeOf(limited)).toBe('RATE_LIMITED');
  });

  it('returns a correlated envelope on failure', async () => {
    mocks.state.hasMembership = false;
    const response = await withApiHandler({ membership: 'optional' }, () => {
      throw new Error('boom');
    })(post('/api/v1/organizations', {}));

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('the audit row', () => {
  it('is delegated to the RPC when there is no organization yet', async () => {
    mocks.state.hasMembership = false;

    const response = await withApiHandler(
      {
        membership: 'optional',
        audit: { action: 'organization_created', entityType: 'organization' },
      },
      (ctx) => created({ id: 'org-new' }, ctx.requestId),
    )(post('/api/v1/organizations', {}));

    expect(response.status).toBe(201);
    // `log_audit` requires an organization and there is none yet. 0003's
    // `create_organization` and `accept_invitation` call it themselves, inside the same
    // transaction as the write — strictly better than auditing from the wrapper.
    expect(mocks.auditCalls).toHaveLength(0);
  });

  it('is written by the wrapper once a membership exists', async () => {
    mocks.state.hasMembership = true;

    await withApiHandler(
      {
        membership: 'optional',
        audit: { action: 'organization_updated', entityType: 'organization' },
      },
      (ctx) => ok({ id: 'org-1' }, ctx.requestId),
    )(post('/api/v1/organizations', {}));

    expect(mocks.auditCalls).toHaveLength(1);
    expect(mocks.auditCalls[0]?.organizationId).toBe('org-1');
  });
});
