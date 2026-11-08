/**
 * `withApiHandler` — the mandatory wrapper every route handler goes through.
 *
 * Signature frozen by `docs/parallel-execution-plan.md` §5.2:
 *
 *     withApiHandler({
 *       roles?: MemberRole[],
 *       bodySchema?: ZodSchema,
 *       querySchema?: ZodSchema,
 *       rateLimit?: { key: string; perMinute: number },
 *       audit?: { action: string; entityType: string },
 *     }, async (ctx) => Response)
 *
 * Execution order is frozen too, and is the order below:
 *
 *     authenticate → authorize → validate (body, query) → rate-limit
 *                  → execute → audit → typed envelope with request_id
 *
 * Why that order and not another: authentication first because an anonymous caller must
 * learn nothing, including whether a route exists for their role. The role gate before
 * validation because a 403 must not depend on a well-formed body — otherwise the shape
 * of the schema is discoverable without authorization. Rate limiting after the role gate
 * because the limiter's subject is the authenticated profile, never an IP. Audit after
 * execution because an audit row for a mutation that failed is a false record.
 *
 * Two things this wrapper deliberately does **not** do:
 *
 *  - It does not grant a service-role client. `ctx.serviceRole` is `undefined` unless
 *    the route opted in through `lib/api/server-only/privileged-handler.ts`, which the
 *    `server-only` import boundary guards. A wrapper that handed every one of thirty
 *    routes an RLS-bypassing client by default would make the RLS layer decorative.
 *  - It does not perform row-level authorization. `options.roles` is a coarse gate; the
 *    matrix check is `authorize(membership, action, resource)` from
 *    `lib/auth/authorize.ts`, called inside the handler once the row has been read, with
 *    the row's own `organization_id`. The wrapper cannot do it: it has not read the row.
 */

import type { z } from 'zod';

import { ApiRouteError, toApiRouteError, type ErrorCode } from '@/lib/api/errors';
import { errorResponseFrom, jsonResponse, withCookies } from '@/lib/api/responses';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';
import { membershipLogFields, requireMembership, type Membership } from '@/lib/auth/roles';
import { requireSessionFromClient, type AuthenticatedSession } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit/write';
import { REQUEST_ID_HEADER, resolveRequestId, routeLabel } from '@/lib/observability/correlation';
import { createLogger, type Logger } from '@/lib/observability/logger';
import {
  applyAiCeiling,
  consume,
  defaultRuleFor,
  isAiPath,
  type RateLimitRule,
} from '@/lib/rate-limit';
import { createRouteHandlerClient, type PendingCookie } from '@/lib/supabase/server';
import type { AppSupabaseClient, PrivilegedSupabaseClient } from '@/lib/supabase/types';
import type { MemberRole } from '@/lib/shared';

/** Largest JSON body accepted. The 10 MB upload cap in §5.7 is for storage, not JSON. */
const MAX_JSON_BODY_BYTES = 1_000_000;

/* ------------------------------------------------------------------ types -- */

/** A Zod schema, accepting an unknown input and producing `T`. */
export type RequestSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/** Extra audit detail a handler supplies once it knows what it changed. */
export interface AuditDetails {
  entityId?: string | null;
  /** Redacted by `lib/audit/write.ts` before it is stored. */
  metadata?: Record<string, unknown>;
}

/**
 * What a handler receives. The first eight fields are the frozen §5.2 context.
 *
 * `request`, `params` and `audit` are additive. §5.2's context has no route parameters,
 * and roughly half the routes in §5.5 are dynamic (`/properties/{propertyId}/units`), so
 * without `params` they cannot be written at all. Raised as a planning defect; the field
 * is additive, so a lane coded against §5.2 as published still compiles.
 */
export interface ApiHandlerContext<TBody = undefined, TQuery = undefined> {
  /** The verified caller. From `auth.getUser()`, not a decoded cookie. */
  session: AuthenticatedSession;
  /** Derived from trusted rows by `resolveMembership`. Never from request data. */
  membership: Membership;
  /** `bodySchema` output, or `undefined` when no schema was declared. */
  body: TBody;
  /** `querySchema` output, or `undefined` when no schema was declared. */
  query: TQuery;
  /** Caller-scoped client. Row Level Security is in force. Use this for everything. */
  supabase: AppSupabaseClient;
  /** Present only under `withPrivilegedApiHandler`. **Bypasses RLS.** */
  serviceRole?: PrivilegedSupabaseClient;
  requestId: string;
  logger: Logger;

