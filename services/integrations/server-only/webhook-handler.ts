/**
 * `withWebhookRoute` — the wrapper a provider webhook goes through.
 *
 * ===========================================================================
 * PLANNING DEFECT — `withApiHandler` cannot serve a webhook. REPORTED.
 * ===========================================================================
 *
 * The briefing says to read `ctx.request` from `withApiHandler`, and §5 amendment A13
 * added `request` to the context for exactly this purpose. But stage 1 of
 * `withApiHandler` is `requireSessionFromClient`, which throws `UNAUTHENTICATED`
 * before a handler runs, and a delivery from Meta carries no Supabase session cookie —
 * it carries an HMAC. So every webhook would 401 before its signature was ever
 * examined, and `ctx.request` would never be reached. `withApiHandler` has no
 * unauthenticated mode and `lib/**` belongs to w0-l5, so this lane cannot add one.
 *
 * What is here instead is a *composition*, not a reimplementation. Every contract-
 * bearing piece is imported from `lib/`:
 *
 *   resolveRequestId / REQUEST_ID_HEADER   `lib/observability/correlation`
 *   createLogger                           `lib/observability/logger`
 *   ApiRouteError / toApiRouteError        `lib/api/errors`
 *   errorResponseFrom / jsonResponse       `lib/api/responses`
 *   consume (rate limiting)                `lib/rate-limit`
 *
 * Nothing about the frozen error envelope, the eight error codes or the correlation
 * header is restated here; the §5.2 envelope is still constructed by the one module
 * allowed to construct it. The only thing this wrapper changes is which credential
 * authenticates the caller: an HMAC over the raw body instead of a session cookie. When
 * w0-l5 adds an `authentication: 'webhook'` mode to `withApiHandler`, this file's body
 * becomes a thin delegation and the two route exports do not move.
 *
 * Execution order, mirroring §5.2's as closely as an unauthenticated route can:
 *
 *     correlate → rate-limit → read raw bytes → VERIFY → parse → execute → envelope
 *
 * Verification sits before parsing because a signature checked after parsing is a
 * signature over bytes we produced, not bytes the sender signed. Rate limiting sits
 * before the body is read because the cost being capped is the read itself; the subject
 * is the route, since an unauthenticated caller has no identity to key on and keying on
 * an IP would let a single spoofed header starve the real sender.
 */

import 'server-only';

import { ApiRouteError, toApiRouteError } from '@/lib/api/errors';
import { errorResponseFrom, jsonResponse } from '@/lib/api/responses';
import { REQUEST_ID_HEADER, resolveRequestId, routeLabel } from '@/lib/observability/correlation';
import { createLogger, type Logger } from '@/lib/observability/logger';
import { consume, type RateLimitRule } from '@/lib/rate-limit';

/** What a webhook handler receives once the request has been authenticated. */
export interface WebhookContext {
  readonly request: Request;
  /** The exact octets the signature was computed over. */
  readonly rawBody: Uint8Array;
  readonly requestId: string;
  readonly logger: Logger;
}

export interface WithWebhookRouteOptions {
  /** Provider name, bound to every log line. Allowlisted, so it survives redaction. */
  readonly provider: string;
  /** Bucket for this endpoint. Subject is the route, not the caller — see the header. */
  readonly rateLimit: RateLimitRule;
  /** Largest body accepted, checked before the bytes are buffered. */
  readonly maxBodyBytes: number;
  /**
   * Authenticates the delivery. Returns a 4xx-bearing `ApiRouteError` to refuse.
   *
   * Separate from the handler so that "did we verify?" is a distinct, inspectable step
   * rather than the first few lines of a function that also does the work.
   */
  authenticate(context: WebhookContext): Promise<void> | void;
}

export type WebhookRouteHandler = (request: Request) => Promise<Response>;

/**
 * Wraps a POST webhook handler.
 *
 * The response body is the handler's. The envelope on a *failure* is the frozen §5.2
 * one, built by `lib/api/responses.ts`, so a webhook that is refused looks exactly like
 * any other refused request to the logs and to a test.
 */
