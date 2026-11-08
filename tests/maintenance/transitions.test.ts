/**
 * The state machine, in the domain layer.
 *
 * The rule set is IMPORTED from `packages/shared` and the expectations are DERIVED from
 * it, never transcribed: the illegal set is "every ordered pair of statuses minus the
 * legal ones", and the wrong-role set is "every legal edge crossed with every role the
 * shared table does not list". So an edge added to `ALLOWED_TRANSITIONS` moves itself
 * from the illegal suite to the legal one, and this file cannot drift from the
 * specification — only from its own canary, which is the first `describe` below.
 *
 * `tests/rls/state-machine.test.ts` (lane w0-l6) proves the same graph against the
 * trigger in migration `0003`. This file proves the DOMAIN layer, which is the third of
 * the three enforcement points. Both are necessary: an attacker with a valid session
 * talks to PostgREST and never runs this TypeScript, and a defect in `0002`'s policies
 * must not make the application layer permissive.
 *
 * The status-code mapping asserted here is the frozen one (§5.2 plus amendment A2) and
 * the one the live database was observed to produce:
 *
 *   an edge that does not exist              409 CONFLICT   (trigger: `P0001`)
 *   an edge this role may not drive          403 FORBIDDEN  (trigger: `42501`)
 *   an edge on a row that is not the caller's 403 FORBIDDEN  (RLS: zero rows)
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  MEMBER_ROLES,
  TICKET_STATUSES,
  TRANSITION_ROLES,
  canTransition,
  isAllowedTransition,
  type MemberRole,
  type TicketStatus,
} from '@shared/index';

import { ApiRouteError } from '@/lib/api/errors';
import {
  PROVIDER_JOB_STATUSES,
  TICKET_ASSIGN_ROLES,
  TICKET_COMPLETE_ROLES,
  TICKET_TRANSITION_ROLES,
  assertTicketTransition,
  availableTransitions,
  classifyTicketTransition,
  transitionActivityType,
  type TransitionSubject,
} from '@/features/maintenance/domain';

import {
  ORG_A,
  OTHER_PROVIDER_ID,
  OTHER_TENANT_ID,
  PROVIDER_ID,
  TENANT_ID,
  TICKET_ID,
  membershipFor,
} from './_support/fixtures';

/** Every ordered pair of distinct statuses, partitioned by the shared rule set. */
const EDGES = TICKET_STATUSES.flatMap((from) =>
  TICKET_STATUSES.filter((to) => to !== from).map((to) => ({
    from,
    to,
    legal: isAllowedTransition(from, to),
  })),
);

const LEGAL = EDGES.filter((edge) => edge.legal);
const ILLEGAL = EDGES.filter((edge) => !edge.legal);

/**
 * A ticket in `status` whose row binding is satisfied for `role`.
 *
 * For a provider that means `assigned_provider_id` is their own, even in statuses where
 * a real ticket would not yet be assigned. That is intentional: this sweep isolates the
 * ROLE question from the ROW question, and the row question has its own tests below.
 */
function subjectFor(status: TicketStatus, role: MemberRole): TransitionSubject {
  return {
    id: TICKET_ID,
    organization_id: ORG_A,
    status,
    tenant_id: TENANT_ID,
    assigned_provider_id: role === 'service_provider' ? PROVIDER_ID : null,
  };
}

