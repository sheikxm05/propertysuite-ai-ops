/**
 * `features/ai-agent` — public surface. Lane w3-l5.
 *
 * Two kinds of export, and the split is deliberate:
 *
 *  - `AssistantConsole` is the whole screen, mounted by `app/(dashboard)/assistant/page.tsx`
 *    in one line. Nothing outside this directory needs to know it is four components.
 *  - `ProposalCard`, `ToolTrace` and the describe helpers are exported because lane w3-l7
 *    (Inbox) renders proposals on its own surface and should not have to re-derive "what
 *    does `create_ticket` mean in English" — or, worse, re-decide what a pending proposal
 *    looks like. One approval card, one set of words, one colour.
 *
 * What is NOT exported: `transport.ts`. The approve and reject calls are reachable only
 * from the approval card. Widening that would make it possible for some future caller to
 * approve a proposal from a surface that never showed a human what they were approving,
 * which is the failure mode this whole lane exists to prevent.
 */

export { AssistantConsole, type AssistantConsoleProps } from './components/assistant-console';
export { ProposalCard, type ProposalCardProps } from './components/proposal-card';
export { ToolTrace, type ToolTraceProps } from './components/tool-trace';
export { Disclosure, RawJson } from './components/disclosure';

export {
  describeAdjustment,
  describeProposal,
  describeStep,
  unsnake,
  type ActionDescription,
  type ActionFact,
} from './describe';

export {
  AGENT_DECISION_STYLE,
  PROPOSAL_DECISIONS,
  STEP_OUTCOME_TEXT,
  STOP_REASON_TEXT,
  isFailure,
  isRefusal,
  type AgentProposal,
  type AgentRunData,
  type AgentStep,
  type AgentStepOutcome,
  type AgentStopReason,
  type ProposalDecision,
} from './wire';
