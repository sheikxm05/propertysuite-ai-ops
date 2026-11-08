/**
 * The HTTP surface: status codes, the frozen envelope, and the audit row.
 *
 * The three modules mocked below are session resolution, membership resolution and the
 * audit writer — exactly the three `lib/api/__tests__/with-handler.test.ts` mocks, for
 * the same reasons, and each has its own suite or is covered by `tests/rls/**`.
 * Everything else is real: the real `withApiHandler`, the real coarse role gate, the
 * real Zod validation, the real rate limiter, the real error mapper, the real envelope,
 * and this lane's real domain service. The database is the recording double described in
 * `_support/fake-postgrest.ts`.
 *
 * What these tests are for, over and above `service.test.ts`: the service throws
 * decisions, and this file proves those decisions reach the wire as the codes
 * `docs/api-contracts.md` specifies, in the envelope §5.2 freezes, and that a mutation
 * leaves an audit row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ActivityListResponseSchema,
  ActivitySchema,
  TicketListResponseSchema,
  TicketSchema,
  type MemberRole,
} from '@shared/index';

import { fakePostgrest, type FakePostgrest } from './_support/fake-postgrest';
import { worldResponder, type World } from './_support/world';
import {
  ACTIVITY_ID,
  DOCUMENT_ID,
  ORG_A,
  OTHER_PROVIDER_ID,
  OTHER_TENANT_ID,
  PROFILE_ID,
  PROPERTY_ID,
  PROVIDER_ID,
  TENANCY_ID,
  TENANT_ID,
  TICKET_ID,
  UNIT_ID,
  membershipFor,
  ticketRow,
} from './_support/fixtures';

const mocks = vi.hoisted(() => ({
  state: {
    role: 'property_manager' as MemberRole,
    tenantId: undefined as string | null | undefined,
    providerId: undefined as string | null | undefined,
    db: null as FakePostgrest | null,
  },
  auditEntries: [] as {
    action: string;
    entityType: string;
    entityId: unknown;
    organizationId: string;
  }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createRouteHandlerClient: () => ({
    supabase: mocks.state.db?.client,
    pendingCookies: [],
  }),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSessionFromClient: async () => ({
    userId: 'auth-user-1',
    email: 'person@example.com',
    lastSignInAt: null,
  }),
}));

vi.mock('@/lib/auth/roles', async () => {
  const actual = await import('@/lib/auth/roles');
  return {
    ...actual,
    requireMembership: async () => buildMembership(),
  };
});

vi.mock('@/lib/audit/write', () => ({
  writeAuditLog: async (
    _client: unknown,
    entry: { action: string; entityType: string; entityId: unknown; organizationId: string },
  ) => {
    mocks.auditEntries.push(entry);
    return { written: true, auditId: 'audit-1', reason: null };
  },
}));

function buildMembership() {
  const overrides: Record<string, unknown> = {};
  if (mocks.state.tenantId !== undefined) overrides.tenantId = mocks.state.tenantId;
  if (mocks.state.providerId !== undefined) overrides.providerId = mocks.state.providerId;
  return membershipFor(mocks.state.role, overrides);
}

import { resetRateLimits } from '@/lib/rate-limit';

import { GET as listTickets, POST as createTicket } from '@/app/api/v1/maintenance/tickets/route';
import {
  GET as getTicket,
  PATCH as patchTicket,
} from '@/app/api/v1/maintenance/tickets/[ticketId]/route';
import { POST as assignTicket } from '@/app/api/v1/maintenance/tickets/[ticketId]/assign/route';
import { POST as completeTicket } from '@/app/api/v1/maintenance/tickets/[ticketId]/complete/route';
import {
  GET as listActivities,
  POST as addActivity,
} from '@/app/api/v1/maintenance/tickets/[ticketId]/activities/route';

const BASE = 'https://app.example.test';
const UNIT = { id: UNIT_ID, property_id: PROPERTY_ID, unit_number: '1203', status: 'occupied' };
const TENANCY = { id: TENANCY_ID, tenant_id: TENANT_ID, status: 'active' };
const PROPERTY = { id: PROPERTY_ID, name: 'Marina Residence', owner_member_id: null };

interface Envelope {
  error: { code: string; message: string; request_id: string };
}

function scenario(
  role: MemberRole,
  world: World,
  identity: Partial<{ tenantId: string | null; providerId: string | null }> = {},
) {
  mocks.state.role = role;
  mocks.state.tenantId = identity.tenantId;
  mocks.state.providerId = identity.providerId;
  mocks.state.db = fakePostgrest(worldResponder(world));
  return mocks.state.db;
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function routeParams(ticketId = TICKET_ID) {
  return { params: Promise.resolve({ ticketId }) };
}

async function envelopeOf(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}

beforeEach(() => {
  mocks.auditEntries.length = 0;
  mocks.state.tenantId = undefined;
  mocks.state.providerId = undefined;
  resetRateLimits();
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* =============================================================== create ==== */

