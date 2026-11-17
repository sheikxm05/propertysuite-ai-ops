/**
 * `POST /api/v1/ai/agent/proposals/{proposalId}/approve` — the human confirmation.
 *
 * This is the gate CLAUDE.md rule 7 is about, so it is worth being explicit about what
 * makes it one rather than a formality.
 *
 *  - **It cannot be reached by model output.** Nothing in `services/ai/agent/**` calls
 *    it. The loop has no HTTP client, the tools have no network access, and the propose
 *    tools are handed an organization id and a clock. It is an endpoint invoked by an
 *    authenticated browser session, with a proposal id the human was shown.
 *
 *  - **The decision is Postgres's, not this file's.** `approve_agent_proposal(p_id)` runs
 *    `security definer` and checks `is_org_staff()` against the proposal's own
 *    organization. There is deliberately no client `UPDATE` path that can set
 *    `status = 'approved'`, so a caller who is not staff in that organization is refused
 *    by the database even if the role gate above were wrong. The coarse `roles` gate here
 *    is the same predicate, declared so the 403 arrives early and for the right reason.
 *
 *  - **Approval is not execution, and the response says so.** `executed: false` is a Zod
 *    literal in `AgentApprovalDataSchema`. Approving records that a human agreed with a
 *    proposal. Carrying it out is a separate, deliberate step that must re-derive every
 *    security-relevant value under that human's own credentials — exactly as
 *    `app/api/v1/ai/maintenance/confirm` re-derives the unit, the property and the
 *    priority rather than trusting the draft it was handed. An approved row is a record
 *    of intent; it is never an authorisation token.
 *
 * The proposal id is validated as a UUID before it reaches the RPC, and nothing else from
 * the request is used at all — in particular there is no organization in the path or the
 * body, because the proposal's organization is a property of the row (CLAUDE.md rule 5).
 */

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { STAFF_ROLES } from '@shared/index';
import {
  AgentApprovalResponseSchema,
  AgentProposalIdSchema,
  approveAgentProposal,
} from '@/services/ai/agent';

/** A human clicking approve. Bounded so a stolen session cannot sweep a queue. */
const APPROVE_RATE_LIMIT = { key: 'ai:agent:approve', perMinute: 10 } as const;

export const POST = withApiHandler(
  {
    roles: STAFF_ROLES,
    rateLimit: APPROVE_RATE_LIMIT,
    audit: { action: 'ai_agent_proposal_approved', entityType: 'agent_proposal' },
  },
  async (ctx) => {
    const parsed = AgentProposalIdSchema.safeParse(ctx.params);
    if (!parsed.success) {
      throw new ApiRouteError('VALIDATION_ERROR', {
        logFields: { reason: 'agent_proposal_id_invalid' },
      });
    }
    const proposalId = parsed.data.proposalId;

    // The RPC is the authorisation. A proposal in another organization, or one already
    // decided, is refused there — this handler does not second-guess it and does not
    // read the row first, because reading it to produce a nicer error would be a
    // disclosure of whether it exists.
    await approveAgentProposal(ctx.supabase, proposalId);

    // Field names chosen from the `lib/observability/redaction.ts` allowlist, which is
    // applied to audit metadata as well as to log lines; an unlisted key is dropped.
    // `decision_recorded` rather than `executed`: approving is not carrying out.
    ctx.audit({
      entityId: proposalId,
      metadata: { status: 'approved', outcome: 'decision_recorded' },
    });

    ctx.logger.info('ai agent proposal approved', {
      organization_id: ctx.membership.organization.id,
      entity_id: proposalId,
      profile_id: ctx.membership.profile.id,
      outcome: 'approved',
    });

    const payload = AgentApprovalResponseSchema.parse({
      data: { proposal_id: proposalId, status: 'approved', executed: false },
    });

    return ok(payload.data, ctx.requestId);
  },
);
