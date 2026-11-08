/**
 * `withApiHandler` — error mapping, execution order, and the audit hook.
 *
 * Session resolution, membership resolution and the audit writer are mocked. Everything
 * else is the real implementation: the real validator, the real rate limiter, the real
 * error mapper, the real envelope. The point of these tests is the wrapper's own
 * behaviour, and the three mocked modules are each covered by their own suite or by the
 * RLS suite in `tests/rls/**`, which exercises them against a real database.
 *
 * The frozen execution order from §5.2 —
 * authenticate → authorize → validate → rate-limit → execute → audit → envelope —
 * is asserted directly, because an order change is invisible in a happy-path test and is
 * a real security regression: validating before the role gate makes a schema
 * discoverable without authorization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  state: {
    sessionThrows: null as unknown,
    membershipThrows: null as unknown,
    role: 'property_manager' as string,
  },
  auditCalls: [] as {
    action: string;
    entityType: string;
    entityId: unknown;
    organizationId: string;
  }[],
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
    return { userId: 'auth-user-1', email: 'manager@example.com', lastSignInAt: null };
  },
}));

vi.mock('@/lib/auth/roles', () => ({
  requireMembership: async () => {
    if (mocks.state.membershipThrows) throw mocks.state.membershipThrows;
    return {
      memberId: 'member-1',
      role: mocks.state.role,
      status: 'active',
      profile: { id: 'profile-1', authUserId: 'auth-user-1', fullName: 'A Manager' },
      organization: { id: 'org-1', name: 'Org A', slug: 'org-a', status: 'active' },
      tenantId: null,
      providerId: null,
    };
  },
  membershipLogFields: (m: {
    organization_id?: string;
    organization: { id: string };
    role: string;
  }) => ({
    organization_id: m.organization.id,
    role: m.role,
  }),
}));

vi.mock('@/lib/audit/write', () => ({
  writeAuditLog: async (
    _client: unknown,
    entry: { action: string; entityType: string; entityId: unknown; organizationId: string },
  ) => {
    mocks.auditCalls.push(entry);
    return { written: true, auditId: 'audit-1', reason: null };
  },
}));

import { ApiRouteError, ERROR_MESSAGES, notFound } from '../errors';
import { created, ok } from '../responses';
import { withApiHandler } from '../with-handler';
import { resetRateLimits } from '@/lib/rate-limit';

const BASE = 'https://app.example.test';

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { method: 'GET', headers });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

interface Envelope {
  error: { code: string; message: string; request_id: string };
}

async function envelopeOf(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}

beforeEach(() => {
  mocks.state.sessionThrows = null;
  mocks.state.membershipThrows = null;
  mocks.state.role = 'property_manager';
  mocks.auditCalls.length = 0;
  resetRateLimits();
  // The logger writes a line per request; keep the test output readable.
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------- happy path -- */