describe('POST /api/v1/maintenance/tickets', () => {
  const body = {
    property_unit_id: UNIT_ID,
    title: 'Air conditioning not cooling',
    description: 'The AC is running but not cooling the room.',
    category: 'hvac',
  };

  it('creates a ticket for a tenant and returns 201 with a Location header', async () => {
    scenario('tenant', { unit: UNIT, tenancy: TENANCY });
    const response = await createTicket(request('POST', '/api/v1/maintenance/tickets', body));

    expect(response.status).toBe(201);
    expect(response.headers.get('Location')).toBe(`/api/v1/maintenance/tickets/${TICKET_ID}`);
    const payload = (await response.json()) as { data: { status: string; priority: string } };
    expect(payload.data.status).toBe('open');
  });

  it('writes an audit row for the creation', async () => {
    scenario('tenant', { unit: UNIT, tenancy: TENANCY });
    await createTicket(request('POST', '/api/v1/maintenance/tickets', body));

    expect(mocks.auditEntries).toHaveLength(1);
    expect(mocks.auditEntries[0]).toMatchObject({
      action: 'ticket_created',
      entityType: 'ticket',
      entityId: TICKET_ID,
      organizationId: ORG_A,
    });
  });

  it('refuses a service_provider with 403 before the body is even parsed', async () => {
    scenario('service_provider', {});
    // A deliberately invalid body: a 403 must not depend on it being well formed, or the
    // schema is discoverable without authorization.
    const response = await createTicket(
      request('POST', '/api/v1/maintenance/tickets', { nonsense: true }),
    );
    expect(response.status).toBe(403);
    expect((await envelopeOf(response)).error.code).toBe('FORBIDDEN');
  });

  it('refuses a property_owner with 403', async () => {
    scenario('property_owner', {});
    const response = await createTicket(request('POST', '/api/v1/maintenance/tickets', body));
    expect(response.status).toBe(403);
  });

  it('rejects a mass-assignment attempt with 400', async () => {
    scenario('tenant', { unit: UNIT, tenancy: TENANCY });
    const response = await createTicket(
      request('POST', '/api/v1/maintenance/tickets', { ...body, status: 'completed' }),
    );
    expect(response.status).toBe(400);
    expect((await envelopeOf(response)).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when the unit is not one the caller may report on', async () => {
    scenario('tenant', { unit: UNIT, tenancy: null });
    const response = await createTicket(request('POST', '/api/v1/maintenance/tickets', body));
    expect(response.status).toBe(422);
    expect((await envelopeOf(response)).error.code).toBe('UNPROCESSABLE');
  });

  it('writes no audit row when the request failed', async () => {
    scenario('tenant', { unit: null });
    await createTicket(request('POST', '/api/v1/maintenance/tickets', body));
    expect(mocks.auditEntries).toHaveLength(0);
  });
});

/* ================================================================= list ==== */

describe('GET /api/v1/maintenance/tickets', () => {
  it('returns the shared { data, page_info } envelope', async () => {
    scenario('property_manager', { ticketList: [ticketRow()] });
    const response = await listTickets(request('GET', '/api/v1/maintenance/tickets'));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: unknown[];
      page_info: { next_cursor: string | null; has_more: boolean; limit: number };
    };
    expect(payload.data).toHaveLength(1);
    expect(payload.page_info).toEqual({ next_cursor: null, has_more: false, limit: 25 });
  });

  it('is never cacheable, because every page is tenant-scoped', async () => {
    scenario('property_manager', { ticketList: [] });
    const response = await listTickets(request('GET', '/api/v1/maintenance/tickets'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('carries a correlation id on every response', async () => {
    scenario('property_manager', { ticketList: [] });
    const response = await listTickets(request('GET', '/api/v1/maintenance/tickets'));
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('returns 400 for a limit above the frozen maximum', async () => {
    scenario('property_manager', { ticketList: [] });
    const response = await listTickets(request('GET', '/api/v1/maintenance/tickets?limit=1000'));
    expect(response.status).toBe(400);
  });

  it('returns 400 for an unknown query parameter', async () => {
    scenario('property_manager', { ticketList: [] });
    const response = await listTickets(
      request('GET', '/api/v1/maintenance/tickets?organization_id=' + ORG_A),
    );
    // `.strict()` on the shared schema: a client trying to name an organization gets a
    // 400 rather than having the field silently ignored.
    expect(response.status).toBe(400);
  });

  it('returns an empty page for a provider with no provider record', async () => {
    scenario('service_provider', { ticketList: [ticketRow()] }, { providerId: null });
    const response = await listTickets(request('GET', '/api/v1/maintenance/tickets'));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: unknown[] };
    expect(payload.data).toEqual([]);
  });

  it('returns an empty page, not a 403, for another provider’s queue', async () => {
    scenario('service_provider', { ticketList: [ticketRow()] });
    const response = await listTickets(
      request('GET', `/api/v1/maintenance/tickets?assigned_provider_id=${OTHER_PROVIDER_ID}`),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

/* =============================================================== detail ==== */

describe('GET /api/v1/maintenance/tickets/{ticketId}', () => {
  it('returns the detail with the timeline and the caller’s transitions', async () => {
    scenario('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      property: PROPERTY,
      unit: UNIT,
      tenant: { id: TENANT_ID, full_name: 'A Tenant' },
    });
    const response = await getTicket(
      request('GET', `/api/v1/maintenance/tickets/${TICKET_ID}`),
      routeParams(),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { available_transitions: string[]; activities: unknown[] };
    };
    expect(payload.data.available_transitions).toEqual(['assigned', 'cancelled']);
    expect(payload.data.activities).toEqual([]);
  });

  it('returns 404 for a ticket the caller cannot see', async () => {
    scenario('tenant', { ticket: null });
    const response = await getTicket(
      request('GET', `/api/v1/maintenance/tickets/${TICKET_ID}`),
      routeParams(),
    );
    expect(response.status).toBe(404);
    expect((await envelopeOf(response)).error.code).toBe('NOT_FOUND');
  });

  it('returns 403 for a ticket the matrix refuses, which RLS should already have hidden', async () => {
    // If this ever fires in production it means RLS handed over a row it should not
    // have. The application layer still refuses — which is the entire point of having
    // two layers — and the reason is logged, never returned.
    scenario('service_provider', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: OTHER_PROVIDER_ID }),
      property: PROPERTY,
    });
    const response = await getTicket(
      request('GET', `/api/v1/maintenance/tickets/${TICKET_ID}`),
      routeParams(),
    );
    expect(response.status).toBe(403);
  });

  it('returns 400 for a path parameter that is not a UUID', async () => {
    scenario('property_manager', { ticket: ticketRow() });
    const response = await getTicket(
      request('GET', '/api/v1/maintenance/tickets/not-a-uuid'),
      routeParams('not-a-uuid'),
    );
    expect(response.status).toBe(400);
  });
});

/* ================================================================ patch ==== */

describe('PATCH /api/v1/maintenance/tickets/{ticketId}', () => {
  it('returns 409 for an illegal edge', async () => {
    scenario('property_manager', { ticket: ticketRow({ status: 'open' }) });
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, { status: 'completed' }),
      routeParams(),
    );
    expect(response.status).toBe(409);
    const envelope = await envelopeOf(response);
    expect(envelope.error.code).toBe('CONFLICT');
    expect(envelope.error.request_id).toBeTruthy();
    // The message names the two states, which the caller can already see.
    expect(envelope.error.message).toContain('open');
  });

  it('returns 403 for a legal edge the role may not drive', async () => {
    scenario('service_provider', {
      ticket: ticketRow({ status: 'awaiting_approval', assignedProviderId: PROVIDER_ID }),
    });
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, { status: 'completed' }),
      routeParams(),
    );
    expect(response.status).toBe(403);
    expect((await envelopeOf(response)).error.code).toBe('FORBIDDEN');
  });

  it('refuses a property_owner at the coarse gate with 403', async () => {
    scenario('property_owner', {});
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, { title: 'Renamed title' }),
      routeParams(),
    );
    expect(response.status).toBe(403);
  });

  it('lets the reporting tenant cancel while the ticket is open', async () => {
    scenario('tenant', { ticket: ticketRow({ status: 'open' }) });
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, { status: 'cancelled' }),
      routeParams(),
    );
    expect(response.status).toBe(200);
    expect(mocks.auditEntries[0]).toMatchObject({ action: 'ticket_updated' });
  });

  it('refuses the reporting tenant once the ticket is assigned, with 403', async () => {
    scenario('tenant', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: PROVIDER_ID }),
    });
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, { status: 'cancelled' }),
      routeParams(),
    );
    expect(response.status).toBe(403);
  });

  it('refuses a tenant acting on another tenant’s ticket with 403', async () => {
    scenario('tenant', { ticket: ticketRow({ status: 'open', tenantId: OTHER_TENANT_ID }) });
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, { status: 'cancelled' }),
      routeParams(),
    );
    expect(response.status).toBe(403);
  });

  it('returns 400 for an empty body', async () => {
    scenario('property_manager', { ticket: ticketRow() });
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, {}),
      routeParams(),
    );
    expect(response.status).toBe(400);
  });

  it('drives the rework edge for a manager', async () => {
    scenario('property_manager', {
      ticket: ticketRow({ status: 'awaiting_approval', assignedProviderId: PROVIDER_ID }),
    });
    const response = await patchTicket(
      request('PATCH', `/api/v1/maintenance/tickets/${TICKET_ID}`, { status: 'in_progress' }),
      routeParams(),
    );
    expect(response.status).toBe(200);
  });
});

