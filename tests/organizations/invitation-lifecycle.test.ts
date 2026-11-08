/**
 * The invitation lifecycle, driven through the real route handlers. Lane w1-l1
 * exit-gate assertion 1.
 *
 * issue → list → accept → revoke, plus the refusals at each step.
 *
 * **What is real here and what is not.** The route modules are imported and invoked as
 * Next.js would invoke them. `withApiHandler` is real, so authentication ordering, the
 * role gate, Zod validation, rate limiting, the audit hook and the frozen error envelope
 * are all the production implementations. `authorize()` is real. Every schema is real,
 * and every response is parsed with the frozen schema on the way out.
 *
 * Three modules are replaced: the session, the membership resolver and the Supabase
 * transport. `.env.local` has no anon or service-role key, so `@supabase/supabase-js`
 * cannot authenticate against the project — the HTTP path genuinely cannot run. The two
 * auth modules are replaced rather than faked around because they are w0-l5's code with
 * their own suite, and `tests/rls/**` exercises them against real Postgres.
 *
 * What that means for the claims below: everything asserted here is a property of **this
 * lane's code** — which RPC was called with which arguments, what the envelope says, what
 * reached the audit row, what reached the log. The database's own refusals are simulated
 * from the exact SQLSTATEs `0003` raises, and the *real* ones are asserted by
 * `live-invitation-lifecycle.test.ts` in this directory against the live database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  state: {
    /** Set per test. `withApiHandler` and the handlers both receive this. */
    client: null as unknown,
    role: 'organization_admin' as string,
    membershipStatus: 'active' as string,
    organizationId: '11111111-1111-4111-8111-111111111111',
    profileId: '22222222-aaaa-4111-8aaa-222222222222',
    memberId: '11111111-aaaa-4111-8aaa-111111111111',
    sessionPresent: true,
  },
  audits: [] as { action: string; entityType: string; entityId: unknown; metadata: unknown }[],
  logLines: [] as { message: string; fields: unknown }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createRouteHandlerClient: () => ({ supabase: mocks.state.client, pendingCookies: [] }),
  createServerClient: () => Promise.resolve(mocks.state.client),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSessionFromClient: () => {
    if (!mocks.state.sessionPresent) {
      throw Object.assign(new Error('no session'), { name: 'ApiRouteError' });
    }
    return Promise.resolve({
      userId: 'auth-user-admin',
      email: 'admin@example.test',
      lastSignInAt: null,
    });
  },
}));

vi.mock('@/lib/auth/roles', () => ({
  requireMembership: () =>
    Promise.resolve({
      memberId: mocks.state.memberId,
      role: mocks.state.role,
      status: mocks.state.membershipStatus,
      profile: { id: mocks.state.profileId, authUserId: 'auth-user-admin', fullName: 'An Admin' },
      organization: {
        id: mocks.state.organizationId,
        name: 'Marina Properties',
        slug: 'marina-properties',
        status: 'active',
      },
      tenantId: null,
      providerId: null,
    }),
  resolveMembershipFor: () => Promise.resolve(null),
  membershipLogFields: (m: { organization: { id: string }; role: string }) => ({
    organization_id: m.organization.id,
    role: m.role,
  }),
}));

vi.mock('@/lib/audit/write', () => ({
  writeAuditLog: (
    _client: unknown,
    entry: { action: string; entityType: string; entityId: unknown; metadata: unknown },
  ) => {
    mocks.audits.push(entry);
    return Promise.resolve({ written: true, auditId: 'audit-1', reason: null });
  },
}));

import { POST as acceptRoute } from '@/app/api/v1/members/accept/route';
import { GET as listInvitationsRoute } from '@/app/api/v1/members/invitations/route';
import { POST as revokeRoute } from '@/app/api/v1/members/invitations/[invitationId]/revoke/route';
import { GET as listMembersRoute, POST as inviteRoute } from '@/app/api/v1/members/route';
import { resetRateLimits } from '@/lib/rate-limit';
import {
  AcceptInvitationResultSchema,
  InvitationSchema,
  InviteMemberResultSchema,
  RevokeInvitationResultSchema,
} from '@shared/index';

import { createFakeClient, type RecordedRpc } from './_support/fake-postgrest';

const BASE = 'https://app.example.test';
const ORG = mocks.state.organizationId;
const INVITATION_ID = '33333333-cccc-4111-8ccc-333333333333';
const PLAINTEXT_TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

/* ----------------------------------------------------------------- helpers -- */

function get(path: string): Request {
  return new Request(`${BASE}${path}`, { method: 'GET' });
}

