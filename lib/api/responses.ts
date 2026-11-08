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
 * Success bodies are `{ data }`. Lists are
 *
 *     { "data": [ … ], "page_info": { "next_cursor": …, "has_more": …, "limit": … } }
 *
 * which is `listResponseSchema()` from `packages/shared/schemas/primitives.ts`, by
 * §5.7 amendment A18. This file previously emitted a flat `{ data, next_cursor }`, which
 * it had invented because nothing froze a list envelope; `packages/shared` is the
 * contract source and every `*ListResponseSchema` is already built on
 * `listResponseSchema`, so the shared shape wins and this helper now produces it.
 *
 * `has_more` is not derivable from `next_cursor`, which is why it is carried
 * separately: a client given only a cursor cannot tell "there is no next page" from
 * "the server failed to send one". On an RLS-filtered list a short page is normal and
 * says nothing about whether further rows exist, so that distinction is load-bearing
 * rather than cosmetic.
 *
 * `docs/api-contracts.md` still does not spell the success envelope out, so this file
 * remains its single construction point — a feature lane that hand-rolls
 * `Response.json` diverges silently, which is why nothing else may build one.
 */

import type { z } from 'zod';

import { REQUEST_ID_HEADER } from '@/lib/observability/correlation';
import { PageInfoSchema, type ApiError } from '@/lib/shared';

import {
  ApiRouteError,
  ERROR_MESSAGES,
  ERROR_STATUS,
  GENERIC_ERROR_MESSAGE,
  GENERIC_ERROR_STATUS,
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

/**
 * Schema enforcement options, shared by every success helper.
 *
 * Passing `schema` validates the body against its own contract before it ships. Every
 * item schema in `packages/shared/schemas/**` is `.strict()` — 96 of them across all
 * eleven files — so an undeclared key is **rejected**, not stripped, and the response
 * becomes a 500.
 *
 * That is fail-closed on purpose. The condition it catches is a route selecting a column
 * its own contract does not declare, which is a programming error rather than an attack:
 * nothing undeclared reaches the client, and CI runs the full suite, so it fails in front
 * of a developer instead of in front of a user. Rejecting also surfaces genuine contract
 * drift — a field the client needs but the schema forgot — which a silent strip would
 * hide.
 *
 * **If this throws, the fix is the route's `select`, not a looser schema.** Relaxing an
 * item schema to make a response pass would create two different truths about one
 * contract and quietly reopen the leak the schema was closing.
 */
export interface SchemaEnforcement {
  /** The **envelope** schema — `resourceResponseSchema(X)` or `listResponseSchema(X)`. */
  schema?: z.ZodTypeAny;
}

/**
 * Validates a body against its contract and returns what should ship.
 *
 * A failure raises `INTERNAL_ERROR`: the shape is ours to get right and the request is
 * not at fault. The offending body is never logged or returned — only the issue count and
 * the offending key NAMES, because a value could be exactly the personal data the
 * rejection just stopped.
 */
function enforceSchema(
  body: Record<string, unknown>,
  enforcement: SchemaEnforcement,
  reason: string,
): unknown {
  const { schema } = enforcement;
  if (!schema) return body;

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: {
        reason,
        count: result.error.issues.length,
        unexpected_fields: unrecognisedKeys(result.error),
      },
      cause: result.error,
    });
  }

  return result.data;
}

/**
 * The key names a `.strict()` schema refused, for the log line only.
 *
 * Names, de-duplicated and sorted — never values.
 */
function unrecognisedKeys(error: z.ZodError): string[] {
  const names = new Set<string>();
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) names.add(key);
    }
  }
  return Array.from(names).sort();
}

/**
 * 200 with `{ data }`.
 *
 * Pass `schema` — `resourceResponseSchema(X)`, or a prebuilt `*ResponseSchema` — and the
 * body is validated against it. `GET /properties/{propertyId}` has exactly the
 * over-select exposure a list route has, so the single-resource path gets the same check.
 */
export function ok<T>(
  data: T,
  requestId: string,
  init: ResponseInitLike & SchemaEnforcement = {},
): Response {
  const { schema, ...responseInit } = init;
  const body = enforceSchema({ data }, { schema }, 'resource_response_schema_rejected');
  return jsonResponse(body, requestId, { status: 200, ...responseInit });
}

/** 201 with `{ data }`, and `Location` when the created resource has a canonical URL. */
export function created<T>(
  data: T,
  requestId: string,
  options: { location?: string } & SchemaEnforcement = {},
): Response {
  const headers: Record<string, string> = {};
  if (options.location) headers.Location = options.location;
  const body = enforceSchema(
    { data },
    { schema: options.schema },
    'resource_response_schema_rejected',
  );
  return jsonResponse(body, requestId, { status: 201, headers });
}

/** 202 for work handed to a queue. The body carries whatever identifies the work. */
export function accepted<T>(data: T, requestId: string, options: SchemaEnforcement = {}): Response {
  const body = enforceSchema({ data }, options, 'resource_response_schema_rejected');
  return jsonResponse(body, requestId, { status: 202 });
}

/**
 * The page state a list route hands to `paginated`.
 *
 * `camelCase` because it is a call-site argument, not the wire body: the three fields
 * are exactly what a keyset page builder already produces, so
 * `features/properties/cursor.ts`'s `Page<T>` and the equivalent in
 * `features/maintenance/domain/service.ts` satisfy it structurally and can be passed
 * straight through. The wire contract is `PageInfoSchema` in `packages/shared`, which
 * this is mapped onto — and validated against — below. It is an adapter, not a second
 * copy of the envelope.
 */
export interface PageInfoInput {
  /** Opaque. `null` on the last page, never absent. */
  nextCursor: string | null;
  /**
   * Whether further rows exist. Must come from the query — the standard technique is to
   * ask the database for `limit + 1` rows and check whether the extra one came back.
   * Deriving it from `nextCursor` defeats the point of carrying it.
   */
  hasMore: boolean;
  /** The page size the caller asked for, not the number of rows returned. */
  limit: number;
}

/**
 * 200 with a cursor page, in the `listResponseSchema()` shape (§5.7 amendment A18).
 *
 * Pass the route's own `*ListResponseSchema` as `options.schema` and the body is
 * validated against it. The shared item schemas are `.strict()`, so a route that
 * over-selects — `select('*')` on a `tenants` row the §4 matrix limited to the name —
 * fails with a 500 instead of leaking the extra column while every isolation test stays
 * green. See `SchemaEnforcement`: the fix for that 500 is the route's `select`.
 */
export function paginated<T>(
  items: readonly T[],
  page: PageInfoInput,
  requestId: string,
  options: SchemaEnforcement = {},
): Response {
  const body: Record<string, unknown> = {
    data: items,
    page_info: {
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
      limit: page.limit,
    },
  };

  // Always checked, and cheap: four fields against a strict schema. Catches a route
  // that passed `undefined` for `hasMore` or a number for `next_cursor`.
  const pageInfo = PageInfoSchema.safeParse(body.page_info);
  if (!pageInfo.success) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'page_info_malformed', count: pageInfo.error.issues.length },
      cause: pageInfo.error,
    });
  }

  const shipped = enforceSchema(body, options, 'list_response_schema_rejected');
  return jsonResponse(shipped, requestId, { status: 200 });
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
