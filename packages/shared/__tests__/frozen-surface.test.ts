import { describe, expect, it } from 'vitest';

import * as shared from '../index';
import type { ApiError, ApiErrorDetail, ErrorCode } from '../constants/errors';
import type { Database } from '../types/database';

/**
 * The §5.4 interface freeze, asserted.
 *
 * `docs/parallel-execution-plan.md` §5.4 lists every name five other lanes may
 * import from this package. They cannot add to it after fan-out, so a missing
 * export is not a small bug — it blocks another lane and becomes a planning
 * defect for somebody else.
 *
 * This test exists so that a rename, a moved file or a dropped line in the
 * barrel fails here, by name, instead of failing in a feature lane days later.
 */

/** Verbatim from §5.4, "Shared schema exports — W0-L4". */
const FROZEN_SCHEMA_EXPORTS = [
  'CreatePropertySchema',
  'UpdatePropertySchema',
  'CreateUnitSchema',
  'UpdateUnitSchema',
  'CreateTenantSchema',
  'CreateTenancySchema',
  'UpdateTenancySchema',
  'CreateTicketSchema',
  'UpdateTicketSchema',
  'AssignTicketSchema',
  'CompleteTicketSchema',
  'CreateActivitySchema',
  'UploadUrlSchema',
  'VerifyDocumentSchema',
  'ClassifyRequestSchema',
  'ClassificationSchema',
  'ConfirmTicketSchema',
  'InviteMemberSchema',
  'CreateOrganizationSchema',
] as const;

/** The second sentence of §5.4: "Also ...". `ApiError` is a type, checked below. */
const FROZEN_VALUE_EXPORTS = [
  'ALLOWED_TRANSITIONS',
  'canTransition',
  'resolvePriority',
  'MEMBER_ROLES',
  'TICKET_STATUSES',
  'TICKET_PRIORITIES',
  'MAINTENANCE_CATEGORIES',
] as const;

const surface = shared as unknown as Record<string, unknown>;

describe('§5.4 frozen exports', () => {
  it.each(FROZEN_SCHEMA_EXPORTS)('exports %s', (name) => {
    expect(surface[name]).toBeDefined();
  });

  it.each(FROZEN_VALUE_EXPORTS)('exports %s', (name) => {
    expect(surface[name]).toBeDefined();
  });

  it('exports all 19 frozen schema names', () => {
    expect(FROZEN_SCHEMA_EXPORTS).toHaveLength(19);
    const missing = FROZEN_SCHEMA_EXPORTS.filter((name) => surface[name] === undefined);
    expect(missing).toEqual([]);
  });

  it('exposes every frozen schema as something parseable', () => {
    for (const name of FROZEN_SCHEMA_EXPORTS) {
      const schema = surface[name] as { safeParse?: unknown };
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  it('exposes canTransition and resolvePriority as functions', () => {
    expect(typeof shared.canTransition).toBe('function');
    expect(typeof shared.resolvePriority).toBe('function');
  });

  it('exposes the four enum constants as non-empty arrays', () => {
    for (const name of [
      'MEMBER_ROLES',
      'TICKET_STATUSES',
      'TICKET_PRIORITIES',
      'MAINTENANCE_CATEGORIES',
    ] as const) {
      const value = surface[name];
      expect(Array.isArray(value)).toBe(true);
      expect((value as readonly string[]).length).toBeGreaterThan(0);
    }
  });
});

describe('§5.2 error envelope', () => {
  /**
   * `ApiError` is a type, so it cannot be probed at runtime. These annotations
   * fail `tsc --noEmit` if the shape drifts from the frozen envelope, which is
   * the same gate CI runs.
   */
  it('matches the frozen envelope shape exactly', () => {
    const envelope: ApiError = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'The request is invalid.',
        request_id: 'correlation-id',
      },
    };

    const detail: ApiErrorDetail = envelope.error;
    const code: ErrorCode = detail.code;

    expect(code).toBe('VALIDATION_ERROR');
    expect(Object.keys(envelope)).toEqual(['error']);
    expect(Object.keys(envelope.error).sort()).toEqual(['code', 'message', 'request_id']);
  });

  it('round-trips through ApiErrorSchema, and rejects an off-contract shape', () => {
    const envelope = {
      error: { code: 'NOT_FOUND', message: 'The resource was not found.', request_id: 'abc' },
    };
    expect(shared.ApiErrorSchema.parse(envelope)).toEqual(envelope);

    // A ninth code, an extra field, and a flat shape are all rejected.
    expect(() =>
      shared.ApiErrorSchema.parse({
        error: { code: 'TEAPOT', message: 'x', request_id: 'abc' },
      }),
    ).toThrow();
    expect(() =>
      shared.ApiErrorSchema.parse({
        error: { code: 'NOT_FOUND', message: 'x', request_id: 'abc', stack: 'leak' },
      }),
    ).toThrow();
    expect(() =>
      shared.ApiErrorSchema.parse({ code: 'NOT_FOUND', message: 'x', request_id: 'abc' }),
    ).toThrow();
  });
});

describe('package shape', () => {
  it('re-exports the database types without widening them', () => {
    // Type-level only: proves the Database type reached the barrel intact.
    type Role = Database['public']['Enums']['member_role'];
    const role: Role = 'tenant';
    expect(shared.MEMBER_ROLES).toContain(role);
  });

  it('exports the compile-time enum parity guards, so the file is always compiled', () => {
    expect(shared.MEMBER_ROLE_PARITY).toBe(true);
    expect(shared.TICKET_STATUS_PARITY).toBe(true);
    expect(shared.TICKET_PRIORITY_PARITY).toBe(true);
  });

  it('has no undefined named export, which would mean a broken barrel re-export', () => {
    const broken = Object.keys(surface).filter((key) => surface[key] === undefined);
    expect(broken).toEqual([]);
  });
});