  /** The raw request, for webhook signature verification and header access. */
  request: Request;
  /** Awaited dynamic route segments. Additive — see the interface note above. */
  params: Record<string, string>;
  /** Enriches this request's audit row. No-op when `options.audit` is unset. */
  audit(details: AuditDetails): void;
}

export interface WithApiHandlerOptions<TBody = undefined, TQuery = undefined> {
  /** Coarse role gate. Omit to allow any active member; the matrix check is separate. */
  roles?: readonly MemberRole[];
  bodySchema?: RequestSchema<TBody>;
  querySchema?: RequestSchema<TQuery>;
  /** Per-user bucket. Capped at the AI ceiling on `/api/v1/ai/*`. */
  rateLimit?: { key: string; perMinute: number };
  /** Writes one `audit_logs` row on a successful response. */
  audit?: { action: string; entityType: string };
}

export type ApiHandler<TBody, TQuery> = (
  ctx: ApiHandlerContext<TBody, TQuery>,
) => Response | Promise<Response>;

/** What Next.js calls. The second argument is absent on a static route. */
export type RouteHandler = (
  request: Request,
  routeContext?: { params?: Promise<Record<string, string | string[]>> },
) => Promise<Response>;

/** Injection seam. Not exported from the public entry point. */
export interface ApiHandlerInternals {
  /**
   * Supplies `ctx.serviceRole`. Provided only by
   * `lib/api/server-only/privileged-handler.ts`, so that this module never imports an
   * RLS-bypassing client and the `server-only` lint boundary keeps its meaning.
   */
  serviceRoleFactory?: () => PrivilegedSupabaseClient | null;
}

/* ------------------------------------------------------------- entry point -- */

/** The frozen §5.2 wrapper. Every route in §5.5 uses this or its privileged variant. */
export function withApiHandler<TBody = undefined, TQuery = undefined>(
  options: WithApiHandlerOptions<TBody, TQuery>,
  handler: ApiHandler<TBody, TQuery>,
): RouteHandler {
  return createApiHandler(options, handler, {});
}

/** `withApiHandler` with the internal seam exposed. Used by the privileged variant. */
export function createApiHandler<TBody = undefined, TQuery = undefined>(
  options: WithApiHandlerOptions<TBody, TQuery>,
  handler: ApiHandler<TBody, TQuery>,
  internals: ApiHandlerInternals = {},
): RouteHandler {
  return async function route(request, routeContext) {
    const requestId = resolveRequestId(request);
    const pathname = safePathname(request.url);
    const route = routeLabel(request.url);
    const startedAt = Date.now();

    const logger = createLogger({
      requestId,
      base: { route, method: request.method },
    });

    const { supabase, pendingCookies } = createRouteHandlerClient(request);
    const auditDetails: AuditDetails = {};
    let membership: Membership | null = null;

    try {
      /* 1. authenticate -------------------------------------------------- */
      const session = await requireSessionFromClient(supabase);

      /* 2. authorize (coarse) -------------------------------------------- */
      membership = await requireMembership(session.userId, supabase);
      assertRoleAllowed(options.roles, membership);

      const scopedLogger = logger.child(membershipLogFields(membership));

      /* 3. validate ------------------------------------------------------ */
      const query = parseQuery(options.querySchema, request);
      const body = await parseBody(options.bodySchema, request);

      /* 4. rate-limit ---------------------------------------------------- */
      enforceRateLimit(
        options.rateLimit,
        pathname,
        route,
        request.method,
        membership,
        scopedLogger,
      );

      /* 5. execute ------------------------------------------------------- */
      const context: ApiHandlerContext<TBody, TQuery> = {
        session,
        membership,
        body,
        query,
        supabase,
        requestId,
        logger: scopedLogger,
        request,
        params: await readParams(routeContext),
        audit: (details) => {
          if (details.entityId !== undefined) auditDetails.entityId = details.entityId;
          if (details.metadata) {
            auditDetails.metadata = { ...(auditDetails.metadata ?? {}), ...details.metadata };
          }
        },
      };

      const serviceRole = internals.serviceRoleFactory?.() ?? null;
      if (serviceRole) context.serviceRole = serviceRole;

      const response = await handler(context);

      /* 6. audit --------------------------------------------------------- */
      if (options.audit && response.status < 400) {
        await writeAuditLog(
          supabase,
          {
            action: options.audit.action,
            entityType: options.audit.entityType,
            entityId: auditDetails.entityId ?? (await extractEntityId(response)),
            organizationId: membership.organization.id,
            metadata: {
              ...(auditDetails.metadata ?? {}),
              request_id: requestId,
              route,
              method: request.method,
            },
          },
          scopedLogger,
        );
      }

      /* 7. envelope ------------------------------------------------------ */
      scopedLogger.info('request completed', {
        status_code: response.status,
        duration_ms: Date.now() - startedAt,
        outcome: 'ok',
      });
      return finalise(response, requestId, pendingCookies);
    } catch (thrown) {
      const error = normalise(thrown);
      const scopedLogger = membership ? logger.child(membershipLogFields(membership)) : logger;

      // A 5xx is a defect in our code; everything else is the client being told no.
      // Both are logged, at different levels, with the same correlation id.
      const level = error.status >= 500 ? 'error' : 'warn';
      scopedLogger[level]('request failed', {
        status_code: error.status,
        error_code: error.code,
        duration_ms: Date.now() - startedAt,
        outcome: 'error',
        ...error.logFields,
      });
      if (error.status >= 500) logUnexpectedCause(scopedLogger, thrown);

      return withCookies(errorResponseFrom(error, requestId), pendingCookies);
    }
  };
}

