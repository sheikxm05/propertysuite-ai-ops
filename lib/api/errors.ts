/**
 * The eight frozen error codes, their HTTP status mapping, and the throwable errors
 * every route raises.
 *
 * Contracts honoured here:
 *  - §5.2 freezes the code set. It is **not** redeclared below: `ErrorCode` is derived
 *    from `ApiError` in `packages/shared`, so a drift between the two is a type error
 *    rather than a silent divergence (CLAUDE.md rule 4).
 *  - `docs/api-contracts.md` freezes the status mapping. `ERROR_STATUS` is the only
 *    place it is written down.
 *  - §5.2 amendment (orchestrator, Wave 0): the Postgres SQLSTATE mapping in
 *    `SQLSTATE_TO_CODE` is mandatory and exact.
 *
 * Two rules about messages:
 *  1. A raw Postgres message may echo row data, so it never reaches a client. It is
 *     logged server-side through the redaction allowlist and the frozen envelope is
 *     returned instead.
 *  2. `INTERNAL_ERROR` always uses its default message. An unexpected failure must not
 *     describe itself to the caller.
 */

import { ZodError } from 'zod';

import type { ApiError } from '@/lib/shared';

/**
 * The frozen eight, derived rather than redeclared. When `packages/shared` lands this
 * resolves to its union; a code outside the set then fails to compile anywhere.
 */
export type ErrorCode = ApiError['error']['code'];

/**
 * Status mapping, per `docs/api-contracts.md`. The `Record<ErrorCode, number>`
 * annotation is load-bearing: it fails the build if the shared union gains, loses or
 * renames a code.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/**
 * Client-safe default messages. Generic on purpose — a message that explains *why*
 * access was denied tells an attacker whether the record exists.
 */
export const ERROR_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'The request is invalid.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'You are not authorized to perform this action.',
  NOT_FOUND: 'The requested resource does not exist or is not accessible.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  UNPROCESSABLE: 'The request could not be processed.',
  RATE_LIMITED: 'Too many requests. Please retry shortly.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
};

/** Codes whose message a route may customise. `INTERNAL_ERROR` is absent deliberately. */
const CUSTOMISABLE: ReadonlySet<string> = new Set([
  'VALIDATION_ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
]);

/* ------------------------------------------------------------- throwables -- */

export interface ApiRouteErrorOptions {
  /** Client-facing message. Ignored for `INTERNAL_ERROR`. */
  message?: string;
  /**
   * Server-side-only diagnostic fields. Passed through the logger's redaction
   * allowlist before they are written, so putting row data here is safe-by-default
   * rather than merely discouraged.
   */
  logFields?: Record<string, unknown>;
  /** Seconds the caller should wait. Only meaningful for `RATE_LIMITED`. */
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * The only error type `withApiHandler` translates into a specific status. Anything else
 * thrown by a handler becomes `INTERNAL_ERROR`, which is the correct default: an error
 * the author did not anticipate must not be assigned a reassuring status code.
 */
export class ApiRouteError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** The message that goes on the wire. Distinct from `message`, which may be richer. */
  readonly publicMessage: string;
  readonly logFields: Record<string, unknown>;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, options: ApiRouteErrorOptions = {}) {
    const fallback = ERROR_MESSAGE[code] ?? ERROR_MESSAGE.INTERNAL_ERROR;
    const publicMessage =
      options.message && CUSTOMISABLE.has(code as string) ? options.message : fallback;

    super(options.message ?? fallback, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'ApiRouteError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    this.publicMessage = publicMessage;
    this.logFields = options.logFields ?? {};
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export const unauthenticated = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('UNAUTHENTICATED', o);
export const forbidden = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('FORBIDDEN', o);
export const notFound = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('NOT_FOUND', o);
export const conflict = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('CONFLICT', o);
export const unprocessable = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('UNPROCESSABLE', o);
export const validationError = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('VALIDATION_ERROR', o);
export const rateLimited = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('RATE_LIMITED', o);
export const internalError = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('INTERNAL_ERROR', o);

export function isApiRouteError(value: unknown): value is ApiRouteError {
  return value instanceof ApiRouteError;
}

/* ------------------------------------------------------------- postgres ---- */

/**
 * SQLSTATE → frozen code. Mandated verbatim by the Wave 0 §5.2 amendment.
 *
 * `42501` covers both an explicit `insufficient_privilege` raise in `0003` and a Row
 * Level Security denial on a write, which is why a cross-organization write surfaces as
 * 403 rather than 500. An RLS-denied *read* returns zero rows and no error at all; that
 * path is a 404, raised by the route, never a 403 — confirming a record exists is
 * itself a disclosure.
 */
export const SQLSTATE_TO_CODE: Readonly<Record<string, ErrorCode>> = {
  P0001: 'CONFLICT',
  '42501': 'FORBIDDEN',
  '28000': 'UNAUTHENTICATED',
  '22023': 'VALIDATION_ERROR',
  '23505': 'CONFLICT',
  '23503': 'UNPROCESSABLE',
  '23514': 'UNPROCESSABLE',
};

/** The shape `@supabase/postgrest-js` returns in `{ error }`, structurally matched. */
export interface PostgresErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
}

export function isPostgresErrorLike(value: unknown): value is PostgresErrorLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'string' || typeof candidate.message === 'string';
}