describe('the shared rule set is the specification', () => {
  it('has the nine edges §4 and amendment A9 describe', () => {
    // A canary. If `ALLOWED_TRANSITIONS` were ever emptied, every illegal case below
    // would still pass and the suite would prove nothing.
    expect(LEGAL.length).toBe(9);
    expect(ILLEGAL.length).toBe(EDGES.length - 9);
  });

  it('includes the A9 rework edge, staff only', () => {
    expect(ALLOWED_TRANSITIONS.awaiting_approval).toContain('in_progress');
    expect(TRANSITION_ROLES.awaiting_approval.in_progress).toEqual([
      'organization_admin',
      'property_manager',
    ]);
  });

  it('treats completed and cancelled as terminal', () => {
    expect(ALLOWED_TRANSITIONS.completed).toEqual([]);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('every illegal edge is a 409, for every role', () => {
  for (const { from, to } of ILLEGAL) {
    for (const role of MEMBER_ROLES) {
      it(`${role}: ${from} -> ${to}`, () => {
        const verdict = classifyTicketTransition(subjectFor(from, role), to, membershipFor(role));
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.kind).toBe('invalid_edge');

        try {
          assertTicketTransition(subjectFor(from, role), to, membershipFor(role));
          expect.unreachable('an illegal edge must throw');
        } catch (error) {
          expect(error).toBeInstanceOf(ApiRouteError);
          expect((error as ApiRouteError).code).toBe('CONFLICT');
          expect((error as ApiRouteError).status).toBe(409);
        }
      });
    }
  }

  it('rejects the two jumps confirmed rejected on the live database', () => {
    // Recorded in the lane briefing: `open -> completed` and `open -> awaiting_approval`
    // were observed to be refused by the trigger, and `open -> assigned` to succeed.
    expect(isAllowedTransition('open', 'completed')).toBe(false);
    expect(isAllowedTransition('open', 'awaiting_approval')).toBe(false);
    expect(isAllowedTransition('open', 'assigned')).toBe(true);
  });

  it('rejects a no-op status write as a conflict rather than silently accepting it', () => {
    const verdict = classifyTicketTransition(
      subjectFor('open', 'property_manager'),
      'open',
      membershipFor('property_manager'),
    );
    expect(verdict.ok === false && verdict.kind).toBe('invalid_edge');
  });
});

describe('every legal edge driven by the wrong role is a 403', () => {
  for (const { from, to } of LEGAL) {
    const permitted = TRANSITION_ROLES[from][to] ?? [];
    const refused = MEMBER_ROLES.filter((role) => !permitted.includes(role));

    for (const role of refused) {
      it(`${role}: ${from} -> ${to}`, () => {
        const verdict = classifyTicketTransition(subjectFor(from, role), to, membershipFor(role));
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.kind).toBe('role_forbidden');

        try {
          assertTicketTransition(subjectFor(from, role), to, membershipFor(role));
          expect.unreachable('a wrong-role edge must throw');
        } catch (error) {
          expect((error as ApiRouteError).code).toBe('FORBIDDEN');
          expect((error as ApiRouteError).status).toBe(403);
        }
      });
    }

    for (const role of permitted) {
      it(`${role} may drive ${from} -> ${to}`, () => {
        expect(canTransition(from, to, role)).toBe(true);
        expect(classifyTicketTransition(subjectFor(from, role), to, membershipFor(role)).ok).toBe(
          true,
        );
      });
    }
  }

  it('never lists property_owner on any edge', () => {
    expect(TICKET_TRANSITION_ROLES).not.toContain('property_owner');
  });
});

describe('the rework edge', () => {
  const subject: TransitionSubject = {
    id: TICKET_ID,
    organization_id: ORG_A,
    status: 'awaiting_approval',
    tenant_id: TENANT_ID,
    assigned_provider_id: PROVIDER_ID,
  };

  it('works for a property_manager', () => {
    expect(
      classifyTicketTransition(subject, 'in_progress', membershipFor('property_manager')).ok,
    ).toBe(true);
  });

  it('works for an organization_admin', () => {
    expect(
      classifyTicketTransition(subject, 'in_progress', membershipFor('organization_admin')).ok,
    ).toBe(true);
  });

  it('does not work for the assigned service_provider', () => {
    // The provider is the assignee, so this is purely the role rule: a provider cannot
    // send its own job back for rework, which also means it cannot reset a rejection.
    const verdict = classifyTicketTransition(
      subject,
      'in_progress',
      membershipFor('service_provider'),
    );
    expect(verdict.ok === false && verdict.kind).toBe('role_forbidden');
  });

  it('does not work for the reporting tenant', () => {
    const verdict = classifyTicketTransition(subject, 'in_progress', membershipFor('tenant'));
    expect(verdict.ok === false && verdict.kind).toBe('role_forbidden');
  });

  it('exists so a rejection does not have to discard the work', () => {
    // The alternative to rework is cancel, which is terminal. Asserting that cancel is
    // the only other option out of `awaiting_approval` for a manager is what makes the
    // amendment's rationale testable rather than a comment.
    const manager = membershipFor('property_manager');
    expect(availableTransitions(subject, manager)).toEqual([
      'completed',
      'in_progress',
      'cancelled',
    ]);
  });
});

describe('cancellation', () => {
  it('lets the reporting tenant cancel while the ticket is still open', () => {
    const subject: TransitionSubject = {
      id: TICKET_ID,
      organization_id: ORG_A,
      status: 'open',
      tenant_id: TENANT_ID,
      assigned_provider_id: null,
    };
    expect(classifyTicketTransition(subject, 'cancelled', membershipFor('tenant')).ok).toBe(true);
  });

  it('does not let the reporting tenant cancel once it is assigned', () => {
    const subject: TransitionSubject = {
      id: TICKET_ID,
      organization_id: ORG_A,
      status: 'assigned',
      tenant_id: TENANT_ID,
      assigned_provider_id: PROVIDER_ID,
    };
    const verdict = classifyTicketTransition(subject, 'cancelled', membershipFor('tenant'));
    expect(verdict.ok === false && verdict.kind).toBe('role_forbidden');
  });

  it('does not let a DIFFERENT tenant cancel an open ticket', () => {
    const subject: TransitionSubject = {
      id: TICKET_ID,
      organization_id: ORG_A,
      status: 'open',
      tenant_id: OTHER_TENANT_ID,
      assigned_provider_id: null,
    };
    const verdict = classifyTicketTransition(subject, 'cancelled', membershipFor('tenant'));
    // The ROLE may drive this edge; the ROW is not theirs. Still a 403, and the reason
    // distinguishes the two in the log without distinguishing them on the wire.
    expect(verdict.ok === false && verdict.kind).toBe('row_forbidden');
    expect(verdict.ok === false && verdict.reason).toBe('not_the_reporting_tenant');
  });

  it('never lets a service_provider cancel', () => {
    for (const status of ['assigned', 'in_progress', 'awaiting_approval'] as const) {
      const verdict = classifyTicketTransition(
        subjectFor(status, 'service_provider'),
        'cancelled',
        membershipFor('service_provider'),
      );
      expect(verdict.ok === false && verdict.kind).toBe('role_forbidden');
    }
  });

  it('never lets a property_owner cancel', () => {
    const verdict = classifyTicketTransition(
      subjectFor('open', 'property_owner'),
      'cancelled',
      membershipFor('property_owner'),
    );
    expect(verdict.ok === false && verdict.kind).toBe('role_forbidden');
  });

  it('lets staff cancel from any non-terminal status', () => {
    for (const status of ['open', 'assigned', 'in_progress', 'awaiting_approval'] as const) {
      for (const role of ['organization_admin', 'property_manager'] as const) {
        expect(
          classifyTicketTransition(subjectFor(status, role), 'cancelled', membershipFor(role)).ok,
        ).toBe(true);
      }
    }
  });
});

describe('a provider is bound to their own assigned work', () => {
  const provider = membershipFor('service_provider');

  it('may advance a ticket assigned to them', () => {
    const subject: TransitionSubject = {
      id: TICKET_ID,
      organization_id: ORG_A,
      status: 'assigned',
      tenant_id: TENANT_ID,
      assigned_provider_id: PROVIDER_ID,
    };
    expect(classifyTicketTransition(subject, 'in_progress', provider).ok).toBe(true);
  });

  it('may not touch a ticket assigned to another provider', () => {
    const subject: TransitionSubject = {
      id: TICKET_ID,
      organization_id: ORG_A,
      status: 'assigned',
      tenant_id: TENANT_ID,
      assigned_provider_id: OTHER_PROVIDER_ID,
    };
    const verdict = classifyTicketTransition(subject, 'in_progress', provider);
    expect(verdict.ok === false && verdict.kind).toBe('row_forbidden');
    expect(verdict.ok === false && verdict.reason).toBe('not_the_assigned_provider');
  });

  it('may not touch unassigned work', () => {
    const subject: TransitionSubject = {
      id: TICKET_ID,
      organization_id: ORG_A,
      status: 'assigned',
      tenant_id: TENANT_ID,
      assigned_provider_id: null,
    };
    const verdict = classifyTicketTransition(subject, 'in_progress', provider);
    expect(verdict.ok === false && verdict.kind).toBe('row_forbidden');
  });

  it('is refused when they hold no provider record in this organization', () => {
    const subject: TransitionSubject = {
      id: TICKET_ID,
      organization_id: ORG_A,
      status: 'assigned',
      tenant_id: TENANT_ID,
      assigned_provider_id: PROVIDER_ID,
    };
    const verdict = classifyTicketTransition(
      subject,
      'in_progress',
      membershipFor('service_provider', { providerId: null }),
    );
    expect(verdict.ok === false && verdict.kind).toBe('row_forbidden');
  });

  it('can never reach completed or cancelled from any status', () => {
    for (const status of TICKET_STATUSES) {
      for (const target of ['completed', 'cancelled'] as const) {
        if (status === target) continue;
        expect(
          classifyTicketTransition(subjectFor(status, 'service_provider'), target, provider).ok,
        ).toBe(false);
      }
    }
  });

  it('sees only the three statuses its edges touch', () => {
    expect([...PROVIDER_JOB_STATUSES]).toEqual(['assigned', 'in_progress', 'awaiting_approval']);
  });
});

describe('derived route gates match the shared table', () => {
  it('assignment is admin or manager', () => {
    expect([...TICKET_ASSIGN_ROLES]).toEqual(['organization_admin', 'property_manager']);
  });

  it('completion is admin, manager or tenant — never a provider', () => {
    expect([...TICKET_COMPLETE_ROLES]).toEqual([
      'organization_admin',
      'property_manager',
      'tenant',
    ]);
    expect(TICKET_COMPLETE_ROLES).not.toContain('service_provider');
  });
});

describe('one activity type per edge', () => {
  it('maps each destination status to exactly one type', () => {
    expect(transitionActivityType('assigned')).toBe('provider_assigned');
    expect(transitionActivityType('in_progress')).toBe('status_changed');
    expect(transitionActivityType('awaiting_approval')).toBe('status_changed');
    expect(transitionActivityType('completed')).toBe('completion_confirmed');
    expect(transitionActivityType('cancelled')).toBe('ticket_cancelled');
  });
});

describe('availableTransitions never offers an action the server would refuse', () => {
  for (const role of MEMBER_ROLES) {
    for (const status of TICKET_STATUSES) {
      it(`${role} on a ${status} ticket`, () => {
        const subject = subjectFor(status, role);
        const membership = membershipFor(role);
        for (const to of availableTransitions(subject, membership)) {
          expect(classifyTicketTransition(subject, to, membership).ok).toBe(true);
        }
      });
    }
  }

  it('offers nothing out of a terminal status', () => {
    for (const role of MEMBER_ROLES) {
      expect(availableTransitions(subjectFor('completed', role), membershipFor(role))).toEqual([]);
      expect(availableTransitions(subjectFor('cancelled', role), membershipFor(role))).toEqual([]);
    }
  });
});
