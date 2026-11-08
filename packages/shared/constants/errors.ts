import { z } from 'zod';

/**
 * The frozen error contract from `docs/parallel-execution-plan.md` §5.2.
 *
 * These eight codes are the complete set. No lane invents a ninth, and no lane
 * invents a different envelope shape. `lib/api/errors.ts` (lane w0-l5) is the
 * only module permitted to construct an error response; everything else imports
 * the code union and the envelope type from here so that the client, the server
 * and the tests cannot disagree about what an error looks like.
 */
export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * HTTP status for each code, per the "Status codes" table in
 * `docs/api-contracts.md`.
 *
 * 400 for a malformed or schema-invalid request; 422 for a request that parses
 * and is well-formed but is semantically impossible (an end date before a start
 * date, a transition the state machine permits for nobody, a cross-organization
 * identifier). 409 is reserved for a conflict with current state or an
 * idempotency-key collision.
 */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
});

/**
 * Default client-facing messages.
 *
 * Deliberately generic. A message is a UI string, never a diagnostic: it must
 * never carry a row identifier, a column name, a SQL fragment, document text, a
 * message body, a token or anything else that would leak the existence or
 * contents of another organization's data. `NOT_FOUND` and `FORBIDDEN` are
 * phrased so that an absent resource and an inaccessible one are
 * indistinguishable to the caller.
 */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: 'The request is invalid.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'You do not have access to this resource.',
  NOT_FOUND: 'The resource was not found.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  UNPROCESSABLE: 'The request could not be processed.',
  RATE_LIMITED: 'Too many requests. Please retry later.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
});

/** The inner object of the envelope. */
export type ApiErrorDetail = {
  code: ErrorCode;
  message: string;
  request_id: string;
};

/**
 * The error envelope. Every non-2xx response body is exactly this shape:
 *
 * ```json
 * { "error": { "code": "VALIDATION_ERROR", "message": "...", "request_id": "..." } }
 * ```
 */
export type ApiError = {
  error: ApiErrorDetail;
};

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** Runtime guard for the envelope, so clients and tests can assert on a response body. */
export const ApiErrorSchema: z.ZodType<ApiError> = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string(),
        request_id: z.string(),
      })
      .strict(),
  })
  .strict();

/**
 * Postgres SQLSTATE to error code, frozen by amendment A2.
 *
 * §5.2 froze the eight codes but never said how a database error reaches one.
 * This is the mapping, as data, so that `lib/api/with-handler.ts` and the tests
 * that assert on it cannot disagree.
 *
 * The important entry is `42501`: Postgres raises it for an RLS denial, so a
 * cross-organization write surfaces as `403 FORBIDDEN` rather than as a
 * `500 INTERNAL_ERROR`. A 500 there would be a security smell — it would mean
 * the application could not tell "you may not" from "we broke".
 *
 * `P0001` is `raise exception` from our own triggers, which is how an illegal
 * ticket transition arrives: a conflict with current state, hence 409. The
 * transition trigger deliberately raises `42501` instead when the edge is legal
 * but the role may not drive it, which lands on 403 — the same 409/403 split
 * `isAllowedTransition` and `canTransition` make in application space.
 */
export const SQLSTATE_ERROR_CODES: Readonly<Record<string, ErrorCode>> = Object.freeze({
  /** `raise exception` from a domain trigger — illegal state transition. */
  P0001: 'CONFLICT',
  /** Insufficient privilege, including every row-level security denial. */
  '42501': 'FORBIDDEN',
  /** Invalid authorization specification. */
  '28000': 'UNAUTHENTICATED',
  /** Invalid parameter value — e.g. a malformed uuid cast. */
  '22023': 'VALIDATION_ERROR',
  /** Unique violation, including an idempotency-key collision. */
  '23505': 'CONFLICT',
  /** Foreign key violation. */
  '23503': 'UNPROCESSABLE',
  /** Check constraint violation. */
  '23514': 'UNPROCESSABLE',
});

/**
 * Map a SQLSTATE to one of the eight codes. Anything unrecognised is
 * `INTERNAL_ERROR` — failing closed, because an unmapped database error is by
 * definition one we have not reasoned about.
 */
export function errorCodeForSqlState(sqlState: string | null | undefined): ErrorCode {
  if (!sqlState) return 'INTERNAL_ERROR';
  return SQLSTATE_ERROR_CODES[sqlState] ?? 'INTERNAL_ERROR';
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** The HTTP status that must accompany a given code. */
export function statusForErrorCode(code: ErrorCode): number {
  return ERROR_STATUS[code];
}