/* ----------------------------------------------------------------- stages -- */

function assertRoleAllowed(roles: readonly MemberRole[] | undefined, membership: Membership): void {
  if (!roles || roles.length === 0) return;
  if (roles.includes(membership.role)) return;
  throw new ApiRouteError('FORBIDDEN', {
    logFields: { reason: 'role_not_permitted_for_route', role: membership.role },
  });
}

/**
 * Parses the query string.
 *
 * Repeated keys collapse to an array so a schema can accept either. The raw
 * `URLSearchParams` is not handed to Zod: `searchParams.get` returns the *first* value,
 * which lets a caller smuggle a second `limit=10000` past a schema that only sees the
 * first.
 */
function parseQuery<TQuery>(schema: RequestSchema<TQuery> | undefined, request: Request): TQuery {
  if (!schema) return undefined as TQuery;

  const params = new URL(request.url).searchParams;
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    raw[key] = values.length > 1 ? values : (values[0] ?? '');
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'query_schema_rejected', count: result.error.issues.length },
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Parses and validates the JSON body.
 *
 * Only read when a schema was declared, so a webhook route that needs the raw bytes for
 * a signature check can reach `ctx.request` with the stream intact. Content type and
 * length are checked before the body is buffered — the point of a size cap is not to
 * read the oversized payload first.
 */
async function parseBody<TBody>(
  schema: RequestSchema<TBody> | undefined,
  request: Request,
): Promise<TBody> {
  if (!schema) return undefined as TBody;

  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'body_not_allowed_for_method', method },
    });
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'content_type_not_json' },
    });
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'body_too_large' },
    });
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiRouteError('VALIDATION_ERROR', { logFields: { reason: 'body_unreadable' } });
  }

  if (text.length > MAX_JSON_BODY_BYTES) {
    throw new ApiRouteError('VALIDATION_ERROR', { logFields: { reason: 'body_too_large' } });
  }

  let parsed: unknown;
  try {
    parsed = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    throw new ApiRouteError('VALIDATION_ERROR', { logFields: { reason: 'body_not_json' } });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'body_schema_rejected', count: result.error.issues.length },
      cause: result.error,
    });
  }
  return result.data;
}

/**
 * Spends a rate-limit token.
 *
 * The subject is the authenticated profile id. When a route declares a bucket, the
 * declared key defines its scope, which is how two routes share one budget on purpose.
 * When falling back to a default, the route label joins the subject so the bucket is
 * per-user *per-route* — except on `/api/v1/ai/*`, where the budget is intentionally
 * per-user across every AI route, because the resource being protected is spend, not a
 * single endpoint.
 */
