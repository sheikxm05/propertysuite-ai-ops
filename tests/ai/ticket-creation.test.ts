/**
 * The ticket-creation seam. Lane w1-l5.
 *
 * `services/ai/maintenance/ticket-creation.ts` is how an AI-assisted confirmation reaches
 * lane w1-l4's domain service without this lane reimplementing ticket creation or writing
 * `maintenance_tickets` itself. These tests pin the three properties that make the
 * delegation safe:
 *
 *  1. The caller's own credentials are forwarded, so the delegated handler authorizes the
 *     tenant, not this service, and RLS applies as the tenant.
 *  2. The target URL comes from validated configuration, never from a request header — a
 *     `Host`-derived URL with a session cookie attached is server-side request forgery.
 *  3. An upstream refusal propagates under its own frozen error code, and an
 *     unrecognised success body is a failure rather than an unvalidated "ticket".
 *
 * `@/lib/env` needs help because importing it eagerly validates the Supabase public
 * configuration, and this checkout's `.env.local` still has
 * `NEXT_PUBLIC_SUPABASE_ANON_KEY` blank ("NOT YET SUPPLIED"). A `vi.hoisted` block fills
 * the blanks, then `vi.mock` spreads the REAL module and overrides one function — rather
 * than enumerating exports, which broke when lane w0-l5 added `presentValue` to a module
 * this lane does not own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRouteError } from '@/lib/api/errors';
import type { CreateTicketInput } from '@shared/index';

/** Fills only what is blank, so a real local configuration is never overridden. */
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://supabase.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'a'.repeat(40);
});

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    // One override. `createHttpTicketCreationService()` with no argument must reach for
    // `serverEnv().APP_BASE_URL`, and the test asserts which URL it got — so the value
    // has to be this file's, not `.env.local`'s.
    serverEnv: () => ({ ...actual.serverEnv(), APP_BASE_URL: 'https://app.test' }),
  };
});

import {
  MAINTENANCE_TICKETS_PATH,
  createHttpTicketCreationService,
  getTicketCreationService,
  registerTicketCreationService,
  resetTicketCreationService,
} from '@/services/ai/maintenance/ticket-creation';

const INPUT: CreateTicketInput = {
  property_unit_id: '33333333-3333-4333-8333-333333333333',
  title: 'Air conditioning not cooling',
  description: 'The AC is running but not cooling the room.',
  category: 'hvac',
  priority: 'high',
  source: 'web',
};

const CALLER = {
  requestId: 'req-1',
  cookieHeader: 'sb-access-token=abc',
  authorizationHeader: null,
};

const TICKET = {
  id: '99999999-9999-4999-8999-999999999999',
  organization_id: '11111111-1111-4111-8111-111111111111',
  property_id: '55555555-5555-4555-8555-555555555555',
  property_unit_id: INPUT.property_unit_id,
  tenancy_id: null,
  tenant_id: '22222222-2222-4222-8222-222222222222',
  assigned_provider_id: null,
  title: INPUT.title,
  description: INPUT.description,
  category: 'hvac',
  priority: 'high',
  status: 'open',
  source: 'web',
  created_at: '2026-11-09T10:00:00+00:00',
  updated_at: '2026-11-09T10:00:00+00:00',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTicketCreationService();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  resetTicketCreationService();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('the HTTP delegate', () => {
  it('posts the frozen CreateTicketSchema body to the frozen route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: TICKET }));

    const ticket = await createHttpTicketCreationService('https://app.test').createTicket(
      INPUT,
      CALLER,
    );

    expect(ticket.id).toBe(TICKET.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://app.test${MAINTENANCE_TICKETS_PATH}`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(INPUT);
  });

  it('forwards the caller’s cookie so the delegated handler authorizes the tenant', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: TICKET }));
    await createHttpTicketCreationService('https://app.test').createTicket(INPUT, CALLER);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.cookie).toBe('sb-access-token=abc');
    expect(headers['x-request-id']).toBe('req-1');
  });

  it('omits an absent authorization header rather than sending an empty one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: TICKET }));
    await createHttpTicketCreationService('https://app.test').createTicket(INPUT, CALLER);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('authorization');
  });

  it('sends no organization_id, because the server derives it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: TICKET }));
    await createHttpTicketCreationService('https://app.test').createTicket(INPUT, CALLER);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(init.body)).not.toContain('organization_id');
  });

  it('takes its base URL from configuration, not from the request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: TICKET }));
    // No argument: the service must reach for `serverEnv().APP_BASE_URL`.
    await createHttpTicketCreationService().createTicket(INPUT, CALLER);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url.startsWith('https://app.test/')).toBe(true);
  });

  it('propagates an upstream refusal under its own frozen code', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'no', request_id: 'r' } }, 403),
    );

    const error = await createHttpTicketCreationService('https://app.test')
      .createTicket(INPUT, CALLER)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiRouteError);
    expect((error as ApiRouteError).code).toBe('FORBIDDEN');
  });

  it('turns an unrecognised error body into INTERNAL_ERROR, never a success', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ oops: true }, 500));

    const error = await createHttpTicketCreationService('https://app.test')
      .createTicket(INPUT, CALLER)
      .catch((thrown: unknown) => thrown);

    expect((error as ApiRouteError).code).toBe('INTERNAL_ERROR');
  });

  it('refuses a 2xx body that is not a ticket', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'not-a-ticket' } }, 201));

    const error = await createHttpTicketCreationService('https://app.test')
      .createTicket(INPUT, CALLER)
      .catch((thrown: unknown) => thrown);

    expect((error as ApiRouteError).code).toBe('INTERNAL_ERROR');
    expect((error as ApiRouteError).logFields).toMatchObject({
      reason: 'ticket_service_response_unrecognised',
    });
  });

  it('reports an unreachable service rather than hanging or returning null', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const error = await createHttpTicketCreationService('https://app.test')
      .createTicket(INPUT, CALLER)
      .catch((thrown: unknown) => thrown);

    expect((error as ApiRouteError).logFields).toMatchObject({
      reason: 'ticket_service_unreachable',
    });
  });
});

describe('the registration seam', () => {
  it('defaults to the HTTP delegate', () => {
    expect(getTicketCreationService().id).toBe('http');
  });

  it('prefers a bound in-process service once one is registered', async () => {
    const calls: CreateTicketInput[] = [];
    registerTicketCreationService({
      id: 'in-process',
      createTicket: async (input) => {
        calls.push(input);
        return TICKET as never;
      },
    });

    expect(getTicketCreationService().id).toBe('in-process');
    await getTicketCreationService().createTicket(INPUT, CALLER);
    expect(calls).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
