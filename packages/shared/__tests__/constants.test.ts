import { describe, expect, it } from 'vitest';

import { MAINTENANCE_CATEGORIES } from '../constants/categories';
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  ERROR_STATUS,
  SQLSTATE_ERROR_CODES,
  errorCodeForSqlState,
  isErrorCode,
  statusForErrorCode,
} from '../constants/errors';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants/pagination';
import { MEMBER_ROLES, STAFF_ROLES, isMemberRole, isStaffRole } from '../constants/roles';
import {
  ACTIVITY_TYPES,
  ALLOWED_TENANCY_TRANSITIONS,
  DEAD_LETTER_JOB_STATUS,
  INVITATION_STATUSES,
  JOB_STATUSES,
  MEMBER_STATUSES,
  ORGANIZATION_STATUSES,
  PROPERTY_STATUSES,
  SERVICE_PROVIDER_STATUSES,
  TENANCY_STATUSES,
  TICKET_SOURCES,
  UNIT_STATUSES,
  VERIFICATION_STATUSES,
  canTransitionTenancy,
} from '../constants/statuses';
import { TICKET_PRIORITIES, TICKET_STATUSES } from '../constants/ticket-status';

/**
 * Constants versus the migrations.
 *
 * The three Postgres enums are guarded at compile time by
 * `constants/enum-parity.ts`, which fails `tsc` if they drift. The `check (... in
 * (...))` lists have no database type to compare against, so they are asserted
 * here against the literals transcribed from
 * `supabase/migrations/0001_initial_schema.sql` and `0003_domain_integrity.sql`.
 * That is the best a test can do for a check constraint, and it is still enough
 * to catch a typo or a silently dropped value.
 */

describe('roles', () => {
  it('mirrors public.member_role in declaration order', () => {
    expect(MEMBER_ROLES).toEqual([
      'organization_admin',
      'property_owner',
      'property_manager',
      'tenant',
      'service_provider',
    ]);
  });

  it('defines staff as exactly what is_org_staff() resolves to', () => {
    expect(STAFF_ROLES).toEqual(['organization_admin', 'property_manager']);
  });

  it('guards role values at runtime', () => {
    expect(isMemberRole('tenant')).toBe(true);
    expect(isMemberRole('superuser')).toBe(false);
    expect(isMemberRole(undefined)).toBe(false);
    expect(isStaffRole('property_manager')).toBe(true);
    expect(isStaffRole('tenant')).toBe(false);
  });
});

describe('ticket enums', () => {
  it('mirrors public.ticket_status in declaration order', () => {
    expect(TICKET_STATUSES).toEqual([
      'open',
      'assigned',
      'in_progress',
      'awaiting_approval',
      'completed',
      'cancelled',
    ]);
  });

  it('mirrors public.ticket_priority in declaration order', () => {
    expect(TICKET_PRIORITIES).toEqual(['low', 'normal', 'high', 'urgent']);
  });
});

describe('check-constraint lists', () => {
  it('matches organizations.status', () => {
    expect(ORGANIZATION_STATUSES).toEqual(['active', 'suspended']);
  });

  it('matches organization_members.status', () => {
    expect(MEMBER_STATUSES).toEqual(['invited', 'active', 'disabled']);
  });

  it('matches properties.status', () => {
    expect(PROPERTY_STATUSES).toEqual(['active', 'archived']);
  });

  it('matches property_units.status', () => {
    expect(UNIT_STATUSES).toEqual(['available', 'occupied', 'inactive']);
  });

  it('matches tenancies.status', () => {
    expect(TENANCY_STATUSES).toEqual(['draft', 'active', 'expired', 'terminated']);
  });

  it('matches service_providers.status', () => {
    expect(SERVICE_PROVIDER_STATUSES).toEqual(['active', 'inactive']);
  });

  it('matches maintenance_tickets.source', () => {
    expect(TICKET_SOURCES).toEqual(['web', 'whatsapp', 'email', 'admin']);
  });

  it('matches documents.verification_status', () => {
    expect(VERIFICATION_STATUSES).toEqual(['pending', 'verified', 'rejected']);
  });

  it('matches jobs.status from migration 0003', () => {
    expect(JOB_STATUSES).toEqual(['queued', 'running', 'failed', 'dead', 'done']);
    expect(DEAD_LETTER_JOB_STATUS).toBe('dead');
  });

  it('matches organization_invitations.status from migration 0003', () => {
    expect(INVITATION_STATUSES).toEqual(['pending', 'accepted', 'revoked']);
  });

  it('contains no value that deletes a record — archive is the only removal path', () => {
    const everyStatus = [
      ...ORGANIZATION_STATUSES,
      ...MEMBER_STATUSES,
      ...PROPERTY_STATUSES,
      ...UNIT_STATUSES,
      ...TENANCY_STATUSES,
      ...SERVICE_PROVIDER_STATUSES,
      ...VERIFICATION_STATUSES,
    ];
    for (const status of everyStatus) {
      expect(status).not.toMatch(/delete|removed|purged/i);
    }
  });
});

