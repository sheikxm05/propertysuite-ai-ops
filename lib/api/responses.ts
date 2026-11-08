/**
 * Response construction. The only place in the codebase that builds an HTTP body.
 *
 * The error envelope is frozen by §5.2 and must be byte-for-byte this shape:
 *
 *     { "error": { "code": "...", "message": "...", "request_id": "..." } }
 *
 * No extra keys, no nested detail object, no field-level validation report. A
 * validation report is useful to a developer and useful to an attacker mapping the
 * schema, and §5.2 does not permit one; the detail goes to the server log instead,
 * joined to the response by `request_id`.
 *
 * Success bodies are `{ data }`, and lists are `{ data, next_cursor }` to match the
 * frozen cursor pagination in §5.7. `docs/api-contracts.md` does not freeze a success
 * envelope, so this file is its single definition — a feature lane that hand-rolls
 * `Response.json` diverges from it silently, which is why nothing else may construct
 * one.
 */

import { REQUEST_ID_HEADER } from '@/lib/observability/correlation';
import type { ApiError } from '@/lib/shared';

import {
  ERROR_MESSAGES,
  ERROR_STATUS,
  GENERIC_ERROR_MESSAGE,
  GENERIC_ERROR_STATUS,
  type ApiRouteError,
  type ErrorCode,
} from './errors';

/**
 * Page-size bounds are not defined here. `packages/shared/constants/pagination` owns
 * `DEFAULT_PAGE_SIZE` and `MAX_PAGE_SIZE`, and `PaginationQuerySchema` already enforces
 * them, so a list route gets the bound from its schema rather than from this module.
 */

export interface ResponseInitLike {
  status?: number;
  headers?: Record<string, string>;
}

/** 200 with `{ data }`. */
export function ok<T>(data: T, requestId: string, init: ResponseInitLike = {}): Response {
  return jsonResponse({ data }, requestId, { status: 200, ...init });
}

/** 201 with `{ data }`, and `Location` when the created resource has a canonical URL. */
export function created<T>(
  data: T,
  requestId: string,
  options: { location?: string } = {},
): Response {
  const headers: Record<string, string> = {};
  if (options.location) headers.Location = options.location;
  return jsonResponse({ data }, requestId, { status: 201, headers });
}

/** 202 for work handed to a queue. The body carries whatever identifies the work. */
export function accepted<T>(data: T, requestId: string): Response {
  return jsonResponse({ data }, requestId, { status: 202 });
}

/**
 * 200 with a cursor page. `next_cursor` is `null` on the last page rather than absent,
 * so a client can branch on one shape.
 */
export function paginated<T>(
  items: readonly T[],
  nextCursor: string | null,
  requestId: string,
): Response {
  return jsonResponse({ data: items, next_cursor: nextCursor }, requestId, { status: 200 });
}

/**
 * The frozen error envelope.
 *
 * `message` is the code's client-safe default unless the thrown error supplied one for
 * a customisable code — see `lib/api/errors.ts`. `INTERNAL_ERROR` can never be
 * customised, so a 500 always reads identically whatever caused it.
 */
export function errorResponse(
  code: ErrorCode,
  requestId: string,
  options: { message?: string; status?: number; retryAfterSeconds?: number } = {},
): Response {
  const body: ApiError = {
    error: {
      code,
      message: options.message ?? ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE,
      request_id: requestId,
    },
  };

  const headers: Record<string, string> = {};
  if (options.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(Math.max(1, Math.ceil(options.retryAfterSeconds)));
  }

  return jsonResponse(body, requestId, {
    status: options.status ?? ERROR_STATUS[code] ?? GENERIC_ERROR_STATUS,
    headers,
  });
}

/** Renders an already-normalised `ApiRouteError`. Used by `withApiHandler`. */
export function errorResponseFrom(error: ApiRouteError, requestId: string): Response {
  const options: { message: string; status: number; retryAfterSeconds?: number } = {
    message: error.publicMessage,
    status: error.status,
  };
  if (error.retryAfterSeconds !== undefined) {
    options.retryAfterSeconds = error.retryAfterSeconds;
  }
  return errorResponse(error.code, requestId, options);
}

/**
 * The single JSON writer.
 *
 * `X-Request-Id` goes on every response, success or failure, so a support request can
 * quote an id the logs can find. `Cache-Control: no-store` goes on every response
 * because every one of them is tenant-scoped — a shared cache that keyed only on URL
 * would be a cross-organization leak with no code defect anywhere.
 */
export function jsonResponse(
  body: unknown,
  requestId: string,
  init: ResponseInitLike = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      [REQUEST_ID_HEADER]: requestId,
      ...(init.headers ?? {}),
    },
  });
}

/** Copies cookies the Supabase client refreshed onto an outgoing response. */
export function withCookies(
  response: Response,
  cookies: readonly { name: string; value: string; options: Record<string, unknown> }[],
): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) {
    headers.append('set-cookie', serialiseCookie(cookie.name, cookie.value, cookie.options));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Minimal `Set-Cookie` serialiser. Session cookies default to `HttpOnly`, `Secure`,
 * `SameSite=Lax` and `Path=/` unless Supabase asked for something else — the defaults
 * are the safe ones, so an omitted option cannot downgrade a session cookie.
 */
function serialiseCookie(name: string, value: string, options: Record<string, unknown>): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${typeof options.path === 'string' ? options.path : '/'}`);
  if (typeof options.maxAge === 'number') parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (typeof options.domain === 'string') parts.push(`Domain=${options.domain}`);
  if (options.expires instanceof Date) parts.push(`Expires=${options.expires.toUTCString()}`);
  parts.push(`SameSite=${typeof options.sameSite === 'string' ? options.sameSite : 'Lax'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  return parts.join('; ');
}
