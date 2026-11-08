/**
 * Response contract enforcement — fail-closed.
 *
 * Every item schema in `packages/shared/schemas/**` is `.strict()`, so passing a
 * `*ResponseSchema` to `ok`, `created`, `accepted` or `paginated` means an undeclared key
 * is **rejected**, not stripped: the response becomes a 500 and nothing undeclared
 * reaches the client.
 *
 * That is the control, and these tests pin it from both sides:
 *
 *  - a route that over-selects gets `INTERNAL_ERROR` in the frozen envelope, and neither
 *    the undeclared key nor its value appears anywhere in the response;
 *  - the server-side log records the failure loudly, carrying the offending key NAMES
 *    only — never values, because a value is exactly the personal data the rejection just
 *    stopped.
 *
 * There is deliberately no strip-and-warn path. An earlier draft of this lane assumed one
 * because `listResponseSchema`'s envelope is strict while a *non-strict* item schema
 * would strip. No shared schema is written that way, so the machinery could never fire,
 * and dead code that looks like a security control is worse than none: the next reader
 * would assume stripping protected them and select freely.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { listResponseSchema, resourceResponseSchema } from '@/lib/shared';

import { ApiRouteError, ERROR_MESSAGES } from '../errors';
import { accepted, created, errorResponseFrom, ok, paginated } from '../responses';

/** Shaped like the real shared schemas: strict item inside a strict envelope. */
const PropertyLike = resourceResponseSchema(
  z.object({ id: z.string().uuid(), name: z.string() }).strict(),
);

const TenantListLike = listResponseSchema(
  z.object({ id: z.string().uuid(), full_name: z.string() }).strict(),
);

const ID = '11111111-1111-1111-1111-111111111111';
const ID2 = '22222222-2222-2222-2222-222222222222';
const PAGE = { nextCursor: null, hasMore: false, limit: 25 } as const;

/** Runs a thrower and returns the `ApiRouteError` it produced. */
function captureError(run: () => unknown): ApiRouteError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiRouteError);
    return error as ApiRouteError;
  }
  throw new Error('expected the call to throw');
}

/* ------------------------------------------------------- the conforming path -- */

describe('a body that satisfies its contract', () => {
  it('ships unchanged through ok()', async () => {
    const response = ok({ id: ID, name: 'Marina Residence' }, 'r', { schema: PropertyLike });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: ID, name: 'Marina Residence' } });
  });

  it('ships unchanged through created(), keeping 201 and Location', async () => {
    const response = created({ id: ID, name: 'M' }, 'r', {
      schema: PropertyLike,
      location: `/api/v1/properties/${ID}`,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('Location')).toBe(`/api/v1/properties/${ID}`);
    expect(await response.json()).toEqual({ data: { id: ID, name: 'M' } });
  });

  it('ships unchanged through accepted(), keeping 202', async () => {
    const schema = resourceResponseSchema(z.object({ job_id: z.string() }).strict());
    const response = accepted({ job_id: 'job-1' }, 'r', { schema });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { job_id: 'job-1' } });
  });

  it('ships unchanged through paginated()', async () => {
    const response = paginated([{ id: ID, full_name: 'A Person' }], PAGE, 'r', {
      schema: TenantListLike,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ id: ID, full_name: 'A Person' }],
      page_info: { next_cursor: null, has_more: false, limit: 25 },
    });
  });

  it('keeps the no-store and correlation discipline when a schema is used', () => {
    const response = ok({ id: ID, name: 'M' }, 'req-7', { schema: PropertyLike });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('req-7');
  });

  it('honours an explicit header alongside a schema', () => {
    const response = ok({ id: ID, name: 'M' }, 'r', {
      schema: PropertyLike,
      headers: { 'x-custom': '1' },
    });
    expect(response.headers.get('x-custom')).toBe('1');
  });
});

describe('no schema means no enforcement', () => {
  it('passes any body through ok()', async () => {
    expect(await ok({ id: ID, anything: true }, 'r').json()).toEqual({
      data: { id: ID, anything: true },
    });
  });

  it('passes any page through paginated()', async () => {
    const body = await paginated([{ whatever: 1 }], PAGE, 'r').json();
    expect(body).toEqual({
      data: [{ whatever: 1 }],
      page_info: { next_cursor: null, has_more: false, limit: 25 },
    });
  });
});

/* ------------------------------------------------------ the over-select path -- */

