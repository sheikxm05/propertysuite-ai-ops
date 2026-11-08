/**
 * Role changes and the guards around them. Lane w1-l1.
 *
 * This is the lane's only direct write — every other mutation goes through a
 * security-definer RPC — so it is the only one where the application layer owns the
 * guards rather than inheriting them from `0003`. Four properties are asserted:
 *
 *  1. **The column allowlist is an allowlist.** The UPDATE payload is rebuilt field by
 *     field from `UpdateMemberSchema`'s output, so `organization_id`, `profile_id` and
 *     `id` are unreachable rather than merely rejected. A test that only checked the
 *     response would not notice a payload that carried them.
 *  2. **Authorization is against the stored row.** The target is read first, and
 *     `assertAuthorized` is given the `organization_id` as stored — never a value from
 *     the request.
 *  3. **The last active administrator cannot be removed.** The database would allow it:
 *     there is no INSERT policy on `organization_members` and `invite_member` requires an
 *     admin, so an organization that demotes its only administrator has no legal path
 *     back. This is a genuine application-layer invariant, not a duplicated check.
 *  4. **Every successful change writes exactly one audit row**, carrying identifiers and
 *     decisions and no personal data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const ADMIN_MEMBER_ID = '11111111-aaaa-4111-8aaa-111111111111';
const ADMIN_PROFILE_ID = '22222222-aaaa-4111-8aaa-222222222222';
const TARGET_MEMBER_ID = '55555555-aaaa-4111-8aaa-555555555555';
const TARGET_PROFILE_ID = '66666666-aaaa-4111-8aaa-666666666666';

const mocks = vi.hoisted(() => ({
  state: { client: null as unknown, role: 'organization_admin' as string },
  audits: [] as {
    action: string;
    entityType: string;
    entityId: unknown;
    organizationId: string;
    metadata: Record<string, unknown>;
  }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createRouteHandlerClient: () => ({ supabase: mocks.state.client, pendingCookies: [] }),
  createServerClient: () => Promise.resolve(mocks.state.client),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSessionFromClient: () =>
    Promise.resolve({ userId: 'auth-user-admin', email: 'admin@example.test', lastSignInAt: null }),
}));

vi.mock('@/lib/auth/roles', () => ({
  requireMembership: () =>
    Promise.resolve({
      memberId: ADMIN_MEMBER_ID,
      role: mocks.state.role,
      status: 'active',
      profile: { id: ADMIN_PROFILE_ID, authUserId: 'auth-user-admin', fullName: 'An Admin' },
      organization: {
        id: ORG,
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
    entry: {
      action: string;
      entityType: string;
      entityId: unknown;
      organizationId: string;
      metadata: Record<string, unknown>;
    },
  ) => {
    mocks.audits.push(entry);
    return Promise.resolve({ written: true, auditId: 'audit-1', reason: null });
  },
}));

import { PATCH as patchMemberRoute } from '@/app/api/v1/members/[memberId]/route';
import { resetRateLimits } from '@/lib/rate-limit';
import { MemberSchema } from '@shared/index';

import { createFakeClient, type RecordedQuery } from './_support/fake-postgrest';

const BASE = 'https://app.example.test';

function patch(memberId: string, body: unknown): Request {
  return new Request(`${BASE}/api/v1/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) };
}

interface Envelope {
  error: { code: string; message: string; request_id: string };
}

const TARGET_ROW = {
  id: TARGET_MEMBER_ID,
  organization_id: ORG,
  profile_id: TARGET_PROFILE_ID,
  role: 'tenant',
  status: 'active',
};

/**
 * A responder that plays the three queries `updateMember` makes, in order:
 * the identity read, the optional administrator count, and the UPDATE.
 */
function responder(options: {
  target?: Record<string, unknown> | null;
  otherAdmins?: number;
  updated?: Record<string, unknown> | null;
}) {
  return (query: RecordedQuery) => {
    if (query.kind === 'update') {
      return {
        data:
          options.updated === undefined
            ? { ...TARGET_ROW, role: 'property_manager', created_at: '2026-01-01T00:00:00.000Z' }
            : options.updated,
      };
    }
    if (query.selectOptions?.head) {
      return { count: options.otherAdmins ?? 1 };
    }
    return { data: options.target === undefined ? TARGET_ROW : options.target };
  };
}