/* =============================================================== assign ==== */

describe('POST /api/v1/maintenance/tickets/{ticketId}/assign', () => {
  const ACTIVE_PROVIDER = {
    id: PROVIDER_ID,
    organization_id: ORG_A,
    company_name: 'Cool Air',
    status: 'active',
  };

  it('assigns and writes the audit row', async () => {
    scenario('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: ACTIVE_PROVIDER,
    });
    const response = await assignTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/assign`, {
        provider_id: PROVIDER_ID,
      }),
      routeParams(),
    );

    expect(response.status).toBe(200);
    expect(mocks.auditEntries[0]).toMatchObject({
      action: 'ticket_assigned',
      entityType: 'ticket',
      organizationId: ORG_A,
    });
  });

  for (const role of ['tenant', 'service_provider', 'property_owner'] as const) {
    it(`refuses a ${role} at the coarse gate`, async () => {
      scenario(role, {});
      const response = await assignTicket(
        request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/assign`, {
          provider_id: PROVIDER_ID,
        }),
        routeParams(),
      );
      expect(response.status).toBe(403);
    });
  }

  it('returns 422 for a provider outside the organization', async () => {
    scenario('property_manager', { ticket: ticketRow({ status: 'open' }), provider: null });
    const response = await assignTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/assign`, {
        provider_id: OTHER_PROVIDER_ID,
      }),
      routeParams(),
    );
    expect(response.status).toBe(422);
  });

  it('returns 409 when the ticket is already assigned', async () => {
    scenario('property_manager', {
      ticket: ticketRow({ status: 'assigned', assignedProviderId: OTHER_PROVIDER_ID }),
      provider: ACTIVE_PROVIDER,
    });
    const response = await assignTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/assign`, {
        provider_id: PROVIDER_ID,
      }),
      routeParams(),
    );
    expect(response.status).toBe(409);
  });

  it('rejects a body that tries to set a priority', async () => {
    // `AssignTicketSchema` has no priority field. The deterministic policy owns it.
    scenario('property_manager', {
      ticket: ticketRow({ status: 'open' }),
      provider: ACTIVE_PROVIDER,
    });
    const response = await assignTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/assign`, {
        provider_id: PROVIDER_ID,
        priority: 'urgent',
      }),
      routeParams(),
    );
    expect(response.status).toBe(400);
  });
});

/* ============================================================= complete ==== */

describe('POST /api/v1/maintenance/tickets/{ticketId}/complete', () => {
  const AWAITING = ticketRow({ status: 'awaiting_approval', assignedProviderId: PROVIDER_ID });
  const BODY = { resolution_summary: 'Replaced the compressor.', confirmed: true };

  it('closes the ticket for a manager and writes the audit row', async () => {
    scenario('property_manager', { ticket: AWAITING });
    const response = await completeTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/complete`, BODY),
      routeParams(),
    );
    expect(response.status).toBe(200);
    expect(mocks.auditEntries[0]).toMatchObject({ action: 'ticket_completed' });
  });

  it('closes the ticket for the reporting tenant', async () => {
    scenario('tenant', { ticket: AWAITING });
    const response = await completeTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/complete`, BODY),
      routeParams(),
    );
    expect(response.status).toBe(200);
  });

  it('refuses the assigned provider at the coarse gate', async () => {
    scenario('service_provider', { ticket: AWAITING });
    const response = await completeTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/complete`, BODY),
      routeParams(),
    );
    expect(response.status).toBe(403);
  });

  it('requires confirmed: true — an unconfirmed close is a 400', async () => {
    scenario('property_manager', { ticket: AWAITING });
    for (const confirmed of [undefined, false, 'true', 1]) {
      const body: Record<string, unknown> = { resolution_summary: BODY.resolution_summary };
      if (confirmed !== undefined) body.confirmed = confirmed;
      const response = await completeTicket(
        request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/complete`, body),
        routeParams(),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.auditEntries).toHaveLength(0);
  });

  it('returns 422 for evidence that is not attached to this ticket', async () => {
    scenario('property_manager', { ticket: AWAITING, evidenceCount: 0 });
    const response = await completeTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/complete`, {
        ...BODY,
        evidence_document_ids: [DOCUMENT_ID],
      }),
      routeParams(),
    );
    expect(response.status).toBe(422);
  });

  it('returns 409 from the wrong status', async () => {
    scenario('property_manager', { ticket: ticketRow({ status: 'in_progress' }) });
    const response = await completeTicket(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/complete`, BODY),
      routeParams(),
    );
    expect(response.status).toBe(409);
  });
});

/* =========================================================== activities ==== */

describe('maintenance activities routes', () => {
  it('appends a comment and returns 201', async () => {
    scenario('property_manager', { ticket: ticketRow() });
    const response = await addActivity(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/activities`, {
        activity_type: 'comment_added',
        description: 'Called the tenant.',
      }),
      routeParams(),
    );
    expect(response.status).toBe(201);
    expect(mocks.auditEntries[0]).toMatchObject({
      action: 'ticket_activity_added',
      entityType: 'maintenance_activity',
    });
  });

  it('returns 422 for a server-written activity type', async () => {
    scenario('property_manager', { ticket: ticketRow() });
    const response = await addActivity(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/activities`, {
        activity_type: 'status_changed',
        description: 'Forged.',
      }),
      routeParams(),
    );
    expect(response.status).toBe(422);
  });

  it('returns 400 for an activity type outside the shared enum', async () => {
    scenario('property_manager', { ticket: ticketRow() });
    const response = await addActivity(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/activities`, {
        activity_type: 'invented_type',
        description: 'Nope.',
      }),
      routeParams(),
    );
    expect(response.status).toBe(400);
  });

  it('refuses an actor_profile_id in the body', async () => {
    // An activity row that could name its own author would make the timeline worthless.
    scenario('property_manager', { ticket: ticketRow() });
    const response = await addActivity(
      request('POST', `/api/v1/maintenance/tickets/${TICKET_ID}/activities`, {
        activity_type: 'comment_added',
        description: 'Not me.',
        actor_profile_id: PROFILE_ID,
      }),
      routeParams(),
    );
    expect(response.status).toBe(400);
  });

  it('lists the timeline read-only in the shared envelope', async () => {
    scenario('property_manager', {
      ticket: ticketRow(),
      activities: [
        {
          id: ACTIVITY_ID,
          organization_id: ORG_A,
          ticket_id: TICKET_ID,
          actor_profile_id: PROFILE_ID,
          activity_type: 'ticket_created',
          description: 'Ticket created.',
          metadata: { status: 'open' },
          created_at: '2026-11-01T08:00:00.000+00:00',
        },
      ],
    });
    const response = await listActivities(
      request('GET', `/api/v1/maintenance/tickets/${TICKET_ID}/activities`),
      routeParams(),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { data: unknown[]; page_info: unknown };
    expect(payload.data).toHaveLength(1);
    expect(payload.page_info).toEqual({ next_cursor: null, has_more: false, limit: 25 });
  });

  it('exposes no mutating verb other than POST', async () => {
    const routeModule =
      await import('@/app/api/v1/maintenance/tickets/[ticketId]/activities/route');
    expect(Object.keys(routeModule).sort()).toEqual(['GET', 'POST']);
  });
});

