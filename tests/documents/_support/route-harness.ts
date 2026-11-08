/**
 * Driving a document route end to end in a unit test.
 *
 * The route modules go through `withApiHandler`, which reaches for a real Supabase
 * client, a real session and the real audit writer. Five modules are therefore
 * substituted by the test file's `vi.mock` blocks — and it is worth being explicit about
 * which, because the value of these tests depends entirely on what is *not* substituted:
 *
 *   SUBSTITUTED      `lib/supabase/server`          client factory → the fake database
 *                    `lib/auth/session`             who the caller is
 *                    `lib/auth/roles`               what membership they hold
 *                    `lib/audit/write`              captures audit rows instead of
 *                                                   calling the `log_audit` RPC
 *                    `lib/supabase/server-only/…`   service-role client → the same fake
 *
 *   NOT SUBSTITUTED  the frozen error envelope, Zod validation, the role gate, the rate
 *                    limiter, the audit *hook*, the SQLSTATE mapping, and every line of
 *                    this lane's own code — the authorization gates, the storage path
 *                    construction, the magic-byte probe and the verification gate.
 *
 * Session and membership are mocked because resolving them needs `auth.getUser()`
 * against a live auth server, and the anon key is not available in this environment.
 * That is covered by `tests/rls/**` and the end-to-end suite instead. Everything a mock
 * would make vacuous is left real.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS CANNOT PROVE, stated plainly.
 * ---------------------------------------------------------------------------
 * Row Level Security. The fake client does not evaluate policies, so no test here can
 * show that organization B's document is hidden *by the database*. What they do show is
 * the complementary half: seeded with another organization's row — simulating a database
 * that handed one over, which is to say an RLS bug — the route refuses it anyway. That
 * is the second of the two enforcement layers, tested on the assumption that the first
 * has failed, which is exactly what CLAUDE.md asks for.
 *
 * The live-database half is `tests/rls/**` (lane w0-l6), against real policies.
 * ---------------------------------------------------------------------------
 *
 * `routeMockState` is a plain mutable object rather than `vi.hoisted` state, because the
 * `vi.mock` factories reach it through a dynamic `await import(...)`. Factories are
 * lazy — they run when the mocked module is first imported — so an async factory can
 * import this module and read whatever the current test set.
 */

import type { Membership } from '@/lib/auth/roles';

/** An audit row the route asked for, captured instead of written. */
export interface CapturedAudit {
  action: string;
  entityType: string;
  entityId: string | null | undefined;
  organizationId: string;
  metadata: Record<string, unknown> | undefined;
}

export interface RouteMockState {
  membership: unknown;
  sessionUserId: string;
  /** The object every substituted client factory returns. */
  client: unknown;
  audits: CapturedAudit[];
  /** Set false to simulate a deployment with no service-role credential. */
  serviceRoleAvailable: boolean;
}

export const routeMockState: RouteMockState = {
  membership: null,
  sessionUserId: 'auth-user-1',
  client: null,
  audits: [],
  serviceRoleAvailable: true,
};

/* ----------------------------------------------------------------- driving -- */

export function setCaller(membership: Membership): void {
  routeMockState.membership = membership;
}

export function setClient(client: unknown): void {
  routeMockState.client = client;
}

export function setServiceRoleAvailable(available: boolean): void {
  routeMockState.serviceRoleAvailable = available;
}

export function capturedAudits(): CapturedAudit[] {
  return routeMockState.audits;
}

export function resetRouteMocks(): void {
  routeMockState.audits.length = 0;
  routeMockState.serviceRoleAvailable = true;
  routeMockState.membership = null;
  routeMockState.client = null;
}

/** Builds a `Request` for a route handler. */
export function jsonRequest(url: string, body?: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** The second argument Next.js passes a dynamic route. */
export function routeParams(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

export interface ParsedResponse {
  status: number;
  body: Record<string, unknown>;
  /** `error.code` when the response is an error envelope, else `null`. */
  errorCode: string | null;
  headers: Headers;
}

/**
 * Reads a response.
 *
 * `errorCode` is pulled from `body.error.code`, which asserts the frozen §5.2 envelope
 * by using it: a route that invented its own error shape would give `null` here and the
 * test would fail on the code rather than quietly pass on the status.
 */
export async function readResponse(response: Response): Promise<ParsedResponse> {
  const text = await response.text();
  const body: Record<string, unknown> = text.length > 0 ? JSON.parse(text) : {};
  const error = body.error as { code?: unknown } | undefined;

  return {
    status: response.status,
    body,
    errorCode: typeof error?.code === 'string' ? error.code : null,
    headers: response.headers,
  };
}

/** `{ data: … }` from a success envelope. */
export function dataOf<T = Record<string, unknown>>(parsed: ParsedResponse): T {
  return parsed.body.data as T;
}