describe('maintenance categories', () => {
  it('matches the allowed list in the classification prompt contract', () => {
    expect(MAINTENANCE_CATEGORIES).toEqual([
      'hvac',
      'plumbing',
      'electrical',
      'appliance',
      'structural',
      'pest_control',
      'cleaning',
      'other',
      'unknown',
    ]);
  });

  it('includes unknown, which is the database default for the column', () => {
    expect(MAINTENANCE_CATEGORIES).toContain('unknown');
  });
});

describe('activity types', () => {
  it('covers every transition the state machine can produce', () => {
    expect(ACTIVITY_TYPES).toContain('ticket_created');
    expect(ACTIVITY_TYPES).toContain('status_changed');
    expect(ACTIVITY_TYPES).toContain('provider_assigned');
    expect(ACTIVITY_TYPES).toContain('completion_confirmed');
    expect(ACTIVITY_TYPES).toContain('ticket_cancelled');
  });

  it('has no duplicates', () => {
    expect(new Set(ACTIVITY_TYPES).size).toBe(ACTIVITY_TYPES.length);
  });
});

describe('error contract', () => {
  it('contains exactly the frozen eight codes, in §5.2 order', () => {
    expect(ERROR_CODES).toEqual([
      'VALIDATION_ERROR',
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'UNPROCESSABLE',
      'RATE_LIMITED',
      'INTERNAL_ERROR',
    ]);
    expect(ERROR_CODES).toHaveLength(8);
  });

  it('maps each code to the status in api-contracts.md', () => {
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

  it('gives every code a status and a message', () => {
    for (const code of ERROR_CODES) {
      expect(statusForErrorCode(code)).toBeGreaterThanOrEqual(400);
      expect(ERROR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('keeps messages free of anything that could leak another organization’s data', () => {
    for (const code of ERROR_CODES) {
      const message = ERROR_MESSAGES[code];
      expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
      expect(message).not.toMatch(/select |from |where |organization_id/i);
    }
  });

  it('makes a missing resource and an inaccessible one indistinguishable in wording', () => {
    expect(ERROR_MESSAGES.NOT_FOUND).not.toMatch(/exists|belongs|another/i);
    expect(ERROR_MESSAGES.FORBIDDEN).not.toMatch(/exists|organization/i);
  });

  it('guards codes at runtime', () => {
    expect(isErrorCode('CONFLICT')).toBe(true);
    expect(isErrorCode('TEAPOT')).toBe(false);
  });
});

describe('SQLSTATE mapping (amendment A2)', () => {
  it('maps an RLS denial to FORBIDDEN, not INTERNAL_ERROR', () => {
    expect(errorCodeForSqlState('42501')).toBe('FORBIDDEN');
    expect(ERROR_STATUS[errorCodeForSqlState('42501')]).toBe(403);
  });

  it('maps a trigger-raised exception to CONFLICT, which is the illegal-transition case', () => {
    expect(errorCodeForSqlState('P0001')).toBe('CONFLICT');
    expect(ERROR_STATUS[errorCodeForSqlState('P0001')]).toBe(409);
  });

  it('maps constraint violations to UNPROCESSABLE and uniqueness to CONFLICT', () => {
    expect(errorCodeForSqlState('23503')).toBe('UNPROCESSABLE');
    expect(errorCodeForSqlState('23514')).toBe('UNPROCESSABLE');
    expect(errorCodeForSqlState('23505')).toBe('CONFLICT');
  });

  it('fails closed on an unmapped or missing SQLSTATE', () => {
    expect(errorCodeForSqlState('XX000')).toBe('INTERNAL_ERROR');
    expect(errorCodeForSqlState(null)).toBe('INTERNAL_ERROR');
    expect(errorCodeForSqlState(undefined)).toBe('INTERNAL_ERROR');
    expect(errorCodeForSqlState('')).toBe('INTERNAL_ERROR');
  });

  it('only ever yields one of the frozen eight', () => {
    for (const code of Object.values(SQLSTATE_ERROR_CODES)) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

describe('pagination defaults (§5.7)', () => {
  it('defaults to 25 and caps at 100', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect(MAX_PAGE_SIZE).toBe(100);
  });
});

describe('tenancy lifecycle', () => {
  it('moves a draft to active or straight to terminated', () => {
    expect(canTransitionTenancy('draft', 'active')).toBe(true);
    expect(canTransitionTenancy('draft', 'terminated')).toBe(true);
    expect(canTransitionTenancy('draft', 'expired')).toBe(false);
  });

  it('ends an active tenancy by expiry or termination', () => {
    expect(canTransitionTenancy('active', 'expired')).toBe(true);
    expect(canTransitionTenancy('active', 'terminated')).toBe(true);
    expect(canTransitionTenancy('active', 'draft')).toBe(false);
  });

  it('treats expired and terminated as terminal', () => {
    for (const to of TENANCY_STATUSES) {
      expect(canTransitionTenancy('expired', to)).toBe(false);
      expect(canTransitionTenancy('terminated', to)).toBe(false);
    }
  });

  it('has an entry for every status', () => {
    expect(Object.keys(ALLOWED_TENANCY_TRANSITIONS).sort()).toEqual([...TENANCY_STATUSES].sort());
  });
});