/* ================================================ the A18 output contract == */

describe('both list routes ship through their response contract', () => {
  it('emits exactly the keys TicketSchema declares, and no others', async () => {
    scenario('property_manager', { ticketList: [ticketRow()] });
    const response = await listTickets(request('GET', '/api/v1/maintenance/tickets'));
    const payload = (await response.json()) as { data: Record<string, unknown>[] };

    // The response is the PARSED body, so this is the contract's key set, not the
    // repository's. If a `select` is ever widened, the extra column cannot reach here.
    expect(Object.keys(payload.data[0] ?? {}).sort()).toEqual(
      Object.keys(TicketSchema.shape).sort(),
    );
  });

  it('emits exactly the keys ActivitySchema declares', async () => {
    scenario('property_manager', {
      ticket: ticketRow(),
      activities: [
        {
          id: ACTIVITY_ID,
          organization_id: ORG_A,
          ticket_id: TICKET_ID,
          actor_profile_id: PROFILE_ID,
          activity_type: 'status_changed',
          description: 'Status changed from open to assigned.',
          metadata: { from_status: 'open', to_status: 'assigned' },
          created_at: '2026-11-01T08:00:00.000+00:00',
        },
      ],
    });
    const response = await listActivities(
      request('GET', `/api/v1/maintenance/tickets/${TICKET_ID}/activities`),
      routeParams(),
    );
    const payload = (await response.json()) as { data: Record<string, unknown>[] };
    expect(Object.keys(payload.data[0] ?? {}).sort()).toEqual(
      Object.keys(ActivitySchema.shape).sort(),
    );
  });

  it('FAILS CLOSED on an undeclared column rather than stripping it', () => {
    // Worth stating precisely, because it differs from the general A18 behaviour:
    // `TicketSchema` and `ActivitySchema` are `.strict()`, not plain `z.object()`. A
    // plain object schema strips an undeclared key; a strict one REJECTS it, so
    // `paginated()` raises INTERNAL_ERROR and a 500 ships instead of a sanitised body.
    // Either way nothing undeclared reaches the client, which is the property that
    // matters — but the failure is loud, and that is the better default for a contract
    // this lane's `toTicket`/`toActivity` mappers already satisfy by construction.
    const leaked = {
      data: [{ ...TicketSchema.parse(sampleTicket()), tenant_email: 'leak@example.test' }],
      page_info: { next_cursor: null, has_more: false, limit: 25 },
    };
    const result = TicketListResponseSchema.safeParse(leaked);
    expect(result.success).toBe(false);

    const leakedActivity = {
      data: [{ ...sampleActivity(), actor_email: 'leak@example.test' }],
      page_info: { next_cursor: null, has_more: false, limit: 25 },
    };
    expect(ActivityListResponseSchema.safeParse(leakedActivity).success).toBe(false);
  });

  it('rejects a malformed page_info before it can ship', () => {
    expect(
      TicketListResponseSchema.safeParse({
        data: [],
        page_info: { next_cursor: null, has_more: undefined, limit: 25 },
      }).success,
    ).toBe(false);
  });
});

function sampleTicket() {
  const row = ticketRow();
  return {
    ...row,
    category: 'hvac' as const,
    source: 'web' as const,
  };
}

function sampleActivity() {
  return {
    id: ACTIVITY_ID,
    organization_id: ORG_A,
    ticket_id: TICKET_ID,
    actor_profile_id: PROFILE_ID,
    activity_type: 'comment_added' as const,
    description: 'Noted.',
    metadata: {},
    created_at: '2026-11-01T08:00:00.000+00:00',
  };
}

describe('no route in this lane exposes DELETE', () => {
  it('holds for every maintenance route', async () => {
    const modules = await Promise.all([
      import('@/app/api/v1/maintenance/tickets/route'),
      import('@/app/api/v1/maintenance/tickets/[ticketId]/route'),
      import('@/app/api/v1/maintenance/tickets/[ticketId]/assign/route'),
      import('@/app/api/v1/maintenance/tickets/[ticketId]/complete/route'),
      import('@/app/api/v1/maintenance/tickets/[ticketId]/activities/route'),
    ]);
    for (const routeModule of modules) {
      expect(Object.keys(routeModule)).not.toContain('DELETE');
      expect(Object.keys(routeModule)).not.toContain('PUT');
    }
  });
});