export function withWebhookRoute(
  options: WithWebhookRouteOptions,
  handler: (context: WebhookContext) => Promise<Response>,
): WebhookRouteHandler {
  return async function route(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request);
    const route = routeLabel(request.url);
    const startedAt = Date.now();

    const logger = createLogger({
      requestId,
      base: { route, method: request.method, provider: options.provider },
    });

    try {
      /* 1. rate-limit ---------------------------------------------------- */
      const decision = consume(options.rateLimit, `${options.provider}|${route}`);
      if (!decision.allowed) {
        throw new ApiRouteError('RATE_LIMITED', {
          retryAfterSeconds: decision.retryAfterSeconds,
          logFields: { rate_limit_key: options.rateLimit.key, limit: decision.limit },
        });
      }

      /* 2. raw bytes ----------------------------------------------------- */
      const rawBody = await readRawBody(request, options.maxBodyBytes);

      /* 3. authenticate -------------------------------------------------- */
      const context: WebhookContext = { request, rawBody, requestId, logger };
      await options.authenticate(context);

      /* 4. execute ------------------------------------------------------- */
      const response = await handler(context);

      logger.info('webhook completed', {
        status_code: response.status,
        duration_ms: Date.now() - startedAt,
        outcome: 'ok',
      });
      return withRequestId(response, requestId);
    } catch (thrown) {
      const error = toApiRouteError(thrown);
      const level = error.status >= 500 ? 'error' : 'warn';
      logger[level]('webhook refused', {
        status_code: error.status,
        error_code: error.code,
        duration_ms: Date.now() - startedAt,
        outcome: 'error',
        ...error.logFields,
      });
      return errorResponseFrom(error, requestId);
    }
  };
}

/**
 * Wraps a GET verification handshake.
 *
 * Separate from `withWebhookRoute` because it has no body to sign, no bytes to cap and
 * nothing to authenticate beyond the token comparison the handler itself performs.
 * Folding it into the POST wrapper would mean the POST wrapper has a mode in which it
 * skips verification, which is the one shape this lane is trying not to have anywhere.
 */
export function withWebhookVerificationRoute(
  options: { readonly provider: string; readonly rateLimit: RateLimitRule },
  handler: (params: {
    readonly request: Request;
    readonly requestId: string;
    readonly logger: Logger;
  }) => Promise<Response> | Response,
): WebhookRouteHandler {
  return async function route(request: Request): Promise<Response> {
    const requestId = resolveRequestId(request);
    const route = routeLabel(request.url);
    const startedAt = Date.now();
    const logger = createLogger({
      requestId,
      base: { route, method: request.method, provider: options.provider },
    });

    try {
      const decision = consume(options.rateLimit, `${options.provider}|${route}`);
      if (!decision.allowed) {
        throw new ApiRouteError('RATE_LIMITED', {
          retryAfterSeconds: decision.retryAfterSeconds,
          logFields: { rate_limit_key: options.rateLimit.key, limit: decision.limit },
        });
      }

      const response = await handler({ request, requestId, logger });
      logger.info('webhook handshake completed', {
        status_code: response.status,
        duration_ms: Date.now() - startedAt,
        outcome: 'ok',
      });
      return withRequestId(response, requestId);
    } catch (thrown) {
      const error = toApiRouteError(thrown);
      logger.warn('webhook handshake refused', {
        status_code: error.status,
        error_code: error.code,
        duration_ms: Date.now() - startedAt,
        outcome: 'error',
        ...error.logFields,
      });
      return errorResponseFrom(error, requestId);
    }
  };
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Buffers the body, refusing an oversized one before it is read.
 *
 * The declared `content-length` is checked first — the point of a cap is not to read the
 * oversized payload and *then* complain — and the actual byte count is checked after,
 * because `content-length` is a claim the sender makes about itself.
 *
 * This mirrors `parseBody` in `lib/api/with-handler.ts`, with one difference that is
 * the whole reason this function exists: it returns the **bytes**, not a parsed object.
 */
async function readRawBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiRouteError('VALIDATION_ERROR', { logFields: { reason: 'body_too_large' } });
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    throw new ApiRouteError('VALIDATION_ERROR', { logFields: { reason: 'body_unreadable' } });
  }

  if (buffer.byteLength > maxBytes) {
    throw new ApiRouteError('VALIDATION_ERROR', { logFields: { reason: 'body_too_large' } });
  }
  return new Uint8Array(buffer);
}

/** Every response carries the correlation id, success or failure. */
function withRequestId(response: Response, requestId: string): Response {
  if (response.headers.get(REQUEST_ID_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Re-exported so a webhook route needs one import for the wrapper and the writer. */
export { jsonResponse };