describe('an over-selecting route fails closed', () => {
  const overSelected = {
    id: ID,
    name: 'Marina Residence',
    owner_email: 'owner@example.com',
    owner_phone: '+971501234567',
  };

  it('throws rather than returning the undeclared columns', () => {
    const error = captureError(() => ok(overSelected, 'r', { schema: PropertyLike }));
    expect(error.status).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('renders the frozen 500 envelope, with no trace of the data', async () => {
    const error = captureError(() => ok(overSelected, 'r', { schema: PropertyLike }));
    const text = await errorResponseFrom(error, 'r').text();

    expect(text).not.toContain('owner@example.com');
    expect(text).not.toContain('971501234567');
    expect(text).not.toContain('owner_email');
    expect(JSON.parse(text)).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: ERROR_MESSAGES.INTERNAL_ERROR,
        request_id: 'r',
      },
    });
  });

  it('logs the offending key names, sorted', () => {
    const error = captureError(() => ok(overSelected, 'r', { schema: PropertyLike }));
    expect(error.logFields).toMatchObject({
      reason: 'resource_response_schema_rejected',
      unexpected_fields: ['owner_email', 'owner_phone'],
    });
  });

  it('never logs an offending value', () => {
    const error = captureError(() => ok(overSelected, 'r', { schema: PropertyLike }));
    const serialised = JSON.stringify(error.logFields);
    expect(serialised).toContain('owner_email');
    expect(serialised).not.toContain('owner@example.com');
    expect(serialised).not.toContain('971501234567');
  });

  it('applies to created() too', () => {
    const error = captureError(() => created(overSelected, 'r', { schema: PropertyLike }));
    expect(error.status).toBe(500);
    expect(error.logFields.reason).toBe('resource_response_schema_rejected');
  });

  it('applies to accepted() too', () => {
    const schema = resourceResponseSchema(z.object({ job_id: z.string() }).strict());
    const error = captureError(() =>
      accepted({ job_id: 'j1', internal_note: 'x' }, 'r', { schema }),
    );
    expect(error.status).toBe(500);
  });

  it('applies to a list, naming each undeclared column once', () => {
    const error = captureError(() =>
      paginated(
        [
          { id: ID, full_name: 'A', email: 'a@example.com', phone: '+971501111111' },
          { id: ID2, full_name: 'B', email: 'b@example.com', phone: '+971502222222' },
        ],
        PAGE,
        'r',
        { schema: TenantListLike },
      ),
    );

    expect(error.status).toBe(500);
    expect(error.logFields).toMatchObject({
      reason: 'list_response_schema_rejected',
      unexpected_fields: ['email', 'phone'],
    });
    expect(JSON.stringify(error.logFields)).not.toContain('@example.com');
  });

  it('rejects a wrong type as well as an extra key', () => {
    const error = captureError(() => ok({ id: 42, name: 'M' }, 'r', { schema: PropertyLike }));
    expect(error.status).toBe(500);
    // No unrecognized key here, so the name list is empty rather than wrong.
    expect(error.logFields.unexpected_fields).toEqual([]);
  });

  it('rejects a missing required field', () => {
    const error = captureError(() => ok({ id: ID }, 'r', { schema: PropertyLike }));
    expect(error.status).toBe(500);
  });
});

/* ------------------------------------------- A19: the one-time invitation token -- */

describe('the one-time invitation token (A19)', () => {
  /**
   * Mirrors `InviteMemberResultSchema`. Transcribed rather than imported so this test
   * fails if the shared schema ever loses the token, instead of silently agreeing with
   * it.
   */
  const InviteResult = resourceResponseSchema(
    z
      .object({
        invitation_id: z.string().uuid(),
        token: z.string().min(16),
        role: z.string(),
        expires_at: z.string(),
      })
      .strict(),
  );

  const result = {
    invitation_id: ID,
    token: 'inv_tok_abcdefghijklmnopqrstuvwxyz',
    role: 'property_manager',
    expires_at: '2026-12-01T00:00:00.000Z',
  };

  it('survives the enforcement path under the token-carrying contract', async () => {
    const body = (await created(result, 'r', { schema: InviteResult }).json()) as {
      data: { token?: string };
    };
    expect(body.data.token).toBe(result.token);
  });

  it('survives when no schema is passed at all', async () => {
    const body = (await created(result, 'r').json()) as { data: { token?: string } };
    expect(body.data.token).toBe(result.token);
  });

  it('is never silently dropped: a token-less contract is a loud 500', () => {
    // `IssuedInvitationResponseSchema` omits `token`, which A19 overruled because §5.1
    // has no mail transport, so an invitation whose plaintext token is never returned is
    // permanently unredeemable. Because the shared item schemas are strict, reaching for
    // the wrong contract fails the request outright instead of returning a cheerful 201
    // with an unusable invitation. Fail-closed is what makes that safe.
    const TokenLess = resourceResponseSchema(
      z
        .object({
          invitation_id: z.string().uuid(),
          role: z.string(),
          expires_at: z.string(),
        })
        .strict(),
    );

    const error = captureError(() => created(result, 'r', { schema: TokenLess }));
    expect(error.status).toBe(500);
    expect(error.logFields.unexpected_fields).toEqual(['token']);
  });

  it('names the token key in the log but never its value', () => {
    const TokenLess = resourceResponseSchema(
      z
        .object({
          invitation_id: z.string().uuid(),
          role: z.string(),
          expires_at: z.string(),
        })
        .strict(),
    );
    const error = captureError(() => created(result, 'r', { schema: TokenLess }));

    const serialised = JSON.stringify(error.logFields);
    expect(serialised).toContain('token');
    expect(serialised).not.toContain(result.token);
  });

  it('keeps the token out of the response body on that failure', async () => {
    const TokenLess = resourceResponseSchema(
      z
        .object({
          invitation_id: z.string().uuid(),
          role: z.string(),
          expires_at: z.string(),
        })
        .strict(),
    );
    const error = captureError(() => created(result, 'r', { schema: TokenLess }));
    const text = await errorResponseFrom(error, 'r').text();
    expect(text).not.toContain(result.token);
  });
});