beforeEach(() => {
  mocks.state.role = 'organization_admin';
  mocks.state.client = null;
  mocks.audits.length = 0;
  resetRateLimits();
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ----------------------------------------------------------- happy path ---- */

describe('an administrator changes a role', () => {
  it('writes only the role column and returns the updated member', async () => {
    const { client, queries } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'property_manager' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    expect(MemberSchema.parse(body.data).role).toBe('property_manager');

    const update = queries.find((q) => q.kind === 'update');
    expect(update?.payload).toEqual({ role: 'property_manager' });
  });

  it('scopes the UPDATE to the caller’s organization as well as to the row id', async () => {
    const { client, queries } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { status: 'disabled' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    const update = queries.find((q) => q.kind === 'update');
    // Both filters, on top of the RLS policy. Any one of the three being sufficient is
    // the property being protected.
    expect(update?.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', args: ['id', TARGET_MEMBER_ID] },
        { op: 'eq', args: ['organization_id', ORG] },
      ]),
    );
  });

  it('writes exactly one audit row, with identifiers and no personal data', async () => {
    const { client } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'property_manager' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(mocks.audits).toHaveLength(1);
    const audit = mocks.audits[0];
    expect(audit?.action).toBe('member.role_changed');
    expect(audit?.entityType).toBe('organization_member');
    expect(audit?.entityId).toBe(TARGET_MEMBER_ID);
    expect(audit?.organizationId).toBe(ORG);
    expect(audit?.metadata).toMatchObject({
      role: 'property_manager',
      changed: ['role'],
    });

    // No name, email or phone number ever enters `audit_logs`.
    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain('@');
    expect(serialised).not.toContain('Admin');
  });

  it('writes no audit row when the change is refused', async () => {
    const { client } = createFakeClient({ onQuery: responder({ target: null }) });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'tenant' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(404);
    // An audit row for a mutation that did not happen is a false record.
    expect(mocks.audits).toEqual([]);
  });
});

/* -------------------------------------------------- the column allowlist --- */

describe('only role and status are writable', () => {
  const forbidden: { name: string; body: Record<string, unknown> }[] = [
    { name: 'organization_id', body: { role: 'tenant', organization_id: OTHER_ORG } },
    { name: 'profile_id', body: { role: 'tenant', profile_id: ADMIN_PROFILE_ID } },
    { name: 'id', body: { role: 'tenant', id: ADMIN_MEMBER_ID } },
    { name: 'created_at', body: { role: 'tenant', created_at: '2020-01-01T00:00:00.000Z' } },
  ];

  for (const { name, body } of forbidden) {
    it(`rejects a body carrying ${name}, without touching the database`, async () => {
      const { client, queries } = createFakeClient({ onQuery: responder({}) });
      mocks.state.client = client;

      const response = await patchMemberRoute(
        patch(TARGET_MEMBER_ID, body),
        params({ memberId: TARGET_MEMBER_ID }),
      );

      // `UpdateMemberSchema` is `.strict()`, so a mass-assignment attempt is a 400 that
      // shows up in the logs rather than a field silently ignored.
      expect(response.status).toBe(400);
      expect(((await response.json()) as Envelope).error.code).toBe('VALIDATION_ERROR');
      expect(queries).toEqual([]);
    });
  }

  it('rejects an empty patch', async () => {
    const { client, queries } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, {}),
      params({ memberId: TARGET_MEMBER_ID }),
    );
    expect(response.status).toBe(400);
    expect(queries).toEqual([]);
  });

  it('rejects status = invited, which belongs to the invitation flow', async () => {
    const { client, queries } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { status: 'invited' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(400);
    expect(queries).toEqual([]);
  });

  it('rejects a role outside the frozen enum', async () => {
    const { client, queries } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'platform_administrator' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(400);
    expect(queries).toEqual([]);
  });
});

/* ------------------------------------------ authorization against the row -- */

