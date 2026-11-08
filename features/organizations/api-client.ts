/**
 * Browser-side caller for this lane's own API routes. Lane w1-l1.
 *
 * Why the admin surfaces call `/api/v1/...` from the browser instead of using server
 * actions: there would otherwise be two server-side implementations of every mutation,
 * one wrapped in `withApiHandler` and one not. The wrapper is where authentication, the
 * role gate, Zod validation, rate limiting, audit writing and the frozen error envelope
 * live, so the route is the authoritative path and the UI uses it. Only the operations
 * the wrapper structurally cannot serve — sign-in, sign-up, and onboarding by a caller
 * with no membership — are server actions, and `app/(auth)/actions.ts` says why.
 *
 * This module reads the frozen error envelope and nothing else. It does not interpret
 * status codes, retry, or add fields: §5.2 fixes the shape as
 * `{ error: { code, message, request_id } }` with no detail object, and the server's
 * `message` is already the only client-safe text there is.
 *
 * Credentials are sent as `same-origin`, which is the default for a same-origin request
 * and is stated explicitly here so that it cannot quietly become `omit` or `include`.
 */

import { isErrorCode, type ErrorCode } from '@shared/index';

/** A failed call, carrying the envelope's three fields and the HTTP status. */
export class ApiClientError extends Error {
  readonly code: ErrorCode | 'UNKNOWN';
  readonly status: number;
  /** Quote this in a support request; the server log can be found by it. */
  readonly requestId: string | null;

  constructor(
    message: string,
    code: ErrorCode | 'UNKNOWN',
    status: number,
    requestId: string | null,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/** `{ data }` — the success envelope from `lib/api/responses.ts`. */
interface SuccessEnvelope<T> {
  data: T;
}

/**
 * Calls a route in this lane and returns its `data`.
 *
 * A non-2xx response is turned into `ApiClientError` with the server's own message. A
 * response that is not JSON at all — a proxy error page, say — becomes a generic failure
 * rather than an attempt to render whatever HTML arrived.
 */
export async function apiCall<T>(
  path: string,
  init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown } = { method: 'GET' },
): Promise<T> {
  const response = await fetch(path, {
    method: init.method,
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const requestId = response.headers.get('x-request-id');
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiClientError(messageFrom(payload), codeFrom(payload), response.status, requestId);
  }

  if (!payload || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiClientError(
      'The server returned an unexpected response.',
      'UNKNOWN',
      response.status,
      requestId,
    );
  }

  return (payload as SuccessEnvelope<T>).data;
}

function messageFrom(payload: unknown): string {
  const detail = errorDetail(payload);
  return typeof detail?.message === 'string' && detail.message.length > 0
    ? detail.message
    : 'Something went wrong. Try again.';
}

function codeFrom(payload: unknown): ErrorCode | 'UNKNOWN' {
  const detail = errorDetail(payload);
  return isErrorCode(detail?.code) ? detail.code : 'UNKNOWN';
}

function errorDetail(payload: unknown): { code?: unknown; message?: unknown } | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  return error as { code?: unknown; message?: unknown };
}