function post(path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/** The `{ params }` second argument Next.js passes to a dynamic route. */
function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) };
}

interface Envelope {
  error: { code: string; message: string; request_id: string };
}

/** A `0003` refusal, shaped exactly as PostgREST surfaces one. */
function pgError(sqlstate: string, token: string) {
  return { error: { code: sqlstate, message: `${token}: refused by the database` } };
}

const INVITATION_ROW = {
  id: INVITATION_ID,
  organization_id: ORG,
  email: 'invitee@example.test',
  role: 'property_manager',
  status: 'pending',
  invited_by_profile_id: mocks.state.profileId,
  accepted_profile_id: null,
  expires_at: '2026-03-20T09:00:00.000Z',
  accepted_at: null,
  created_at: '2026-03-13T09:00:00.000Z',
};

beforeEach(() => {
  mocks.state.role = 'organization_admin';
  mocks.state.membershipStatus = 'active';
  mocks.state.sessionPresent = true;
  mocks.state.client = null;
  mocks.audits.length = 0;
  mocks.logLines.length = 0;
  resetRateLimits();
  // The logger writes a JSON line per request. Capture it instead of printing it — and
  // then assert on what it contains, because "the token is never logged" is a claim that
  // deserves a test rather than a comment.
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    mocks.logLines.push({ message: String(chunk), fields: null });
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------- 1. issue ------- */

describe('step 1 — an administrator issues an invitation', () => {
  it('calls invite_member with the organization from the membership, not from the body', async () => {
    const { client, rpcs } = createFakeClient({
      onRpc: () => ({
        data: {
          invitation_id: INVITATION_ID,
          token: PLAINTEXT_TOKEN,
          role: 'property_manager',
          expires_at: '2026-03-20T09:00:00.000Z',
        },
      }),
    });
    mocks.state.client = client;

    const response = await inviteRoute(
      post('/api/v1/members', { email: 'Invitee@Example.test', role: 'property_manager' }),
    );

    expect(response.status).toBe(201);
    expect(rpcs).toHaveLength(1);

    const call = rpcs[0] as RecordedRpc;
    expect(call.name).toBe('invite_member');
    // The organization is the caller's own, resolved from trusted rows. There is no
    // argument on the route through which a different one could be named.
    expect(call.args.p_org).toBe(ORG);
    // EmailSchema lowercases and trims before the value reaches the database.
    expect(call.args.p_email).toBe('invitee@example.test');
    expect(call.args.p_role).toBe('property_manager');
  });

  it('returns the plaintext token exactly once, under the frozen result schema', async () => {
    const { client } = createFakeClient({
      onRpc: () => ({
        data: {
          invitation_id: INVITATION_ID,
          token: PLAINTEXT_TOKEN,
          role: 'tenant',
          expires_at: '2026-03-20T09:00:00.000Z',
        },
      }),
    });
    mocks.state.client = client;

    const response = await inviteRoute(
      post('/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }),
    );
    const body = (await response.json()) as { data: unknown };

    // Parsed with the frozen schema, which is `.strict()`: an extra key would fail here.
    const parsed = InviteMemberResultSchema.parse(body.data);
    expect(parsed.token).toBe(PLAINTEXT_TOKEN);
    expect(parsed.invitation_id).toBe(INVITATION_ID);
  });

  it('never writes the token to a log line or an audit row', async () => {
    const { client } = createFakeClient({
      onRpc: () => ({
        data: {
          invitation_id: INVITATION_ID,
          token: PLAINTEXT_TOKEN,
          role: 'tenant',
          expires_at: '2026-03-20T09:00:00.000Z',
        },
      }),
    });
    mocks.state.client = client;

    await inviteRoute(post('/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }));

    const logged = mocks.logLines.map((line) => line.message).join('\n');
    expect(logged).not.toContain(PLAINTEXT_TOKEN);
    // The invitee's address is personal data and is not on the logger's allowlist either.
    expect(logged).not.toContain('invitee@example.test');
    // `invite_member` audits itself inside its own transaction, so the wrapper writes
    // nothing — one state change, one audit row.
    expect(mocks.audits).toEqual([]);
  });

  it('sets no-store, so no shared cache retains the token', async () => {
    const { client } = createFakeClient({
      onRpc: () => ({
        data: {
          invitation_id: INVITATION_ID,
          token: PLAINTEXT_TOKEN,
          role: 'tenant',
          expires_at: '2026-03-20T09:00:00.000Z',
        },
      }),
    });
    mocks.state.client = client;

    const response = await inviteRoute(
      post('/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }),
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a body that tries to name an organization', async () => {
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    const response = await inviteRoute(
      post('/api/v1/members', {
        email: 'invitee@example.test',
        role: 'tenant',
        organization_id: '22222222-2222-4222-8222-222222222222',
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // `InviteMemberSchema` is `.strict()`, so the attempt never reaches the database.
    expect(rpcs).toEqual([]);
  });

  it('maps a duplicate pending invitation to 409', async () => {
    const { client } = createFakeClient({
      onRpc: () => pgError('P0001', 'invitation_already_pending'),
    });
    mocks.state.client = client;

    const response = await inviteRoute(
      post('/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('A live invitation for that email address already exists.');
    expect(body.error.request_id).toEqual(expect.any(String));
  });

  it('maps an existing membership to 409', async () => {
    const { client } = createFakeClient({
      onRpc: () => pgError('P0001', 'member_already_exists'),
    });
    mocks.state.client = client;

    const response = await inviteRoute(
      post('/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }),
    );
    expect(response.status).toBe(409);
  });

  it('maps a database-level authorization refusal to 403', async () => {
    // Belt and braces: the wrapper's role gate already refused a non-admin, so reaching
    // this SQLSTATE at all means the gate was bypassed. It must still be a 403.
    const { client } = createFakeClient({
      onRpc: () => pgError('42501', 'member_invite_forbidden'),
    });
    mocks.state.client = client;

    const response = await inviteRoute(
      post('/api/v1/members', { email: 'invitee@example.test', role: 'tenant' }),
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as Envelope).error.code).toBe('FORBIDDEN');
  });
});

/* ----------------------------------------------------------- 2. list ------- */

describe('step 2 — the administrator lists invitations', () => {
  it('returns the granted columns with cursor page info', async () => {
    const { client, queries } = createFakeClient({
      onQuery: () => ({ data: [INVITATION_ROW] }),
    });
    mocks.state.client = client;

    const response = await listInvitationsRoute(get('/api/v1/members/invitations'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: unknown[];
      page_info: { next_cursor: string | null; has_more: boolean; limit: number };
    };

    expect(body.data).toHaveLength(1);
    InvitationSchema.parse(body.data[0]);
    expect(body.page_info).toEqual({ next_cursor: null, has_more: false, limit: 25 });

    // The projection, as sent. No star, no token_hash.
    expect(queries[0]?.columns).not.toContain('*');
    expect(queries[0]?.columns).not.toContain('token_hash');
  });

  it('never returns a token_hash even when the transport offers one', async () => {
    // A column-level grant means PostgREST would refuse, but if the grant were ever
    // widened, `InvitationSchema` is `.strict()` and would still refuse to serialise it.
    const { client } = createFakeClient({
      onQuery: () => ({ data: [{ ...INVITATION_ROW, token_hash: 'deadbeef' }] }),
    });
    mocks.state.client = client;

    const response = await listInvitationsRoute(get('/api/v1/members/invitations'));
    const body = (await response.json()) as { data: Record<string, unknown>[] };
    expect(Object.keys(body.data[0] ?? {})).not.toContain('token_hash');
  });

  it('honours a status filter and the frozen page-size maximum', async () => {
    const { client, queries } = createFakeClient({ onQuery: () => ({ data: [] }) });
    mocks.state.client = client;

    const ok = await listInvitationsRoute(
      get('/api/v1/members/invitations?status=pending&limit=100'),
    );
    expect(ok.status).toBe(200);
    expect(queries[0]?.filters).toEqual(
      expect.arrayContaining([{ op: 'eq', args: ['status', 'pending'] }]),
    );

    const tooLarge = await listInvitationsRoute(get('/api/v1/members/invitations?limit=101'));
    expect(tooLarge.status).toBe(400);
    expect(((await tooLarge.json()) as Envelope).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown status rather than ignoring it', async () => {
    const { client, queries } = createFakeClient({ onQuery: () => ({ data: [] }) });
    mocks.state.client = client;

    const response = await listInvitationsRoute(get('/api/v1/members/invitations?status=expired'));
    expect(response.status).toBe(400);
    expect(queries).toEqual([]);
  });
});

/* --------------------------------------------------------- 3. accept ------- */

describe('step 3 — the invitee accepts', () => {
  it('passes the token in the body to accept_invitation and returns the membership', async () => {
    const { client, rpcs } = createFakeClient({
      onRpc: () => ({
        data: { organization_id: ORG, member_id: mocks.state.memberId, role: 'property_manager' },
      }),
    });
    mocks.state.client = client;

    const response = await acceptRoute(
      post('/api/v1/members/accept', { invitation_token: PLAINTEXT_TOKEN }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    const parsed = AcceptInvitationResultSchema.parse(body.data);
    expect(parsed.organization_id).toBe(ORG);
    expect(parsed.role).toBe('property_manager');

    expect(rpcs[0]?.name).toBe('accept_invitation');
    expect(rpcs[0]?.args).toEqual({ p_token: PLAINTEXT_TOKEN });
  });

  it('does not log the token it just consumed', async () => {
    const { client } = createFakeClient({
      onRpc: () => ({
        data: { organization_id: ORG, member_id: mocks.state.memberId, role: 'tenant' },
      }),
    });
    mocks.state.client = client;

    await acceptRoute(post('/api/v1/members/accept', { invitation_token: PLAINTEXT_TOKEN }));
    expect(mocks.logLines.map((l) => l.message).join('\n')).not.toContain(PLAINTEXT_TOKEN);
  });

  it('answers an unknown, consumed or expired token with one indistinguishable 409', async () => {
    const { client } = createFakeClient({
      onRpc: () => pgError('P0001', 'invitation_invalid_or_expired'),
    });
    mocks.state.client = client;

    const response = await acceptRoute(
      post('/api/v1/members/accept', { invitation_token: PLAINTEXT_TOKEN }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Envelope;
    // The database deliberately cannot distinguish the three cases, and this message
    // must not reintroduce the distinction.
    expect(body.error.message).toBe('That invitation is not valid.');
  });

  it('refuses a token issued to a different account with 403', async () => {
    const { client } = createFakeClient({
      onRpc: () => pgError('42501', 'invitation_recipient_mismatch'),
    });
    mocks.state.client = client;

    const response = await acceptRoute(
      post('/api/v1/members/accept', { invitation_token: PLAINTEXT_TOKEN }),
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as Envelope).error.message).toBe(
      'That invitation was issued to a different account.',
    );
  });

  it('rate-limits guessing to five attempts a minute', async () => {
    const { client } = createFakeClient({
      onRpc: () => pgError('P0001', 'invitation_invalid_or_expired'),
    });
    mocks.state.client = client;

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await acceptRoute(
        post('/api/v1/members/accept', { invitation_token: PLAINTEXT_TOKEN }),
      );
      statuses.push(response.status);
    }

    // Guessing must get expensive: this is the one endpoint where a wrong answer is
    // still informative.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('rejects a token that is too short to be one, without calling the database', async () => {
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    const response = await acceptRoute(post('/api/v1/members/accept', { invitation_token: 'abc' }));
    expect(response.status).toBe(400);
    expect(rpcs).toEqual([]);
  });

  it('rejects a token supplied in the query string instead of the body', async () => {
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    const response = await acceptRoute(
      new Request(`${BASE}/api/v1/members/accept?invitation_token=${PLAINTEXT_TOKEN}`, {
        method: 'POST',
      }),
    );

    // No body at all: `AcceptInvitationSchema` rejects, and nothing reads the query
    // string — which is the point, because a URL ends up in logs and history.
    expect(response.status).toBe(400);
    expect(rpcs).toEqual([]);
  });
});

/* --------------------------------------------------------- 4. revoke ------- */

describe('step 4 — the administrator revokes', () => {
  it('revokes by id and returns the archived status', async () => {
    const { client, rpcs } = createFakeClient({
      onRpc: () => ({ data: { invitation_id: INVITATION_ID, status: 'revoked' } }),
    });
    mocks.state.client = client;

    const response = await revokeRoute(
      post(`/api/v1/members/invitations/${INVITATION_ID}/revoke`),
      params({ invitationId: INVITATION_ID }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    expect(RevokeInvitationResultSchema.parse(body.data)).toEqual({
      invitation_id: INVITATION_ID,
      status: 'revoked',
    });

    expect(rpcs[0]?.name).toBe('revoke_invitation');
    // An id, never a token: no path through this route can disclose one.
    expect(rpcs[0]?.args).toEqual({ p_invitation_id: INVITATION_ID });
    expect(JSON.stringify(rpcs[0]?.args)).not.toContain(PLAINTEXT_TOKEN);
  });

  it('rejects a path parameter that is not a UUID before calling the database', async () => {
    const { client, rpcs } = createFakeClient({});
    mocks.state.client = client;

    const response = await revokeRoute(
      post('/api/v1/members/invitations/not-a-uuid/revoke'),
      params({ invitationId: 'not-a-uuid' }),
    );

    expect(response.status).toBe(400);
    expect(rpcs).toEqual([]);
  });

  it('gives one answer for "no such invitation" and "not yours"', async () => {
    const { client } = createFakeClient({
      onRpc: () => pgError('42501', 'invitation_revoke_forbidden'),
    });
    mocks.state.client = client;

    const response = await revokeRoute(
      post(`/api/v1/members/invitations/${INVITATION_ID}/revoke`),
      params({ invitationId: INVITATION_ID }),
    );

    expect(response.status).toBe(403);
    // Not "that invitation belongs to another organization" — that would be an oracle.
    expect(((await response.json()) as Envelope).error.message).toBe(
      'That invitation cannot be revoked.',
    );
  });

  it('refuses to revoke an invitation that is no longer pending', async () => {
    const { client } = createFakeClient({
      onRpc: () => pgError('P0001', 'invitation_not_pending'),
    });
    mocks.state.client = client;

    const response = await revokeRoute(
      post(`/api/v1/members/invitations/${INVITATION_ID}/revoke`),
      params({ invitationId: INVITATION_ID }),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Envelope).error.message).toBe(
      'That invitation is no longer pending.',
    );
  });

  it('exposes no DELETE handler on any invitation or member route', async () => {
    const [invitations, revoke, members, accept] = await Promise.all([
      import('@/app/api/v1/members/invitations/route'),
      import('@/app/api/v1/members/invitations/[invitationId]/revoke/route'),
      import('@/app/api/v1/members/route'),
      import('@/app/api/v1/members/accept/route'),
    ]);

    for (const routeModule of [invitations, revoke, members, accept]) {
      expect(Object.keys(routeModule)).not.toContain('DELETE');
      expect(Object.keys(routeModule)).not.toContain('PUT');
    }
  });
});

/* ------------------------------------------------- the A18 list envelope -- */

describe('every list route emits the amendment A18 envelope', () => {
  /**
   * The envelope was defined twice during Wave 0 — `listResponseSchema()` in
   * `packages/shared` emitted `{ data, page_info: { … } }` and `paginated()` in
   * `lib/api/responses.ts` emitted a flat `{ data, next_cursor }`. Amendment A18 ruled
   * for the `packages/shared` shape. These assertions pin it from the outside, so a
   * regression in either module shows up as a failing list route rather than as two
   * API shapes in production.
   */
  const routes: { name: string; call: () => Promise<Response> }[] = [
    { name: 'GET /members', call: () => listMembersRoute(get('/api/v1/members')) },
    {
      name: 'GET /members/invitations',
      call: () => listInvitationsRoute(get('/api/v1/members/invitations')),
    },
  ];

  for (const { name, call } of routes) {
    it(`${name} nests page_info and carries has_more`, async () => {
      const { client } = createFakeClient({ onQuery: () => ({ data: [] }) });
      mocks.state.client = client;

      const response = await call();
      expect(response.status).toBe(200);

      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['data', 'page_info']);
      // The rejected shape: a flat `next_cursor` beside `data`.
      expect(body).not.toHaveProperty('next_cursor');

      expect(Object.keys(body.page_info as object).sort()).toEqual([
        'has_more',
        'limit',
        'next_cursor',
      ]);
      // `has_more` is the field a flat cursor cannot express: on an RLS-filtered list a
      // short page is normal, so a client needs this to tell "last page" from "lost
      // cursor".
      expect((body.page_info as { has_more: unknown }).has_more).toBe(false);
      expect((body.page_info as { limit: unknown }).limit).toBe(25);
    });
  }
});

/* ------------------------------------------------- the roster, afterwards -- */

describe('after acceptance the member appears on the roster', () => {
  it('lists the accepted member with their granted role', async () => {
    const acceptedRow = {
      id: '44444444-dddd-4111-8ddd-444444444444',
      organization_id: ORG,
      profile_id: '55555555-eeee-4111-8eee-555555555555',
      role: 'property_manager',
      status: 'active',
      created_at: '2026-03-14T09:00:00.000Z',
      profiles: {
        id: '55555555-eeee-4111-8eee-555555555555',
        full_name: 'A New Manager',
        email: 'invitee@example.test',
        phone: null,
      },
    };

    const { client } = createFakeClient({ onQuery: () => ({ data: [acceptedRow] }) });
    mocks.state.client = client;

    const response = await listMembersRoute(get('/api/v1/members'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: { role: string; status: string; profile: { email: string | null } | null }[];
    };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.role).toBe('property_manager');
    expect(body.data[0]?.status).toBe('active');
    // The caller is an administrator, so same-organization contact details are theirs
    // to read per the §4 `profiles` row.
    expect(body.data[0]?.profile?.email).toBe('invitee@example.test');
  });
});
