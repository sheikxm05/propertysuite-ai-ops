/**
 * The eight frozen error codes, their HTTP status mapping, and the throwable errors
 * every route raises.
 *
 * Division of responsibility with `packages/shared`:
 *
 *   packages/shared/constants/errors   the *data* — the code union, the status table,
 *                                      the message table, the SQLSTATE table
 *   lib/api/errors.ts (here)           the *behaviour* — throwables, normalisation,
 *                                      and the rules about what may be said
 *
 * None of those four tables is redeclared below. Two copies would be two chances to
 * drift, and CLAUDE.md rule 4 forbids a local copy of a shared enum or error code. They
 * arrive through `lib/shared.ts`, the lane's single import seam.
 *
 * Two rules about messages, which are this file's to enforce:
 *  1. A raw Postgres message may echo row data, so it never reaches a client. It is
 *     logged server-side through the redaction allowlist and the frozen envelope is
 *     returned instead.
 *  2. `INTERNAL_ERROR` always uses its default message. An unexpected failure must not
 *     describe itself to the caller.
 */

import { ZodError } from 'zod';

import { ERROR_MESSAGES, ERROR_STATUS, errorCodeForSqlState, type ErrorCode } from '@/lib/shared';

export { ERROR_MESSAGES, ERROR_STATUS, SQLSTATE_ERROR_CODES } from '@/lib/shared';
export type { ErrorCode } from '@/lib/shared';

/** Used when a code somehow falls outside the frozen eight. Never customised. */
export const GENERIC_ERROR_MESSAGE: string = ERROR_MESSAGES.INTERNAL_ERROR;
/** Status used when a code somehow falls outside the frozen eight. */
export const GENERIC_ERROR_STATUS: number = ERROR_STATUS.INTERNAL_ERROR;

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
    const fallback: string = ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE;
    const publicMessage: string =
      options.message && CUSTOMISABLE.has(code as string) ? options.message : fallback;

    super(options.message ?? fallback, options.cause === undefined ? {} : { cause: options.cause });
    this.name = 'ApiRouteError';
    this.code = code;
    this.status = ERROR_STATUS[code] ?? GENERIC_ERROR_STATUS;
    this.publicMessage = publicMessage;
    this.logFields = options.logFields ?? {};
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export const unauthenticated = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('UNAUTHENTICATED', o);
export const forbidden = (o?: ApiRouteErrorOptions) => new ApiRouteError('FORBIDDEN', o);
export const notFound = (o?: ApiRouteErrorOptions) => new ApiRouteError('NOT_FOUND', o);
export const conflict = (o?: ApiRouteErrorOptions) => new ApiRouteError('CONFLICT', o);
export const unprocessable = (o?: ApiRouteErrorOptions) => new ApiRouteError('UNPROCESSABLE', o);
export const validationError = (o?: ApiRouteErrorOptions) =>
  new ApiRouteError('VALIDATION_ERROR', o);
export const rateLimited = (o?: ApiRouteErrorOptions) => new ApiRouteError('RATE_LIMITED', o);
export const internalError = (o?: ApiRouteErrorOptions) => new ApiRouteError('INTERNAL_ERROR', o);

export function isApiRouteError(value: unknown): value is ApiRouteError {
  return value instanceof ApiRouteError;
}

/* ------------------------------------------------------------- postgres ---- */

/**
 * Why there is no SQLSTATE table in this file.
 *
 * `packages/shared/constants/errors` owns `SQLSTATE_ERROR_CODES` and
 * `errorCodeForSqlState`, mandated verbatim by the Wave 0 §5.2 amendment and re-exported
 * above. The table is shared because the RLS suite asserts against the same mapping the
 * wrapper applies; two copies would let them agree on paper and differ in fact.
 *
 * `42501` covers both an explicit `insufficient_privilege` raise in `0003` and a Row
 * Level Security denial on a write, which is why a cross-organization write surfaces as
 * 403 rather than 500. An RLS-denied *read* returns zero rows and no error at all; that
 * path is a 404, raised by the route, never a 403 — confirming a record exists is itself
 * a disclosure.
 */

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
  const code: ErrorCode =
    POSTGREST_CODE_TO_CODE[sqlstate] ?? errorCodeForSqlState(sqlstate || null);

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
    if (mapped.code !== 'INTERNAL_ERROR') return mapped;
  }

  return new ApiRouteError('INTERNAL_ERROR', {
    logFields: { reason: 'unhandled' },
    cause: thrown,
  });
}
