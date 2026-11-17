/**
 * `services/ai/agent` — the multi-step agent. Lane w3-l4.
 *
 * THE ONE SENTENCE THAT MATTERS
 * Read tools execute; propose tools cannot. Nothing exported from this directory can be
 * talked into changing a row: a read tool's only capability is `AgentReadScope`, which
 * has five queries and no mutator, and a propose tool is handed an organization id and a
 * clock and nothing else. The only writes in the subsystem are the run and proposal
 * records, performed by the orchestrator after the model has finished, and
 * `approve_agent_proposal`, which is reachable only from a route with an authenticated
 * human session and is authorised by Postgres through `is_org_staff()`.
 *
 * Reading order for a reviewer with five minutes:
 *   types.ts            — the two tool kinds, and what each is given to work with
 *   tools/propose-tools.ts — the three tools that would change state, and cannot
 *   loop.ts             — the dispatch (a two-case switch) and the four bounds
 *   persistence.ts      — the only three statements in the subsystem
 *
 * Importing this barrel pulls in the transport, which reads validated configuration. A
 * module that wants only the tool contracts should deep-import `./types`.
 */

export { runAgentLoop } from './loop';
export {
  MAX_PROPOSALS_PER_RUN,
  MAX_TOOL_CALLS_PER_ROUND,
  MAX_TOOL_CALLS_PER_RUN,
  MAX_TOOL_ROUNDS,
  WALL_CLOCK_BUDGET_MS,
} from './loop';
export type { AgentLoopDeps, AgentLoopInput, AgentLoopOutcome } from './loop';

export { createAgentReadScope } from './read-scope';

export {
  AGENT_TOOLS,
  AGENT_TOOL_NAMES,
  PROPOSE_TOOL_NAMES,
  READ_TOOL_NAMES,
  findTool,
} from './tools/registry';
export type { ErasedProposeTool, ErasedReadTool, ErasedTool } from './tools/registry';

export {
  AGENT_MAX_OUTPUT_TOKENS,
  AGENT_PROMPT_VERSION,
  AGENT_SYSTEM,
  AGENT_USER_PREAMBLE,
  agentPromptFingerprint,
} from './prompt';

export {
  clearDocumentSearch,
  isDocumentSearchAvailable,
  registerDocumentSearch,
} from './document-search';
export type {
  DocumentSearchFn,
  DocumentSearchHit,
  DocumentSearchQuery,
  DocumentSearchResult,
} from './document-search';

export {
  getAgentTransport,
  hasAgentModelCredential,
  registerAgentTransportOverride,
  resetAgentTransport,
} from './model';
export type {
  AgentChatMessage,
  ModelToolCall,
  ModelToolSpec,
  ToolCallingReply,
  ToolCallingRequest,
  ToolCallingTransport,
} from './model';

export { approveAgentProposal, persistAgentRun, rejectAgentProposal } from './persistence';
export type { AgentRunRecord, PersistedRun } from './persistence';

export {
  AgentApprovalDataSchema,
  AgentApprovalResponseSchema,
  AgentDecisionDataSchema,
  AgentDecisionResponseSchema,
  AgentProposalIdSchema,
  AgentProposalSchema,
  AgentRejectionDataSchema,
  AgentRejectionResponseSchema,
  AgentRunDataSchema,
  AgentRunRequestSchema,
  AgentRunResponseSchema,
  AgentStepSchema,
} from './schemas';
export type { AgentDecisionData, AgentRunData, AgentRunRequestInput } from './schemas';

export type {
  AgentReadScope,
  AgentStep,
  AgentStepOutcome,
  AgentStopReason,
  PersistedProposal,
  ProposalContext,
  ProposalDraft,
  ProposeToolDefinition,
  ReadToolDefinition,
  ToolKind,
  ToolResult,
} from './types';
