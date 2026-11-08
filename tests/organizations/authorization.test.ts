/**
 * Who may do what. Lane w1-l1 exit-gate assertion 2: **a non-admin cannot invite.**
 *
 * The strongest form of that claim is not "the request fails" — it is "the request fails
 * *before the database is consulted at all*", which is what the assertions below check by
 * inspecting the recorded RPC list rather than only the status code. A 403 that arrives
 * after the database refused would still be a correct response, but it would mean the
 * application layer contributed nothing, and CLAUDE.md's whole point is that
 * authorization is enforced twice and either layer must be sufficient alone.
 *
 * Three orderings are asserted here, all frozen by §5.2:
 *
 *   authenticate before anything    an anonymous caller learns nothing, not even
 *                                   whether a route exists for their role
 *   role gate before validation     a 403 must not depend on a well-formed body, or the
 *                                   schema becomes discoverable without authorization
 *   nothing before the role gate    no query, no RPC, no rate-limit token spent
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    client: null as unknown,
    role: 'tenant' as string,
    membershipStatus: 'active' as string,
    organizationStatus: 'active' as string,
    sessionPresent: true,
    membershipPresent: true,
    membershipForOrganization: null as unknown,
  },
  audits: [] as unknown[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createRouteHandlerClient: () => ({ supabase: mocks.state.client, pendingCookies: [] }),
  createServerClient: () => Promise.resolve(mocks.state.client),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSessionFromClient: async () => {
    if (!mocks.state.sessionPresent) {
      const { ApiRouteError } = await import('@/lib/api/errors');
      throw new ApiRouteError('UNAUTHENTICATED', { logFields: { reason: 'test_no_session' } });
    }
    return { userId: 'auth-user-1', email: 'someone@example.test', lastSignInAt: null };
  },
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const PROFILE = '22222222-aaaa-4111-8aaa-222222222222';

vi.mock('@/lib/auth/roles', () => ({
  requireMembership: async () => {
    if (!mocks.state.membershipPresent) {
      const { ApiRouteError } = await import('@/lib/api/errors');
      throw new ApiRouteError('FORBIDDEN', { logFields: { reason: 'no_active_membership' } });
    }
    return {
      memberId: '11111111-aaaa-4111-8aaa-111111111111',
      role: mocks.state.role,
      status: mocks.state.membershipStatus,
      profile: { id: PROFILE, authUserId: 'auth-user-1', fullName: 'Someone' },
      organization: {
        id: ORG,
        name: 'Marina Properties',
        slug: 'marina-properties',
        status: mocks.state.organizationStatus,
      },
      tenantId: mocks.state.role === 'tenant' ? '33333333-aaaa-4111-8aaa-333333333333' : null,
      providerId:
        mocks.state.role === 'service_provider' ? '44444444-aaaa-4111-8aaa-444444444444' : null,
    };
  },
  resolveMembershipFor: () => Promise.resolve(mocks.state.membershipForOrganization),
  membershipLogFields: (m: { organization: { id: string }; role: string }) => ({
    organization_id: m.organization.id,
    role: m.role,
  }),
}));

vi.mock('@/lib/audit/write', () => ({
  writeAuditLog: (_client: unknown, entry: unknown) => {
    mocks.audits.push(entry);
    return Promise.resolve({ written: true, auditId: 'audit-1', reason: null });
  },
}));

import { PATCH as patchMemberRoute } from '@/app/api/v1/members/[memberId]/route';
import { GET as listInvitationsRoute } from '@/app/api/v1/members/invitations/route';
import { POST as revokeRoute } from '@/app/api/v1/members/invitations/[invitationId]/revoke/route';
import { POST as inviteRoute } from '@/app/api/v1/members/route';
import { GET as getOrganizationRoute } from '@/app/api/v1/organizations/[organizationId]/route';
import {
  GET as listOrganizationsRoute,
  POST as createOrganizationRoute,
} from '@/app/api/v1/organizations/route';
import { resetRateLimits } from '@/lib/rate-limit';
import { MEMBER_ROLES, type MemberRole } from '@shared/index';

import { createFakeClient } from './_support/fake-postgrest';

const BASE = 'https://app.example.test';
const MEMBER_ID = '55555555-aaaa-4111-8aaa-555555555555';
const INVITATION_ID = '66666666-aaaa-4111-8aaa-666666666666';

const NON_ADMIN_ROLES: readonly MemberRole[] = MEMBER_ROLES.filter(
  (role) => role !== 'organization_admin',
);

function get(path: string): Request {
  return new Request(`${BASE}${path}`, { method: 'GET' });
}

function send(method: 'POST' | 'PATCH', path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) };
}

interface Envelope {
  error: { code: string; message: string; request_id: string };
}

/** Asserts the response is the frozen envelope with the expected code, and nothing else. */
async function expectEnvelope(response: Response, code: string, status: number) {
  expect(response.status).toBe(status);
  const body = (await response.json()) as Envelope;
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
  expect(body.error.code).toBe(code);
  expect(body.error.request_id).toEqual(expect.any(String));
  return body;
}

