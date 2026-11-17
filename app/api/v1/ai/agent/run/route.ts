/**
 * `POST /api/v1/ai/agent/run` — the agent drafts; a human commits.
 *
 * THIS ROUTE CHANGES NOTHING A MODEL ASKED FOR. There is no ticket write here, no
 * assignment write, no priority write, and no import that could reach one. The response
 * carries `executed: false` as a schema literal (`AgentRunDataSchema`), so a test asserts
 * the property against a parser rather than against this comment. The only rows written
 * are `agent_runs` and `agent_proposals`, both of which record what was *suggested*.
 *
 * Order of operations, and why:
 *
 *   1. **Build the read scope from `ctx.membership`.** Before the model is involved at
 *      all. Every tool the agent can call is closed over this one organization id, which
 *      `lib/auth/roles.ts` derived from trusted rows — never from the body (CLAUDE.md
 *      rule 5). There is no argument on any tool through which the model could name a
 *      different organization.
 *   2. **Run the bounded loop.** The caller's message goes in fenced, as data, in the
 *      user role. Read tools execute against the scope; propose tools return proposals
 *      and execute nothing. Four independent bounds stop the loop.
 *   3. **Persist.** One `agent_runs` row, one `agent_proposals` row per proposal, each
 *      `status = 'pending'`, through the caller's own client with RLS in force.
 *   4. **Answer.** Summary, proposals, and step metadata. No tool results, no prose from
 *      inside a tool, nothing a human did not ask to see.
 *
 * `withApiHandler`, not its privileged variant: this route has no need to bypass Row
 * Level Security, and a route that does not need a service-role client must not be handed
 * one. That is also what makes the isolation claim testable — the agent reads exactly
 * what the signed-in manager could read by hand.
 *
 * Roles: `organization_admin` and `property_manager`, which is `is_org_staff()`. The
 * agent reasons about assignments and priorities, which are staff decisions, and the
 * approval RPC checks the same predicate — so the coarse gate here and the database's
 * own opinion agree rather than inviting a 403 from Postgres two steps later.
 */

import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { STAFF_ROLES } from '@shared/index';
import { toApiRouteError } from '@/services/ai';
import {
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  createAgentReadScope,
  getAgentTransport,
  persistAgentRun,
  runAgentLoop,
  type AgentLoopOutcome,
  type AgentRunRequestInput,
} from '@/services/ai/agent';
import { serverEnv } from '@/lib/env';

/**
 * Stricter than the `/api/v1/ai/*` ceiling, not looser.
 *
 * An agent run is several model calls and several queries, so it is the most expensive
 * request in the application by a wide margin. Four a minute is a manager working
 * through a morning's reports; more than that is a script.
 */
const AGENT_RATE_LIMIT = { key: 'ai:agent:run', perMinute: 4 } as const;

export const POST = withApiHandler<AgentRunRequestInput>(
  {
    roles: STAFF_ROLES,
    bodySchema: AgentRunRequestSchema,
    rateLimit: AGENT_RATE_LIMIT,
    audit: { action: 'ai_agent_run', entityType: 'agent_run' },
  },
  async (ctx) => {
    const { body, membership, supabase, logger } = ctx;
    const organizationId = membership.organization.id;

    // 1. The capability the agent gets. One organization, five queries, no mutators.
    const scope = createAgentReadScope(supabase, organizationId);

    // 2. The bounded loop. Untrusted text in, proposals out, nothing executed.
    let outcome: AgentLoopOutcome;
    try {
      outcome = await runAgentLoop(
        {
          message: body.message,
          trusted: { callerRole: membership.role },
        },
        {
          scope,
          transport: getAgentTransport(),
          model: serverEnv().AI_MODEL,
          signal: ctx.request.signal,
        },
      );
    } catch (error) {
      // Counts, durations and outcomes are logged. The message is not, and neither is
      // anything the model said (CLAUDE.md rule 8).
      logger.warn('ai agent run failed', { outcome: 'failed', organization_id: organizationId });
      throw toApiRouteError(error);
    }

    // The per-step log line. Tool name as `operation`, round as `attempt`: both are on
    // the `lib/observability/redaction.ts` allowlist, and a field name that is not on it
    // is dropped rather than written. Argument *keys* are counted, never printed — a
    // `create_ticket` argument set contains a description derived from a resident's
    // message.
    for (const step of outcome.steps) {
      logger.info('ai agent tool call', {
        operation: step.tool,
        resource_type: step.kind,
        attempt: step.round,
        outcome: step.outcome,
        duration_ms: step.durationMs,
        count: step.argumentKeys.length,
      });
    }

    // 3. Persist. Every proposal lands as `pending`; nothing here can write it otherwise.
    const persisted = await persistAgentRun(
      supabase,
      {
        organizationId,
        // `0004`'s insert policy requires this to equal `current_profile_id()`, so a
        // staff member cannot attribute a run to a colleague: Postgres rejects the row.
        actorProfileId: membership.profile.id,
        // Stored so the run is auditable. Never logged (CLAUDE.md rule 8).
        input: body.message,
        stopReason: outcome.stopReason,
      },
      outcome.proposals,
    );

    logger.info('ai agent run completed', {
      organization_id: organizationId,
      entity_id: persisted.runId ?? undefined,
      reason: `agent_stop_${outcome.stopReason}`,
      attempt: outcome.rounds,
      count: outcome.proposals.length,
      model: outcome.model,
      provider: getAgentTransport().id,
      version: outcome.promptVersion,
      tokens_in: outcome.tokensIn,
      tokens_out: outcome.tokensOut,
      latency_ms: outcome.latencyMs,
      outcome: persisted.persisted ? 'proposed' : 'proposed_unpersisted',
    });

    // Audit metadata goes through the same `lib/observability/redaction.ts` allowlist as
    // a log line, so the field *names* are chosen from it — a key that is not on the list
    // is dropped, and an audit row that silently lost half its detail is worse than one
    // that never claimed to have it. `reason` carries the stop reason, `attempt` the
    // round count, `count` the number of proposals.
    ctx.audit({
      entityId: persisted.runId,
      metadata: {
        reason: `agent_stop_${outcome.stopReason}`,
        attempt: outcome.rounds,
        count: outcome.proposals.length,
        model: outcome.model,
        version: outcome.promptVersion,
        provider: getAgentTransport().id,
        // The agent proposed; it did not act. The response says so as a schema literal.
        outcome: 'proposed',
      },
    });

    // 4. Parsed on the way out as well as on the way in. `executed: false` is a literal
    // in the schema, so this handler cannot return a body claiming otherwise.
    const payload = AgentRunResponseSchema.parse({
      data: {
        run_id: persisted.runId,
        summary: outcome.summary,
        stop_reason: outcome.stopReason,
        rounds: outcome.rounds,
        executed: false,
        persisted: persisted.persisted,
        steps: outcome.steps.map((step) => ({
          round: step.round,
          tool: step.tool,
          kind: step.kind,
          outcome: step.outcome,
          duration_ms: step.durationMs,
        })),
        proposals: persisted.proposals.map((proposal) => ({
          id: proposal.id,
          tool_name: proposal.toolName,
          arguments: proposal.arguments,
          rationale: proposal.rationale,
          status: proposal.status,
          adjustments: proposal.adjustments,
        })),
        prompt_version: outcome.promptVersion,
        model: outcome.model,
      },
    });

    return ok(payload.data, ctx.requestId);
  },
);
