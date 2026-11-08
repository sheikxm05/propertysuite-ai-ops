/**
 * The frozen eight: their status mapping, the SQLSTATE mapping mandated by the Wave 0
 * §5.2 amendment, and the exact shape of the error envelope.
 *
 * The envelope assertions use `toEqual` on the parsed body rather than checking
 * individual fields, because the contract is that there are *no other keys*. A test that
 * only checked `code` and `message` would pass while a route leaked a `detail` array.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ApiRouteError,
  ERROR_MESSAGES,
  ERROR_STATUS,
  SQLSTATE_ERROR_CODES,
  conflict,
  forbidden,
  isApiRouteError,
  isPostgresErrorLike,
  notFound,
  postgresErrorToApiError,
  postgresErrorToken,
  rateLimited,
  throwIfPostgresError,
  toApiRouteError,
  unauthenticated,
  unprocessable,
  validationError,
} from '../errors';
import { errorResponse, errorResponseFrom, ok, paginated } from '../responses';

const CODES = [
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNPROCESSABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;

describe('the code set', () => {
  it('is exactly the frozen eight', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...CODES].sort());
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...CODES].sort());
  });

  it('maps each code to the status in docs/api-contracts.md', () => {
    expect(ERROR_STATUS).toEqual({
      VALIDATION_ERROR: 400,
      UNAUTHENTICATED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      UNPROCESSABLE: 422,
      RATE_LIMITED: 429,
      INTERNAL_ERROR: 500,
    });
  });
});

describe('the envelope', () => {
  for (const code of CODES) {
    it(`${code} renders exactly { error: { code, message, request_id } }`, async () => {
      const response = errorResponse(code, 'req-1');
      expect(response.status).toBe(ERROR_STATUS[code]);
      expect(await response.json()).toEqual({
        error: { code, message: ERROR_MESSAGES[code], request_id: 'req-1' },
      });
    });
  }

  it('is JSON, uncacheable and correlated by header', () => {
    const response = errorResponse('NOT_FOUND', 'req-2');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('req-2');
  });

  it('adds Retry-After only for a rate-limited response', () => {
    expect(
      errorResponse('RATE_LIMITED', 'r', { retryAfterSeconds: 7 }).headers.get('Retry-After'),
    ).toBe('7');
    expect(errorResponse('CONFLICT', 'r').headers.get('Retry-After')).toBeNull();
  });

  it('never customises the 500 message, even when asked', async () => {
    const error = new ApiRouteError('INTERNAL_ERROR', {
      message: 'connection to db-prod-3 refused at 10.0.0.4:5432',
    });
    const body = (await errorResponseFrom(error, 'r').json()) as {
      error: { message: string };
    };
    expect(body.error.message).toBe(ERROR_MESSAGES.INTERNAL_ERROR);
    expect(JSON.stringify(body)).not.toContain('10.0.0.4');
  });

  it('allows a customised message on a client-fixable code', async () => {
    const body = (await errorResponseFrom(
      conflict({ message: 'That unit already has an active tenancy.' }),
      'r',
    ).json()) as { error: { message: string } };
    expect(body.error.message).toBe('That unit already has an active tenancy.');
  });
});

describe('success envelopes', () => {
  it('wraps a single resource in { data }', async () => {
    const response = ok({ id: 'p1' }, 'r');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 'p1' } });
  });

  it('wraps a page in { data, next_cursor } with an explicit null on the last page', async () => {
    expect(await paginated([{ id: 'a' }], null, 'r').json()).toEqual({
      data: [{ id: 'a' }],
      next_cursor: null,
    });
  });
});

describe('throwable constructors', () => {
  const cases = [
    [unauthenticated(), 401, 'UNAUTHENTICATED'],
    [forbidden(), 403, 'FORBIDDEN'],
    [notFound(), 404, 'NOT_FOUND'],
    [conflict(), 409, 'CONFLICT'],
    [unprocessable(), 422, 'UNPROCESSABLE'],
    [validationError(), 400, 'VALIDATION_ERROR'],
    [rateLimited(), 429, 'RATE_LIMITED'],
  ] as const;

  for (const [error, status, code] of cases) {
    it(`${code} carries status ${status}`, () => {
      expect(isApiRouteError(error)).toBe(true);
      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
    });
  }
});

describe('the SQLSTATE mapping (§5.2 amendment)', () => {
  const expected: Record<string, [string, number]> = {
    P0001: ['CONFLICT', 409],
    '42501': ['FORBIDDEN', 403],
    '28000': ['UNAUTHENTICATED', 401],
    '22023': ['VALIDATION_ERROR', 400],
    '23505': ['CONFLICT', 409],
    '23503': ['UNPROCESSABLE', 422],
    '23514': ['UNPROCESSABLE', 422],
  };

  it('covers exactly the mandated SQLSTATEs', () => {
    expect(Object.keys(SQLSTATE_ERROR_CODES).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [sqlstate, [code, status]] of Object.entries(expected)) {
    it(`${sqlstate} → ${code} ${status}`, () => {
      const error = postgresErrorToApiError({ code: sqlstate, message: 'something_went: x' });
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
    });
  }

  it('maps anything else to a 500', () => {
    expect(postgresErrorToApiError({ code: '40001', message: 'serialisation' }).status).toBe(500);
    expect(postgresErrorToApiError({ code: undefined, message: 'who knows' }).status).toBe(500);
  });

  it("treats PostgREST's no-rows code as a 404, not a 500", () => {
    expect(postgresErrorToApiError({ code: 'PGRST116', message: 'no rows' }).status).toBe(404);
  });

  it('turns an illegal ticket transition into a 409', () => {
    const error = postgresErrorToApiError({
      code: 'P0001',
      message: 'ticket_status_transition_invalid: open -> completed is not an allowed transition',
    });
    expect(error.status).toBe(409);
    expect(error.logFields.reason).toBe('ticket_status_transition_invalid');
  });

  it('turns a provider driving a forbidden transition into a 403', () => {
    const error = postgresErrorToApiError({
      code: '42501',
      message: 'ticket_status_transition_forbidden_for_role: a service provider may not drive x',
    });
    expect(error.status).toBe(403);
    expect(error.logFields.reason).toBe('ticket_status_transition_forbidden_for_role');
  });

  it('turns an activity mutation into a 409', () => {
    expect(
      postgresErrorToApiError({
        code: 'P0001',
        message: 'maintenance_activities_immutable: UPDATE is not permitted',
      }).status,
    ).toBe(409);
  });

  it('never puts the raw Postgres message on the wire', async () => {
    const error = postgresErrorToApiError({
      code: 'P0001',
      message: "ticket_status_transition_invalid: 'A. Person' at +971501234567 -> completed",
    });
    const text = await errorResponseFrom(error, 'r').text();
    expect(text).not.toContain('A. Person');
    expect(text).not.toContain('971501234567');
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'CONFLICT',
        message: ERROR_MESSAGES.CONFLICT,
        request_id: 'r',
      },
    });
  });
});

describe('postgresErrorToken', () => {
  it('extracts the leading snake_case token', () => {
    expect(postgresErrorToken('ticket_initial_status_invalid: must be open')).toBe(
      'ticket_initial_status_invalid',
    );
  });

  it('returns null when there is no token', () => {
    expect(postgresErrorToken('something went wrong')).toBeNull();
    expect(postgresErrorToken(null)).toBeNull();
    expect(postgresErrorToken('')).toBeNull();
  });
});

describe('throwIfPostgresError', () => {
  it('does nothing on success', () => {
    expect(() => throwIfPostgresError(null)).not.toThrow();
    expect(() => throwIfPostgresError(undefined)).not.toThrow();
  });

  it('throws the mapped error', () => {
    expect(() => throwIfPostgresError({ code: '23505', message: 'dup' })).toThrow(ApiRouteError);
  });
});

describe('toApiRouteError', () => {
  it('passes an ApiRouteError through unchanged', () => {
    const original = notFound();
    expect(toApiRouteError(original)).toBe(original);
  });

  it('maps a ZodError to 400', () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const error = toApiRouteError(parsed.error);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('maps a recognised Postgres error', () => {
    expect(toApiRouteError({ code: 'P0001', message: 'x: y' }).status).toBe(409);
  });

  it('refuses to launder an arbitrary object into a 4xx', () => {
    expect(toApiRouteError({ message: 'I am not a database error' }).status).toBe(500);
    expect(toApiRouteError({ code: 'NOT_A_SQLSTATE', message: 'x' }).status).toBe(500);
  });

  it('maps a plain Error to 500', () => {
    expect(toApiRouteError(new Error('boom')).status).toBe(500);
    expect(toApiRouteError('a string').status).toBe(500);
    expect(toApiRouteError(undefined).status).toBe(500);
  });
});

describe('isPostgresErrorLike', () => {
  it('recognises the postgrest error shape', () => {
    expect(isPostgresErrorLike({ code: '23505', message: 'x' })).toBe(true);
    expect(isPostgresErrorLike({ message: 'x' })).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isPostgresErrorLike(null)).toBe(false);
    expect(isPostgresErrorLike('x')).toBe(false);
    expect(isPostgresErrorLike({ foo: 1 })).toBe(false);
  });
});