beforeEach(() => {
  mocks.state.role = 'tenant';
  mocks.state.membershipStatus = 'active';
  mocks.state.organizationStatus = 'active';
  mocks.state.sessionPresent = true;
  mocks.state.membershipPresent = true;
  mocks.state.membershipForOrganization = null;
  mocks.state.client = null;
  mocks.audits.length = 0;
  resetRateLimits();
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------- a non-admin cannot invite ----- */

describe('a non-admin cannot invite', () => {
  for (const role of NON_ADMIN_ROLES) {
    it(`${role} is refused, and the database is never asked`, async () => {
      mocks.state.role = role;
      const { client, rpcs, queries } = createFakeClient({});
      mocks.state.client = client;

      const response = await inviteRoute(
        send('POST', '/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }),
      );

      await expectEnvelope(response, 'FORBIDDEN', 403);
      // The claim that matters: nothing reached Postgres. `invite_member` would have
      // refused too, with SQLSTATE 42501, but the application layer did not rely on it.
      expect(rpcs).toEqual([]);
      expect(queries).toEqual([]);
      // No state change, so no audit row — an audit row for a refused mutation would be
      // a false record.
      expect(mocks.audits).toEqual([]);
    });
  }

  it('refuses before the body is validated, so the schema is not discoverable', async () => {
    mocks.state.role = 'property_manager';
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    // A body that would fail `InviteMemberSchema` several ways over.
    const response = await inviteRoute(
      send('POST', '/api/v1/members', { nonsense: true, role: 'emperor' }),
    );

    // 403, not 400. A validation error here would tell a caller without authorization
    // what shape the body should have had.
    await expectEnvelope(response, 'FORBIDDEN', 403);
    expect(rpcs).toEqual([]);
  });

  it('refuses before a rate-limit token is spent', async () => {
    mocks.state.role = 'tenant';
    const { client } = createFakeClient({});
    mocks.state.client = client;

    // The bucket allows ten a minute. Twenty refused attempts must all be 403, never
    // 429: the limiter runs after the role gate, so a refused caller cannot exhaust an
    // administrator's budget.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await inviteRoute(
        send('POST', '/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }),
      );
      statuses.push(response.status);
    }

    expect(new Set(statuses)).toEqual(new Set([403]));
  });

  for (const role of NON_ADMIN_ROLES) {
    it(`${role} cannot list invitations`, async () => {
      mocks.state.role = role;
      const { client, queries } = createFakeClient({ onQuery: () => ({ data: [] }) });
      mocks.state.client = client;

      const response = await listInvitationsRoute(get('/api/v1/members/invitations'));
      await expectEnvelope(response, 'FORBIDDEN', 403);
      expect(queries).toEqual([]);
    });

    it(`${role} cannot revoke an invitation`, async () => {
      mocks.state.role = role;
      const { client, rpcs } = createFakeClient({});
      mocks.state.client = client;

      const response = await revokeRoute(
        send('POST', `/api/v1/members/invitations/${INVITATION_ID}/revoke`),
        params({ invitationId: INVITATION_ID }),
      );
      await expectEnvelope(response, 'FORBIDDEN', 403);
      expect(rpcs).toEqual([]);
    });

    it(`${role} cannot change a member's role`, async () => {
      mocks.state.role = role;
      const { client, queries } = createFakeClient({});
      mocks.state.client = client;

      const response = await patchMemberRoute(
        send('PATCH', `/api/v1/members/${MEMBER_ID}`, { role: 'organization_admin' }),
        params({ memberId: MEMBER_ID }),
      );

      await expectEnvelope(response, 'FORBIDDEN', 403);
      // Not even a read: privilege escalation is refused before the target row is
      // looked up, so the attempt discloses nothing about who exists.
      expect(queries).toEqual([]);
      expect(mocks.audits).toEqual([]);
    });
  }
});

/* -------------------------------------------------- authentication first ---- */

describe('an unauthenticated caller learns nothing', () => {
  const cases: { name: string; call: () => Promise<Response> }[] = [
    {
      name: 'POST /members',
      call: () =>
        inviteRoute(send('POST', '/api/v1/members', { email: 'a@b.test', role: 'tenant' })),
    },
    {
      name: 'GET /members/invitations',
      call: () => listInvitationsRoute(get('/api/v1/members/invitations')),
    },
    {
      name: 'GET /organizations',
      call: () => listOrganizationsRoute(get('/api/v1/organizations')),
    },
    {
      name: 'POST /organizations',
      call: () =>
        createOrganizationRoute(
          send('POST', '/api/v1/organizations', { name: 'X Ltd', slug: 'x-ltd' }),
        ),
    },
    {
      name: 'PATCH /members/{id}',
      call: () =>
        patchMemberRoute(
          send('PATCH', `/api/v1/members/${MEMBER_ID}`, { role: 'tenant' }),
          params({ memberId: MEMBER_ID }),
        ),
    },
  ];

  for (const { name, call } of cases) {
    it(`${name} answers 401 with the frozen envelope`, async () => {
      mocks.state.sessionPresent = false;
      const { client, queries, rpcs } = createFakeClient({});
      mocks.state.client = client;

      await expectEnvelope(await call(), 'UNAUTHENTICATED', 401);
      expect(queries).toEqual([]);
      expect(rpcs).toEqual([]);
    });
  }

  it('answers 401 as HTML-free JSON, never a redirect to the sign-in page', async () => {
    // `middleware.ts` deliberately does not guard `/api/**`: an API client must get the
    // envelope, not a 307 to an HTML page it cannot parse.
    mocks.state.sessionPresent = false;
    const { client } = createFakeClient({});
    mocks.state.client = client;

    const response = await listInvitationsRoute(get('/api/v1/members/invitations'));
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('location')).toBeNull();
  });
});

/* -------------------------------------------------- membership preconditions */

describe('membership preconditions', () => {
  it('refuses a caller with no membership at all', async () => {
    mocks.state.membershipPresent = false;
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    await expectEnvelope(
      await inviteRoute(send('POST', '/api/v1/members', { email: 'a@b.test', role: 'tenant' })),
      'FORBIDDEN',
      403,
    );
    expect(rpcs).toEqual([]);
  });

  it('refuses a disabled administrator', async () => {
    mocks.state.role = 'organization_admin';
    mocks.state.membershipStatus = 'disabled';
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    // The wrapper's coarse role gate passes — the role *is* administrator — and
    // `authorize()` refuses on `membership_not_active`. This is precisely the case the
    // §5.2 note means by "the matrix check is separate".
    await expectEnvelope(
      await inviteRoute(send('POST', '/api/v1/members', { email: 'a@b.test', role: 'tenant' })),
      'FORBIDDEN',
      403,
    );
    expect(rpcs).toEqual([]);
  });

  it('refuses an administrator of a suspended organization', async () => {
    mocks.state.role = 'organization_admin';
    mocks.state.organizationStatus = 'suspended';
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    await expectEnvelope(
      await inviteRoute(send('POST', '/api/v1/members', { email: 'a@b.test', role: 'tenant' })),
      'FORBIDDEN',
      403,
    );
    expect(rpcs).toEqual([]);
  });
});

/* ------------------------------------------------- cross-organization ------ */

describe('cross-organization access', () => {
  it('answers 404, not 403, for an organization the caller is not a member of', async () => {
    mocks.state.role = 'organization_admin';
    // `resolveMembershipFor` finds nothing: the caller holds no membership there.
    mocks.state.membershipForOrganization = null;
    const { client, queries } = createFakeClient({ onQuery: () => ({ data: [] }) });
    mocks.state.client = client;

    const response = await getOrganizationRoute(
      get(`/api/v1/organizations/${OTHER_ORG}`),
      params({ organizationId: OTHER_ORG }),
    );

    // 404 rather than 403: confirming that an organization exists is itself a
    // disclosure, and an RLS-denied read returns zero rows, not an error.
    await expectEnvelope(response, 'NOT_FOUND', 404);
    // The query is never issued, because membership resolution already answered.
    expect(queries).toEqual([]);
  });

  it('rejects an organization id that is not a UUID', async () => {
    mocks.state.role = 'organization_admin';
    const { client } = createFakeClient({});
    mocks.state.client = client;

    await expectEnvelope(
      await getOrganizationRoute(get('/api/v1/organizations/x'), params({ organizationId: 'x' })),
      'VALIDATION_ERROR',
      400,
    );
  });

  it('scopes the organization list to the caller without any filter they control', async () => {
    mocks.state.role = 'property_manager';
    const { client, queries } = createFakeClient({
      onQuery: () => ({
        data: [
          {
            id: ORG,
            name: 'Marina Properties',
            slug: 'marina-properties',
            status: 'active',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    });
    mocks.state.client = client;

    const response = await listOrganizationsRoute(
      get(`/api/v1/organizations?organization_id=${OTHER_ORG}`),
    );
    expect(response.status).toBe(200);

    // The query carries no organization filter at all: RLS decides, and there is
    // nothing in the request for the handler to believe.
    const filters = queries[0]?.filters ?? [];
    expect(filters).toEqual([]);
    expect(queries[0]?.columns).not.toContain('*');
  });
});

/* -------------------------------------------- no rename path, no delete ---- */

describe('the organization surface is read-only', () => {
  it('exports no PATCH, PUT or DELETE on either organization route', async () => {
    const [collection, single] = await Promise.all([
      import('@/app/api/v1/organizations/route'),
      import('@/app/api/v1/organizations/[organizationId]/route'),
    ]);

    // §5.9 records "organizations is read-only for every role, including
    // organization_admin" as a deliberate non-change. A route here would be a 403 at
    // the database and a confusing 500 above it.
    for (const routeModule of [collection, single]) {
      const handlers = Object.keys(routeModule);
      expect(handlers).not.toContain('PATCH');
      expect(handlers).not.toContain('PUT');
      expect(handlers).not.toContain('DELETE');
    }
  });

  it('exports no DELETE on the member route', async () => {
    const routeModule = await import('@/app/api/v1/members/[memberId]/route');
    expect(Object.keys(routeModule)).toEqual(['PATCH']);
  });
});
