/**
 * `POST /api/v1/ai/agent/proposals/{proposalId}/reject` — the other half of the gate.
 *
 * A gate that can only be opened is not a gate. Migration `0004` revokes `UPDATE` on
 * `agent_proposals` from `authenticated` and declares no UPDATE policy, so without this
 * endpoint a manager who disagrees with a proposal has no way to say so and the review
 * queue only ever grows. `reject_agent_proposal(p_id)` is the matching `security definer`
 * RPC, with the same `is_org_staff()` check and the same refusal for a proposal that has
 * already been decided.
 *
 * Rejecting is as much a human decision as approving, and it is recorded as one: the RPC
 * writes `decided_by` and `decided_at`, and `0004`'s check constraint refuses to hold a
 * decided row that names no decider. The response carries `executed: false` as a Zod
 * literal, because nothing was carried out here either.
 *
 * As with approve, the row is not read first. Reading it to produce a friendlier error
 * would disclose whether a proposal exists in another organization; the RPC raises the
 * identical error for "no such proposal" and "not yours", deliberately.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { STAFF_ROLES } from '@shared/index';
import {
  AgentProposalIdSchema,
  AgentRejectionResponseSchema,
  rejectAgentProposal,
} from '@/services/ai/agent';

/** A human pressing reject. Same bound as approve. */
const REJECT_RATE_LIMIT = { key: 'ai:agent:reject', perMinute: 10 } as const;

export const POST = withApiHandler(
  {
    roles: STAFF_ROLES,
    rateLimit: REJECT_RATE_LIMIT,
    audit: { action: 'ai_agent_proposal_rejected', entityType: 'agent_proposal' },
  },
  async (ctx) => {
    const parsed = AgentProposalIdSchema.safeParse(ctx.params);
    if (!parsed.success) {
      throw new ApiRouteError('VALIDATION_ERROR', {
        logFields: { reason: 'agent_proposal_id_invalid' },
      });
    }
    const proposalId = parsed.data.proposalId;

    await rejectAgentProposal(ctx.supabase, proposalId);

    // Field names from the `lib/observability/redaction.ts` allowlist, which applies to
    // audit metadata as well as to log lines.
    ctx.audit({
      entityId: proposalId,
      metadata: { status: 'rejected', outcome: 'decision_recorded' },
    });

    ctx.logger.info('ai agent proposal rejected', {
      organization_id: ctx.membership.organization.id,
      entity_id: proposalId,
      profile_id: ctx.membership.profile.id,
      outcome: 'rejected',
    });

    const payload = AgentRejectionResponseSchema.parse({
      data: { proposal_id: proposalId, status: 'rejected', executed: false },
    });

    return ok(payload.data, ctx.requestId);
  },
);