describe('authorization uses the stored organization_id', () => {
  it('refuses a member row belonging to another organization', async () => {
    const { client, queries } = createFakeClient({
      onQuery: responder({ target: { ...TARGET_ROW, organization_id: OTHER_ORG } }),
    });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'tenant' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    // `authorize()` stops on `cross_organization` before the matrix is consulted.
    expect(response.status).toBe(403);
    expect(((await response.json()) as Envelope).error.code).toBe('FORBIDDEN');
    // The identity read happened; the UPDATE did not.
    expect(queries.some((q) => q.kind === 'update')).toBe(false);
    expect(mocks.audits).toEqual([]);
  });

  it('answers 404 for a member id that does not resolve', async () => {
    const { client } = createFakeClient({ onQuery: responder({ target: null }) });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'tenant' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    // Not 403: a cross-organization id and a non-existent one must be indistinguishable.
    expect(response.status).toBe(404);
  });

  it('reads the target with a projection that carries no personal data', async () => {
    const { client, queries } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'tenant' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    const identityRead = queries[0];
    expect(identityRead?.columns).toBe('id, organization_id, profile_id, role, status');
    expect(identityRead?.columns).not.toContain('profiles');
    expect(identityRead?.columns).not.toContain('*');
  });
});

/* --------------------------------------------- the last-administrator guard -- */

describe('an organization keeps at least one active administrator', () => {
  const adminTarget = { ...TARGET_ROW, role: 'organization_admin', status: 'active' };

  it('refuses to demote the last active administrator with 409', async () => {
    const { client, queries } = createFakeClient({
      onQuery: responder({ target: adminTarget, otherAdmins: 0 }),
    });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'property_manager' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('An organization must keep at least one active administrator.');

    expect(queries.some((q) => q.kind === 'update')).toBe(false);
    expect(mocks.audits).toEqual([]);
  });

  it('refuses to disable the last active administrator', async () => {
    const { client, queries } = createFakeClient({
      onQuery: responder({ target: adminTarget, otherAdmins: 0 }),
    });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { status: 'disabled' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(409);
    expect(queries.some((q) => q.kind === 'update')).toBe(false);
  });

  it('allows the demotion when another active administrator remains', async () => {
    const { client, queries } = createFakeClient({
      onQuery: responder({ target: adminTarget, otherAdmins: 1 }),
    });
    mocks.state.client = client;

    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'property_manager' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(200);
    expect(queries.some((q) => q.kind === 'update')).toBe(true);
    expect(mocks.audits).toHaveLength(1);
  });

  it('counts other administrators, excluding the target itself', async () => {
    const { client, queries } = createFakeClient({
      onQuery: responder({ target: adminTarget, otherAdmins: 2 }),
    });
    mocks.state.client = client;

    await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'tenant' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    const count = queries.find((q) => q.selectOptions?.head === true);
    expect(count?.selectOptions).toEqual({ count: 'exact', head: true });
    expect(count?.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', args: ['organization_id', ORG] },
        { op: 'eq', args: ['role', 'organization_admin'] },
        { op: 'eq', args: ['status', 'active'] },
        // Without this, the target would count itself and the guard would never fire.
        { op: 'neq', args: ['id', TARGET_MEMBER_ID] },
      ]),
    );
  });

  it('does not run the guard when the target is not an active administrator', async () => {
    const { client, queries } = createFakeClient({ onQuery: responder({}) });
    mocks.state.client = client;

    await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { role: 'organization_admin' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    // Promoting a tenant cannot strand the organization, so no count is issued.
    expect(queries.some((q) => q.selectOptions?.head === true)).toBe(false);
  });

  it('does not run the guard when an administrator stays an active administrator', async () => {
    const { client, queries } = createFakeClient({
      onQuery: responder({ target: adminTarget, otherAdmins: 0 }),
    });
    mocks.state.client = client;

    // A no-op-ish patch that leaves the role and status as they were.
    const response = await patchMemberRoute(
      patch(TARGET_MEMBER_ID, { status: 'active' }),
      params({ memberId: TARGET_MEMBER_ID }),
    );

    expect(response.status).toBe(200);
    expect(queries.some((q) => q.selectOptions?.head === true)).toBe(false);
  });
});
