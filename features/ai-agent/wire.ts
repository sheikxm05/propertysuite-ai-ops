/**
 * The contract this UI parses — imported, not restated.
 *
 * `services/ai/agent/schemas.ts` (lane w3-l4) is the single definition of what
 * `/api/v1/ai/agent/*` sends and receives, and it is deliberately pure: it imports `zod`
 * and `@shared/index` and nothing else, no `server-only` module, no Supabase client, no
 * environment. So this lane imports it directly rather than writing a parallel set of
 * schemas that would drift the first time a field was added. CLAUDE.md rule 4 again: one
 * definition, in the lane that owns it.
 *
 * WHAT THIS FILE ADDS, AND WHY EACH ADDITION IS NOT A SECOND CONTRACT
 * -------------------------------------------------------------------
 * 1. `ProposalDecision` and `AGENT_DECISION_STYLE` — the *rendering* of a decision. The
 *    server never returns a decided proposal: `AgentProposalSchema.status` is
 *    `z.literal('pending')`, because the run endpoint can only ever produce a pending
 *    one. The decided states live in Postgres (`agent_proposals.status` admits
 *    `pending | approved | rejected | executed`) and arrive at the browser only as the
 *    approval endpoint's confirmation. Tracking them is this lane's job.
 *
 * 2. `AgentDecisionResponseSchema` — the approval endpoint's reply, re-exported under a
 *    name the components use.
 *
 * Note the one word that is absent from every type here: *executed*. Approving records
 * that a human agreed. Carrying the action out is a separate step that re-derives its
 * facts under the human's own credentials, and the approval response says so with
 * `executed: false` as a literal. The UI must not imply otherwise, so it never shows a
 * created record it has not been given.
 */

import {
  AgentApprovalResponseSchema,
  AgentProposalSchema,
  AgentRunDataSchema,
  AgentRunResponseSchema,
  AgentStepSchema,
} from '@/services/ai/agent/schemas';
import type { StatusStyle } from '@/components/ui/status';
import type { z } from 'zod';

export {
  AgentProposalSchema,
  AgentRunDataSchema,
  AgentRunResponseSchema,
  AgentStepSchema,
  AgentApprovalResponseSchema as AgentDecisionResponseSchema,
};

export type AgentRunData = z.infer<typeof AgentRunDataSchema>;
export type AgentProposal = z.infer<typeof AgentProposalSchema>;
export type AgentStep = z.infer<typeof AgentStepSchema>;
export type AgentStopReason = AgentRunData['stop_reason'];
export type AgentStepOutcome = AgentStep['outcome'];

/* -------------------------------------------------------------------------- */
/* The decision, which is the part a human owns                               */
/* -------------------------------------------------------------------------- */

/**
 * Where a proposal stands with a human.
 *
 * Mirrors the four values `agent_proposals.status` admits in
 * `supabase/migrations/0004_agentic.sql`. `executed` is included for completeness and is
 * not reachable from a browser at all — the migration revokes UPDATE on the table and
 * notes that only a trusted server component holding the service role may write it,
 * because "giving a browser session a way to write `executed` would let the audit trail
 * claim an action that never happened".
 */
export const PROPOSAL_DECISIONS = ['pending', 'approved', 'rejected', 'executed'] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

/**
 * Decision to badge, following the rule `components/ui/status.ts` encodes:
 * **`warning` means a human decision is outstanding — nobody has committed to this yet.**
 *
 * A pending proposal is the purest instance of that rule in the product, so it wears the
 * same amber a tenant sees on an unverified document and a manager sees on a ticket
 * awaiting approval. Approved is `success` without being green-lit-and-done, which is
 * why its label says what actually happened rather than "Created".
 */
export const AGENT_DECISION_STYLE: Readonly<Record<ProposalDecision, StatusStyle>> = Object.freeze({
  pending: { label: 'Awaiting a human decision', variant: 'warning' },
  approved: { label: 'Approved by a human', variant: 'success' },
  rejected: { label: 'Rejected by a human', variant: 'destructive' },
  executed: { label: 'Carried out', variant: 'success' },
});

/**
 * Why the loop stopped, in the reader's terms.
 *
 * Only `completed` means the assistant finished its own thought. The other four are
 * bounds — the run was cut off — and saying so matters, because a truncated run may have
 * left a question half-answered and the reader should not mistake brevity for a verdict.
 */
export const STOP_REASON_TEXT: Readonly<Record<AgentStopReason, string>> = Object.freeze({
  completed: 'The assistant finished.',
  max_rounds: 'Stopped at the round limit before finishing. Ask a narrower question.',
  max_tool_calls: 'Stopped at the lookup limit before finishing. Ask a narrower question.',
  deadline: 'Stopped at the time limit before finishing.',
  model_silent: 'The model returned nothing. Nothing was read and nothing was proposed.',
});

/** Per-step outcomes, in the reader's terms. `ok` and `proposed` are the normal two. */
export const STEP_OUTCOME_TEXT: Readonly<Record<AgentStepOutcome, string>> = Object.freeze({
  ok: 'Read',
  proposed: 'Proposed, not run',
  unknown_tool: 'Refused — no such tool',
  invalid_arguments: 'Refused — arguments failed validation',
  unavailable: 'Unavailable',
  unverified_reference: 'Refused — referred to a record it had not read',
  proposal_limit: 'Refused — too many proposals in one run',
  failed: 'Failed',
});

/**
 * Which outcomes are the system *refusing* the model rather than serving it.
 *
 * Worth distinguishing on screen: a refusal is the guard rails working, not an error the
 * reader should worry about, and `unverified_reference` in particular is the agent being
 * stopped from acting on a record it never looked at.
 */
export function isRefusal(outcome: AgentStepOutcome): boolean {
  return (
    outcome === 'unknown_tool' ||
    outcome === 'invalid_arguments' ||
    outcome === 'unverified_reference' ||
    outcome === 'proposal_limit'
  );
}

export function isFailure(outcome: AgentStepOutcome): boolean {
  return outcome === 'failed' || outcome === 'unavailable';
}
