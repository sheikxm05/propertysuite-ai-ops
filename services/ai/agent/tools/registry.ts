/**
 * The tool registry — one list, and the permission classification that goes with it.
 *
 * Two jobs:
 *
 *  1. **Classify.** Every tool is `read` or `propose`, and the registry is the only place
 *     that knows which. `loop.ts` dispatches on {@link ErasedTool.kind} and has two
 *     branches: run it, or record a proposal. There is no third branch and no default
 *     case that could acquire one, because {@link ToolKind} has two members.
 *
 *  2. **Erase the argument type.** A registry is a heterogeneous list — `lookup_unit`
 *     takes a unit number, `create_ticket` takes six fields — so the per-tool argument
 *     type cannot survive into the list. The usual answer is `any` and a cast at the call
 *     site. The answer here is to close over each definition in a function that parses
 *     with that definition's own Zod schema and then calls that definition's own
 *     function. The argument type never leaves the closure, so the list is fully typed
 *     and there is not one cast in this file.
 *
 * `invoke` and `build` throw `ZodError` on invalid arguments. `loop.ts` catches it and
 * tells the model its arguments were rejected, which is a conversation the model can
 * recover from within the loop's bounds — and, importantly, is not a 500 for the human.
 */

import { z } from 'zod';

import type {
  AgentReadScope,
  JsonSchemaObject,
  ProposalContext,
  ProposalDraft,
  ProposeToolDefinition,
  ReadToolDefinition,
  ToolKind,
  ToolResult,
} from '../types';
import {
  listProvidersTool,
  lookupTenancyTool,
  lookupUnitTool,
  recentTicketsTool,
  searchDocumentsTool,
} from './read-tools';
import { assignProviderTool, createTicketTool, setPriorityTool } from './propose-tools';

/** What every registry entry exposes, whatever its arguments look like. */
interface ErasedToolBase {
  readonly name: string;
  readonly kind: ToolKind;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}

/** A tool that runs. Its only capability is the read scope it is handed. */
export interface ErasedReadTool extends ErasedToolBase {
  readonly kind: 'read';
  /** Validates, then executes. Throws `ZodError` when the model's arguments are wrong. */
  invoke(scope: AgentReadScope, raw: unknown): Promise<ToolResult>;
}

/** A tool that cannot run. It returns a description of an action, for a human. */
export interface ErasedProposeTool extends ErasedToolBase {
  readonly kind: 'propose';
  /** Argument names whose values must have been disclosed by a read tool this run. */
  readonly referenceArgs: readonly string[];
  /**
   * Validates, then builds the proposal. Throws `ZodError`. **Executes nothing** — the
   * {@link ProposalContext} it is given has no database handle of any kind.
   */
  build(context: ProposalContext, raw: unknown): ProposalDraft;
}

export type ErasedTool = ErasedReadTool | ErasedProposeTool;

/** Closes over a read definition. The argument type stays inside this function. */
function eraseRead<A>(definition: ReadToolDefinition<A>): ErasedReadTool {
  return {
    name: definition.name,
    kind: 'read',
    description: definition.description,
    parameters: definition.parameters,
    invoke: (scope, raw) => definition.execute(scope, definition.args.parse(raw)),
  };
}

/** Closes over a propose definition. Same trick; note there is no `invoke` to give it. */
function erasePropose<A>(definition: ProposeToolDefinition<A>): ErasedProposeTool {
  return {
    name: definition.name,
    kind: 'propose',
    description: definition.description,
    parameters: definition.parameters,
    referenceArgs: definition.referenceArgs,
    build: (context, raw) => definition.propose(context, definition.args.parse(raw)),
  };
}

/**
 * Every tool the agent has, read tools first.
 *
 * Order matters only as a hint: a model reading the list top-down is nudged towards
 * gathering context before proposing anything. It is not an enforcement mechanism —
 * the enforcement is that the bottom three cannot do anything.
 */
export const AGENT_TOOLS: readonly ErasedTool[] = Object.freeze([
  eraseRead(lookupUnitTool),
  eraseRead(lookupTenancyTool),
  eraseRead(recentTicketsTool),
  eraseRead(listProvidersTool),
  eraseRead(searchDocumentsTool),
  erasePropose(createTicketTool),
  erasePropose(assignProviderTool),
  erasePropose(setPriorityTool),
]);

const BY_NAME: ReadonlyMap<string, ErasedTool> = new Map(
  AGENT_TOOLS.map((tool) => [tool.name, tool]),
);

/**
 * Looks a tool up by the name the model used.
 *
 * Returns `undefined` for anything unknown. The model is told the tool does not exist and
 * may try again; it is not an error for the request, because a model inventing a tool
 * name is a thing models do and is not a failure of the system.
 */
export function findTool(name: string): ErasedTool | undefined {
  return BY_NAME.get(name);
}

/** The names, for the system prompt and for logs. */
export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOLS.map((tool) => tool.name);

/** The propose-tool names, so the prompt can state exactly which ones cannot execute. */
export const PROPOSE_TOOL_NAMES: readonly string[] = AGENT_TOOLS.filter(
  (tool) => tool.kind === 'propose',
).map((tool) => tool.name);

/** The read-tool names, for the same reason. */
export const READ_TOOL_NAMES: readonly string[] = AGENT_TOOLS.filter(
  (tool) => tool.kind === 'read',
).map((tool) => tool.name);

/** Distinguishes a rejected-arguments failure from a genuine tool fault. */
export function isArgumentRejection(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}

/**
 * A short, safe description of why arguments were rejected.
 *
 * Paths and Zod's own messages only — never the submitted values, which for
 * `create_ticket` include a description derived from a tenant's message. The model gets
 * enough to correct itself; the log gets nothing it should not have.
 */
export function describeArgumentRejection(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