function enforceRateLimit(
  declared: { key: string; perMinute: number } | undefined,
  pathname: string,
  route: string,
  method: string,
  membership: Membership,
  logger: Logger,
): void {
  const rule: RateLimitRule = applyAiCeiling(
    declared ?? defaultRuleFor(pathname, method),
    pathname,
  );

  const subject =
    declared || isAiPath(pathname) ? membership.profile.id : `${membership.profile.id}|${route}`;

  const decision = consume(rule, subject);
  if (decision.allowed) return;

  logger.warn('rate limit exceeded', {
    rate_limit_key: rule.key,
    limit: decision.limit,
    retry_after_s: decision.retryAfterSeconds,
  });

  throw new ApiRouteError('RATE_LIMITED', {
    retryAfterSeconds: decision.retryAfterSeconds,
    logFields: { rate_limit_key: rule.key, limit: decision.limit },
  });
}

/* ----------------------------------------------------------------- output -- */

/**
 * Adds the correlation header and any refreshed session cookies.
 *
 * A handler that used `lib/api/responses.ts` already carries the header; one that built
 * a `Response` by hand does not, and every response must be traceable.
 */
function finalise(
  response: Response,
  requestId: string,
  cookies: readonly PendingCookie[],
): Response {
  const withId = response.headers.get(REQUEST_ID_HEADER)
    ? response
    : new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers([...response.headers.entries(), [REQUEST_ID_HEADER, requestId]]),
      });

  return withCookies(
    withId,
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      options: c.options as unknown as Record<string, unknown>,
    })),
  );
}

/**
 * Reads `data.id` out of a successful response so the audit row has an entity id
 * without every handler remembering to pass one. A handler that knows better calls
 * `ctx.audit({ entityId })`, which wins.
 *
 * The response is cloned, so the body the client receives is untouched. Nothing from the
 * body is logged — only the id is read, and only if it is a string.
 */
async function extractEntityId(response: Response): Promise<string | null> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    const clone = response.clone();
    const parsed: unknown = await clone.json();
    if (typeof parsed !== 'object' || parsed === null) return null;
    const data = (parsed as { data?: unknown }).data;
    if (typeof data === 'object' && data !== null) {
      const id = (data as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
    const topLevel = (parsed as { id?: unknown }).id;
    return typeof topLevel === 'string' ? topLevel : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- errors -- */

/**
 * Normalises anything thrown into an `ApiRouteError`.
 *
 * `AuthorizationDeniedError` is translated here rather than in `lib/api/errors.ts` so
 * that `lib/auth/authorize.ts` stays free of HTTP concerns: a policy module that knows
 * about status codes is a policy module that gets edited for routing reasons.
 */
function normalise(thrown: unknown): ApiRouteError {
  if (thrown instanceof AuthorizationDeniedError) {
    return new ApiRouteError('FORBIDDEN', {
      logFields: {
        reason: thrown.reason,
        resource_type: thrown.resourceType,
        action: thrown.action,
      },
      cause: thrown,
    });
  }
  return toApiRouteError(thrown);
}

/**
 * Logs the shape of an unexpected failure without logging the failure's message.
 *
 * An exception message is uncontrolled text: it can contain a row value, a connection
 * string or a token. The constructor name and the first stack frame are enough to find
 * the defect and carry none of that.
 */
function logUnexpectedCause(logger: Logger, thrown: unknown): void {
  const name = thrown instanceof Error ? thrown.name : typeof thrown;
  const frame =
    thrown instanceof Error && typeof thrown.stack === 'string'
      ? (thrown.stack.split('\n')[1] ?? '').trim().slice(0, 200)
      : '';
  logger.error('unhandled handler failure', {
    reason: name,
    // `code` is allowlisted; the frame is a file and line, never request data.
    code: frame || 'no_stack',
  });
}

/* ---------------------------------------------------------------- helpers -- */

async function readParams(
  routeContext: { params?: Promise<Record<string, string | string[]>> } | undefined,
): Promise<Record<string, string>> {
  if (!routeContext?.params) return {};
  const resolved = await routeContext.params;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolved ?? {})) {
    out[key] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return out;
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------- re-exports -- */

/**
 * Re-exported so a route needs one import for the wrapper and the response builders.
 * `jsonResponse` is included for the rare handler that must set its own status; the
 * typed helpers in `lib/api/responses.ts` are the normal path.
 */
export { jsonResponse };
export type { ErrorCode };
