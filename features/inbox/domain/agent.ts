/**
 * The inbox's view of `POST /api/v1/ai/agent/run` (lane w3-l4).
 *
 * The contract is not guessed at: `AgentRunResponseSchema` in
 * `services/ai/agent/schemas.ts` is the frozen shape, `services/**` is readable from
 * this lane, and parsing the upstream body against its own schema is the only way to be
 * sure the two sides agree. A hand-written shape here would be a second opinion about a
 * contract that already has one.
 *
 * What arrives, and what the screen is allowed to conclude from it:
 *
 *   `summary`    the assistant's closing sentence, or null when a bound stopped the run
 *   `steps`      **metadata only** — a tool name, whether it read or proposed, how it
 *                ended and how long it took. Deliberately NOT the tool's result: a read
 *                tool returns rows from the caller's own organization and putting them
 *                back on the wire would widen a projection that RLS had already narrowed
 *                correctly. The inspectable step is the *fact of the call*, which is what
 *                a reviewer is actually auditing.
 *   `proposals`  consequential actions the agent wants taken and cannot take. `status`
 *                is the literal `'pending'` — the run endpoint cannot produce a decided
 *                proposal, because deciding is a different endpoint and a different act.
 *   `executed`   the literal `false`. Always.
 *
 * A proposal with a null `id` could not be stored, and approval takes a row id, so it is
 * unapprovable. It is still rendered — a reviewer should see what was asked for — with
 * the reason it has no buttons.
 */

import { AgentRunResponseSchema, type AgentRunData } from '@/services/ai/agent/schemas';

/** Frozen by §5.5 and the Wave 3 interface note. */
export const AGENT_RUN_PATH = '/api/v1/ai/agent/run';

export type AgentRun = AgentRunData;
export type AgentStep = AgentRunData['steps'][number];
export type AgentProposal = AgentRunData['proposals'][number];

/**
 * Parses the agent's reply, or reports that it could not be parsed.
 *
 * `null` rather than a throw. A contract mismatch between two lanes is not the operator's
 * fault and is not a 500 to them: the screen says the agent answered in a shape it does
 * not recognise, says nothing was changed, and leaves the classification path — which is
 * what the demo actually depends on — untouched.
 */
export function parseAgentRun(payload: unknown): AgentRun | null {
  const parsed = AgentRunResponseSchema.safeParse(payload);
  return parsed.success ? parsed.data.data : null;
}

/** Whether a step only read. Everything else wanted a human. */
export function isReadStep(step: AgentStep): boolean {
  return step.kind === 'read';
}

/**
 * How a step ended, in a reviewer's words.
 *
 * `proposed` is the interesting one: it is not a failure, it is the agent hitting the
 * boundary and stopping, which is the behaviour the whole design is for.
 */
export const STEP_OUTCOME_LABEL: Readonly<Record<AgentStep['outcome'], string>> = Object.freeze({
  ok: 'Read successfully',
  proposed: 'Stopped and proposed — a human must decide',
  unknown_tool: 'Asked for a tool that does not exist',
  invalid_arguments: 'Arguments rejected by the tool schema',
  unavailable: 'Tool unavailable',
  unverified_reference: 'Referred to something it had not read',
  proposal_limit: 'Proposal limit reached',
  failed: 'Failed',
});

/** Why the run stopped, in a reviewer's words. */
export const STOP_REASON_LABEL: Readonly<Record<AgentRunData['stop_reason'], string>> =
  Object.freeze({
    completed: 'Finished on its own',
    max_rounds: 'Stopped at the round limit',
    max_tool_calls: 'Stopped at the tool-call limit',
    deadline: 'Stopped at the deadline',
    model_silent: 'The model returned nothing',
  });
