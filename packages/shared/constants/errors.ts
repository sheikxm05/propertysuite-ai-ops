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

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** The HTTP status that must accompany a given code. */
export function statusForErrorCode(code: ErrorCode): number {
  return ERROR_STATUS[code];
}