/**
 * Pulls the stable `snake_case` token that every `0003` exception message starts with,
 * for example `ticket_status_transition_invalid`. Safe to log and to switch on; the rest
 * of the message is not, because `0003` interpolates column values into it.
 */
export function postgresErrorToken(message: string | null | undefined): string | null {
  if (!message) return null;
  const match = /^([a-z][a-z0-9_]{3,63}):/.exec(message);
  return match?.[1] ?? null;
}

/** PostgREST's own codes, which are not SQLSTATEs. */
const POSTGREST_CODE_TO_CODE: Readonly<Record<string, ErrorCode>> = {
  // `.single()` matched no rows. An absent-or-inaccessible resource is a 404.
  PGRST116: 'NOT_FOUND',
  // Malformed filter or unknown column — a bad request, not a server fault.
  PGRST100: 'VALIDATION_ERROR',
  PGRST102: 'VALIDATION_ERROR',
  // JWT problems.
  PGRST301: 'UNAUTHENTICATED',
  PGRST302: 'UNAUTHENTICATED',
};

/**
 * Converts a Postgres or PostgREST error into an `ApiRouteError`.
 *
 * The raw message is attached as `logFields.reason` (the extracted token) and
 * `logFields.pg_code` only — both allowlisted, neither able to carry row data.
 */
export function postgresErrorToApiError(error: PostgresErrorLike): ApiRouteError {
  const sqlstate = typeof error.code === 'string' ? error.code : '';
  const token = postgresErrorToken(error.message);
  const code =
    SQLSTATE_TO_CODE[sqlstate] ??
    POSTGREST_CODE_TO_CODE[sqlstate] ??
    ('INTERNAL_ERROR');

  return new ApiRouteError(code, {
    logFields: { pg_code: sqlstate || 'unknown', reason: token ?? 'unmapped' },
    cause: error,
  });
}

/**
 * Throws if a Supabase result carries an error. Routes call this immediately after a
 * query so that a database-level denial becomes the right status without each handler
 * re-deriving the mapping.
 */
export function throwIfPostgresError(error: PostgresErrorLike | null | undefined): void {
  if (error) throw postgresErrorToApiError(error);
}

/* -------------------------------------------------------------- normalise -- */

/**
 * Normalises anything thrown inside a handler into an `ApiRouteError`.
 *
 * Order matters. `ApiRouteError` first (the route was explicit), then `ZodError` (a
 * schema rejected output or a nested parse), then a Postgres-shaped object, then the
 * catch-all 500. Nothing here consults the thrown value's own message for the response.
 */
export function toApiRouteError(thrown: unknown): ApiRouteError {
  if (isApiRouteError(thrown)) return thrown;

  if (thrown instanceof ZodError) {
    return new ApiRouteError('VALIDATION_ERROR', {
      logFields: { reason: 'schema_rejected', count: thrown.issues.length },
      cause: thrown,
    });
  }

  if (isPostgresErrorLike(thrown)) {
    const mapped = postgresErrorToApiError(thrown);
    // Only accept the mapping when the SQLSTATE was actually recognised; an arbitrary
    // object with a `message` must not be laundered into a 4xx.
    if (mapped.code !== ('INTERNAL_ERROR')) return mapped;
  }

  return new ApiRouteError('INTERNAL_ERROR', {
    logFields: { reason: 'unhandled' },
    cause: thrown,
  });
}