describe('a successful request', () => {
  it('passes the frozen context to the handler and returns its response', async () => {
    let seen: Record<string, unknown> = {};
    const route = withApiHandler({}, (ctx) => {
      seen = {
        sessionUserId: ctx.session.userId,
        organizationId: ctx.membership.organization.id,
        role: ctx.membership.role,
        hasSupabase: Boolean(ctx.supabase),
        serviceRole: ctx.serviceRole,
        requestIdLength: ctx.requestId.length,
        hasLogger: typeof ctx.logger.info === 'function',
        body: ctx.body,
        query: ctx.query,
      };
      return ok({ id: 'x' }, ctx.requestId);
    });

    const response = await route(get('/api/v1/properties'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 'x' } });
    expect(seen).toMatchObject({
      sessionUserId: 'auth-user-1',
      organizationId: 'org-1',
      role: 'property_manager',
      hasSupabase: true,
      hasLogger: true,
      body: undefined,
      query: undefined,
    });
    // Not privileged unless the route opted in through the server-only variant.
    expect(seen.serviceRole).toBeUndefined();
  });

  it('puts a correlation id on the response', async () => {
    const route = withApiHandler({}, (ctx) => ok(null, ctx.requestId));
    const response = await route(get('/api/v1/properties'));
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('reuses a safe inbound x-request-id so a caller can correlate', async () => {
    const route = withApiHandler({}, (ctx) => ok({ id: ctx.requestId }, ctx.requestId));
    const response = await route(get('/api/v1/properties', { 'x-request-id': 'trace-abc-123' }));
    expect(response.headers.get('x-request-id')).toBe('trace-abc-123');
  });

  it('ignores an inbound x-request-id that could forge a log line', async () => {
    const route = withApiHandler({}, (ctx) => ok(null, ctx.requestId));
    const response = await route(get('/api/v1/properties', { 'x-request-id': 'short' }));
    expect(response.headers.get('x-request-id')).not.toBe('short');
  });

  it('awaits dynamic route params', async () => {
    const route = withApiHandler({}, (ctx) => ok(ctx.params, ctx.requestId));
    const response = await route(get('/api/v1/properties/p1/units'), {
      params: Promise.resolve({ propertyId: 'p1' }),
    });
    expect(await response.json()).toEqual({ data: { propertyId: 'p1' } });
  });

  it('adds a correlation header to a hand-built Response too', async () => {
    const route = withApiHandler({}, () => new Response('{}', { status: 200 }));
    const response = await route(get('/api/v1/properties'));
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });
});

/* ------------------------------------------------------------ 401 and 403 -- */

describe('401 UNAUTHENTICATED', () => {
  it('is returned, in the frozen envelope, when there is no verified session', async () => {
    mocks.state.sessionThrows = new ApiRouteError('UNAUTHENTICATED');
    const route = withApiHandler({}, (ctx) => ok(null, ctx.requestId));
    const response = await route(get('/api/v1/properties'));

    expect(response.status).toBe(401);
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('UNAUTHENTICATED');
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
  });

  it('does not run the handler', async () => {
    mocks.state.sessionThrows = new ApiRouteError('UNAUTHENTICATED');
    const handler = vi.fn(() => new Response(null, { status: 200 }));
    await withApiHandler({}, handler)(get('/api/v1/properties'));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('403 FORBIDDEN', () => {
  it('is returned when the caller has no active membership', async () => {
    mocks.state.membershipThrows = new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'no_active_membership' },
    });
    const response = await withApiHandler({}, (ctx) => ok(null, ctx.requestId))(
      get('/api/v1/properties'),
    );
    expect(response.status).toBe(403);
    expect((await envelopeOf(response)).error.code).toBe('FORBIDDEN');
  });

  it("is returned when the caller's role is not on the route", async () => {
    mocks.state.role = 'tenant';
    const response = await withApiHandler({ roles: ['property_manager'] }, (ctx) =>
      ok(null, ctx.requestId),
    )(get('/api/v1/properties'));
    expect(response.status).toBe(403);
  });

  it('allows a role that is on the route', async () => {
    mocks.state.role = 'tenant';
    const response = await withApiHandler({ roles: ['tenant', 'property_manager'] }, (ctx) =>
      ok(null, ctx.requestId),
    )(get('/api/v1/properties'));
    expect(response.status).toBe(200);
  });

  it('reveals nothing about why', async () => {
    mocks.state.role = 'tenant';
    const response = await withApiHandler({ roles: ['organization_admin'] }, (ctx) =>
      ok(null, ctx.requestId),
    )(get('/api/v1/members'));
    const body = await envelopeOf(response);
    expect(body.error.message).toBe(ERROR_MESSAGES.FORBIDDEN);
    expect(JSON.stringify(body)).not.toContain('tenant');
    expect(JSON.stringify(body)).not.toContain('organization_admin');
  });
});

/* -------------------------------------------------------------------- 400 -- */

describe('400 VALIDATION_ERROR', () => {
  const bodySchema = z.object({ name: z.string().min(1), city: z.string() });

  it('rejects a body that fails the schema', async () => {
    const response = await withApiHandler({ bodySchema }, (ctx) => ok(ctx.body, ctx.requestId))(
      post('/api/v1/properties', { name: '' }),
    );
    expect(response.status).toBe(400);
    expect((await envelopeOf(response)).error.code).toBe('VALIDATION_ERROR');
  });

  it('never reports which field failed', async () => {
    const response = await withApiHandler({ bodySchema }, (ctx) => ok(ctx.body, ctx.requestId))(
      post('/api/v1/properties', { name: '' }),
    );
    const text = JSON.stringify(await envelopeOf(response));
    expect(text).not.toContain('name');
    expect(text).not.toContain('city');
    expect(text).toContain(ERROR_MESSAGES.VALIDATION_ERROR);
  });

  it('accepts a body that passes, and types it', async () => {
    const route = withApiHandler({ bodySchema }, (ctx) =>
      ok({ echoed: ctx.body.name.toUpperCase() }, ctx.requestId),
    );
    const response = await route(post('/api/v1/properties', { name: 'marina', city: 'Dubai' }));
    expect(await response.json()).toEqual({ data: { echoed: 'MARINA' } });
  });

  it('rejects a non-JSON content type', async () => {
    const response = await withApiHandler({ bodySchema }, (ctx) => ok(null, ctx.requestId))(
      new Request(`${BASE}/api/v1/properties`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'name=x',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a malformed JSON body', async () => {
    const response = await withApiHandler({ bodySchema }, (ctx) => ok(null, ctx.requestId))(
      post('/api/v1/properties', '{"name":'),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a body on GET', async () => {
    const response = await withApiHandler({ bodySchema }, (ctx) => ok(null, ctx.requestId))(
      get('/api/v1/properties'),
    );
    expect(response.status).toBe(400);
  });

  it('rejects a query string that fails the schema', async () => {
    const querySchema = z.object({ limit: z.coerce.number().int().max(100) });
    const response = await withApiHandler({ querySchema }, (ctx) => ok(ctx.query, ctx.requestId))(
      get('/api/v1/properties?limit=5000'),
    );
    expect(response.status).toBe(400);
  });

  it('collapses a repeated query key to an array so a second value cannot smuggle past', async () => {
    const querySchema = z.object({ limit: z.union([z.string(), z.array(z.string())]) });
    const response = await withApiHandler({ querySchema }, (ctx) => ok(ctx.query, ctx.requestId))(
      get('/api/v1/properties?limit=25&limit=5000'),
    );
    expect(await response.json()).toEqual({ data: { limit: ['25', '5000'] } });
  });
});

/* ------------------------------------------------------- 404, 409, 422, 500 -- */

describe('errors raised inside the handler', () => {
  it('maps notFound() to 404', async () => {
    const response = await withApiHandler({}, () => {
      throw notFound();
    })(get('/api/v1/properties/missing'));
    expect(response.status).toBe(404);
    expect((await envelopeOf(response)).error.code).toBe('NOT_FOUND');
  });

  it('maps a P0001 trigger exception to 409', async () => {
    const response = await withApiHandler({}, () => {
      throw {
        code: 'P0001',
        message: 'ticket_status_transition_invalid: open -> completed is not allowed',
      };
    })(post('/api/v1/maintenance/tickets/t1', {}));
    expect(response.status).toBe(409);
    expect((await envelopeOf(response)).error.code).toBe('CONFLICT');
  });

  it('maps a 23503 foreign-key violation to 422', async () => {
    const response = await withApiHandler({}, () => {
      throw { code: '23503', message: 'insert or update on table violates foreign key' };
    })(post('/api/v1/tenancies', {}));
    expect(response.status).toBe(422);
    expect((await envelopeOf(response)).error.code).toBe('UNPROCESSABLE');
  });

  it('maps a 42501 RLS denial to 403', async () => {
    const response = await withApiHandler({}, () => {
      throw { code: '42501', message: 'new row violates row-level security policy' };
    })(post('/api/v1/properties', {}));
    expect(response.status).toBe(403);
  });

  it('maps an unexpected throw to 500 with the generic message', async () => {
    const response = await withApiHandler({}, () => {
      throw new Error('connection to db-prod-3 at 10.0.0.4:5432 refused');
    })(get('/api/v1/properties'));

    expect(response.status).toBe(500);
    const body = await envelopeOf(response);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(JSON.stringify(body)).not.toContain('10.0.0.4');
    expect(JSON.stringify(body)).not.toContain('db-prod-3');
  });

  it('still returns a correlated envelope on a 500', async () => {
    const response = await withApiHandler({}, () => {
      throw new Error('boom');
    })(get('/api/v1/properties', { 'x-request-id': 'trace-xyz-999' }));
    expect((await envelopeOf(response)).error.request_id).toBe('trace-xyz-999');
  });
});

/* -------------------------------------------------------------------- 429 -- */

describe('429 RATE_LIMITED', () => {
  it('is returned once the declared bucket is empty', async () => {
    const route = withApiHandler({ rateLimit: { key: 'probe-429', perMinute: 1 } }, (ctx) =>
      ok(null, ctx.requestId),
    );
    expect((await route(get('/api/v1/properties'))).status).toBe(200);

    const limited = await route(get('/api/v1/properties'));
    expect(limited.status).toBe(429);
    expect((await envelopeOf(limited)).error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('caps a route that declares a limit looser than the AI ceiling', async () => {
    const route = withApiHandler({ rateLimit: { key: 'ai-probe', perMinute: 600 } }, (ctx) =>
      ok(null, ctx.requestId),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await route(post('/api/v1/ai/maintenance/classify', {}))).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.at(-1)).toBe(429);
  });

  it('does not run the handler once limited', async () => {
    const handler = vi.fn((ctx: { requestId: string }) => ok(null, ctx.requestId));
    const route = withApiHandler({ rateLimit: { key: 'probe-429b', perMinute: 1 } }, handler);
    await route(get('/api/v1/properties'));
    await route(get('/api/v1/properties'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ order -- */

describe('the frozen execution order', () => {
  it('authenticates before it authorizes', async () => {
    mocks.state.sessionThrows = new ApiRouteError('UNAUTHENTICATED');
    mocks.state.role = 'tenant';
    const response = await withApiHandler({ roles: ['organization_admin'] }, (ctx) =>
      ok(null, ctx.requestId),
    )(get('/api/v1/members'));
    expect(response.status).toBe(401);
  });

  it('authorizes before it validates, so a schema is not discoverable without a role', async () => {
    mocks.state.role = 'tenant';
    const response = await withApiHandler(
      { roles: ['organization_admin'], bodySchema: z.object({ secretField: z.string() }) },
      (ctx) => ok(null, ctx.requestId),
    )(post('/api/v1/members', { nonsense: true }));
    expect(response.status).toBe(403);
  });

  it('validates before it rate-limits', async () => {
    const route = withApiHandler(
      { bodySchema: z.object({ a: z.string() }), rateLimit: { key: 'probe-order', perMinute: 1 } },
      (ctx) => ok(null, ctx.requestId),
    );
    // A rejected body must not have spent a token, so the next valid call succeeds.
    expect((await route(post('/api/v1/properties', { a: 1 }))).status).toBe(400);
    expect((await route(post('/api/v1/properties', { a: 'ok' }))).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ audit -- */

describe('the audit hook', () => {
  it('writes one row for a successful mutation', async () => {
    const route = withApiHandler(
      { audit: { action: 'property_created', entityType: 'property' } },
      (ctx) => created({ id: 'prop-9' }, ctx.requestId),
    );
    const response = await route(post('/api/v1/properties', {}));

    expect(response.status).toBe(201);
    expect(mocks.auditCalls).toHaveLength(1);
    expect(mocks.auditCalls[0]).toMatchObject({
      action: 'property_created',
      entityType: 'property',
      entityId: 'prop-9',
      organizationId: 'org-1',
    });
  });

  it('takes the organization from trusted membership, never from the request', async () => {
    const route = withApiHandler(
      { audit: { action: 'property_created', entityType: 'property' } },
      (ctx) => created({ id: 'prop-9' }, ctx.requestId),
    );
    await route(
      post('/api/v1/properties?organization_id=org-evil', { organization_id: 'org-evil' }),
    );
    expect(mocks.auditCalls[0]?.organizationId).toBe('org-1');
  });

  it('prefers an entity id the handler supplied', async () => {
    const route = withApiHandler(
      { audit: { action: 'ticket_assigned', entityType: 'maintenance_ticket' } },
      (ctx) => {
        ctx.audit({ entityId: 'ticket-explicit', metadata: { to_status: 'assigned' } });
        return ok({ id: 'ignored' }, ctx.requestId);
      },
    );
    await route(post('/api/v1/maintenance/tickets/t1/assign', {}));
    expect(mocks.auditCalls[0]?.entityId).toBe('ticket-explicit');
  });

  it('writes no row when the request failed', async () => {
    const route = withApiHandler(
      { audit: { action: 'property_created', entityType: 'property' } },
      () => {
        throw notFound();
      },
    );
    await route(post('/api/v1/properties', {}));
    expect(mocks.auditCalls).toHaveLength(0);
  });

  it('writes no row when no audit is declared', async () => {
    await withApiHandler({}, (ctx) => ok({ id: 'x' }, ctx.requestId))(
      post('/api/v1/properties', {}),
    );
    expect(mocks.auditCalls).toHaveLength(0);
  });

  it('leaves the response body intact after reading the entity id from it', async () => {
    const route = withApiHandler(
      { audit: { action: 'property_created', entityType: 'property' } },
      (ctx) => created({ id: 'prop-9', name: 'Marina' }, ctx.requestId),
    );
    const response = await route(post('/api/v1/properties', {}));
    expect(await response.json()).toEqual({ data: { id: 'prop-9', name: 'Marina' } });
  });
});

/* -------------------------------------------------------------- exit gate -- */

/**
 * The W0-L5 exit gate.
 *
 * The briefed gate is "a throwaway probe route returns the exact frozen envelope for
 * 401, 403, 404, 409, 422, 429 and 500". A probe route would have to live under `app/`,
 * which this lane does not own, so the gate is exercised one layer in: against
 * `withApiHandler` itself, which is the only thing a probe route would have added.
 * Everything after the wrapper — Next's router and `Response` serialisation — is
 * framework behaviour, not lane behaviour.
 *
 * Each case asserts the body is *exactly* `{ error: { code, message, request_id } }`.
 */
describe('exit gate: the frozen envelope for every status', () => {
  const cases: {
    status: number;
    code: string;
    arrange: () => Request;
    options?: Parameters<typeof withApiHandler>[0];
    handler?: () => Response;
  }[] = [
    {
      status: 400,
      code: 'VALIDATION_ERROR',
      options: { bodySchema: z.object({ required: z.string() }) },
      arrange: () => post('/api/v1/probe', {}),
    },
    {
      status: 401,
      code: 'UNAUTHENTICATED',
      arrange: () => {
        mocks.state.sessionThrows = new ApiRouteError('UNAUTHENTICATED');
        return get('/api/v1/probe');
      },
    },
    {
      status: 403,
      code: 'FORBIDDEN',
      options: { roles: ['organization_admin'] },
      arrange: () => {
        mocks.state.role = 'tenant';
        return get('/api/v1/probe');
      },
    },
    {
      status: 404,
      code: 'NOT_FOUND',
      arrange: () => get('/api/v1/probe'),
      handler: () => {
        throw notFound();
      },
    },
    {
      status: 409,
      code: 'CONFLICT',
      arrange: () => post('/api/v1/probe', {}),
      handler: () => {
        throw { code: 'P0001', message: 'ticket_status_transition_invalid: open -> completed' };
      },
    },
    {
      status: 422,
      code: 'UNPROCESSABLE',
      arrange: () => post('/api/v1/probe', {}),
      handler: () => {
        throw { code: '23503', message: 'foreign key violation' };
      },
    },
    {
      status: 429,
      code: 'RATE_LIMITED',
      options: { rateLimit: { key: 'exit-gate', perMinute: 1 } },
      arrange: () => get('/api/v1/probe'),
    },
    {
      status: 500,
      code: 'INTERNAL_ERROR',
      arrange: () => get('/api/v1/probe'),
      handler: () => {
        throw new Error('anything at all');
      },
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.status} ${testCase.code}`, async () => {
      const route = withApiHandler(
        testCase.options ?? {},
        testCase.handler ?? ((ctx) => ok(null, ctx.requestId)),
      );

      let response = await route(testCase.arrange());
      // The 429 case needs the bucket drained first; the arrange above spent one token.
      if (testCase.status === 429) response = await route(testCase.arrange());

      expect(response.status).toBe(testCase.status);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-request-id')).toBeTruthy();

      const body = await envelopeOf(response);
      expect(Object.keys(body)).toEqual(['error']);
      expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
      expect(body.error.code).toBe(testCase.code);
      expect(typeof body.error.message).toBe('string');
      expect(body.error.request_id).toBe(response.headers.get('x-request-id'));
    });
  }
});
