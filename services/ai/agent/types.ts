/**
 * The agent's type vocabulary — and, in one file, the reason this agent cannot act.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRAL RULE, EXPRESSED AS TYPES
 * ---------------------------------------------------------------------------
 * CLAUDE.md rule 7: no model output may cause a state change without an authenticated
 * human confirmation. Most systems honour that with a code review and a comment. Here it
 * is honoured by what the types make *expressible*:
 *
 *   - A tool is either `kind: 'read'` or `kind: 'propose'`. The two are a discriminated
 *     union, not a flag on one shape, so there is no object that is both.
 *
 *   - A `read` tool's executor receives an {@link AgentReadScope}. That interface has
 *     five methods, all of them queries. It has no `insert`, no `update`, no `upsert`,
 *     no `delete` and no `rpc`, and it does not expose the underlying Supabase client,
 *     so a read tool cannot reach one. Registering a mutating function as a read tool is
 *     not "discouraged" — there is no argument it could call to mutate anything.
 *
 *   - A `propose` tool's function receives a {@link ProposalContext}: an organization id
 *     and a clock. No database handle of any kind. It returns a {@link ProposalDraft},
 *     which is a *description* of an action. Nothing in `services/ai/agent/**` consumes
 *     a `ProposalDraft` by executing it; `persistence.ts` writes it to
 *     `public.agent_proposals` with `status = 'pending'`, and that is the end of the
 *     machine's involvement.
 *
 * So the strongest statement available is a structural one: **no function reachable from
 * a model tool call in this directory holds a handle capable of writing a row.** The
 * only writes are the run and proposal records, performed by the orchestrator, and the
 * `approve_agent_proposal` RPC, invoked by a route with a human session behind it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS TRUSTED AND WHAT IS NOT
 * ---------------------------------------------------------------------------
 * `ToolResult.data` is built by this application from database rows: ids, enums, dates,
 * counts, booleans. It is safe to place in a model turn unfenced because it cannot carry
 * an instruction.
 *
 * `ToolResult.untrusted` is for anything a human outside the application wrote — a
 * ticket title typed by a tenant, an excerpt from an uploaded PDF. It is fenced by
 * `services/ai/fence.ts`, the same fence the classification path uses, before it reaches
 * the model. A tool that returns free text and forgets to declare it untrusted is the
 * one mistake this type is shaped to make visible in review.
 */

import type { z } from 'zod';

import type {
  Json,
  MaintenanceTicketRow,
  PropertyUnitRow,
  ServiceProviderRow,
  TenancyRow,
} from '@shared/index';

import type { UntrustedSection } from '../fence';

/* ------------------------------------------------------------- permissions -- */

/**
 * The permission classification. Exactly two values, deliberately.
 *
 * `read`    executes immediately, against the caller's own row visibility.
 * `propose` never executes. It returns a proposal for a human to approve or reject.
 *
 * There is no third kind, and in particular no `write`. Adding one would mean adding a
 * code path on which a model could change state, which is the one thing this subsystem
 * exists to make impossible.
 */
export type ToolKind = 'read' | 'propose';

/* -------------------------------------------------------------- read scope -- */

/** A unit, as the agent is allowed to see it. Projected from the row, never copied. */
export type UnitSummary = Pick<
  PropertyUnitRow,
  'id' | 'property_id' | 'unit_number' | 'status' | 'bedrooms' | 'bathrooms'
>;

/**
 * A tenancy, as the agent is allowed to see it.
 *
 * Note what is absent: `tenant_id`, and any name, email, phone or rent figure. The agent
 * needs to know *that* a unit is occupied and under what dates, in order to reason about
 * urgency. It does not need to know who lives there, and the model is the last place a
 * tenant's personal data should be sent. This is the same discipline
 * `services/ai/providers/types.ts` applies to `TrustedContext`.
 */
export type TenancySummary = Pick<TenancyRow, 'id' | 'start_date' | 'end_date' | 'status'>;

/**
 * A ticket, as the agent is allowed to see it.
 *
 * `title` is deliberately NOT in this projection: it is tenant-authored free text and so
 * it travels separately, as an {@link UntrustedSection}, to be fenced. Structured fields
 * here, hostile text there.
 */
export type TicketSummary = Pick<
  MaintenanceTicketRow,
  'id' | 'category' | 'priority' | 'status' | 'created_at' | 'assigned_provider_id'
>;

/** A service provider, as the agent is allowed to see it. */
export type ProviderSummary = Pick<
  ServiceProviderRow,
  'id' | 'company_name' | 'service_categories' | 'status'
>;

/**
 * Everything a read tool can do.
 *
 * Five queries, every one of them pinned to the caller's organization by the
 * implementation and executed through the caller-scoped Supabase client with Row Level
 * Security in force. Two independent layers therefore have to fail before an agent could
 * read another organization's row: this pin, and the policy matrix in migration `0002`.
 *
 * The interface is the capability. A read tool is handed one of these and nothing else,
 * so the set of effects a read tool can have is the set of methods below.
 */
export interface AgentReadScope {
  /** The organization every query is pinned to. Derived from membership, never a body. */
  readonly organizationId: string;
  /** Units whose number matches exactly. A number is not unique across properties. */
  findUnitsByNumber(unitNumber: string, limit: number): Promise<readonly UnitSummary[]>;
  /** One unit by id, or `null` when the caller cannot see it. Absence, not denial. */
  findUnitById(unitId: string): Promise<UnitSummary | null>;
  /** The active tenancy on a unit, or `null`. */
  activeTenancyForUnit(unitId: string): Promise<TenancySummary | null>;
  /** Recent tickets on a unit, newest first, with their tenant-authored titles. */
  recentTicketsForUnit(
    unitId: string,
    limit: number,
  ): Promise<readonly { readonly ticket: TicketSummary; readonly title: string }[]>;
  /** Active providers, optionally filtered to one service category. */
  activeProviders(category: string | null, limit: number): Promise<readonly ProviderSummary[]>;
}

/* ------------------------------------------------------------ tool results -- */

/**
 * What a tool hands back to the loop.
 *
 * Split in two on purpose — see the module header. `data` is application-built structure;
 * `untrusted` is anything a human outside the application wrote, and is fenced before it
 * is placed in a model turn.
 */
export interface ToolResult {
  /** Structured facts. Ids, enums, dates, counts, booleans. Never free text. */
  readonly data: Json;
  /** Free text of external origin. Fenced by `services/ai/fence.ts` before sending. */
  readonly untrusted?: readonly UntrustedSection[];
}

/* -------------------------------------------------------------- JSON schema -- */

/**
 * The parameter schema advertised to the model.
 *
 * Hand-written rather than derived from Zod, because no schema-to-JSON-Schema package is
 * in the frozen dependency list (CLAUDE.md rule 3) and inventing a converter for eight
 * tools would be more code than the eight schemas. The Zod schema beside it is the
 * authority: this object only shapes what the model *attempts*, and
 * {@link ToolDefinition.args} decides what is accepted.
 */
export interface JsonSchemaObject {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Json>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/* ------------------------------------------------------------- definitions -- */

interface ToolDefinitionBase<A> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
  /**
   * The authority on what the model may pass. A tool call whose arguments fail this is
   * never executed and never proposed; the model is told so and may try again, within
   * the loop's bounds.
   */
  readonly args: z.ZodType<A, z.ZodTypeDef, unknown>;
}

/** A tool that runs. Its only capability is {@link AgentReadScope}. */
export interface ReadToolDefinition<A = unknown> extends ToolDefinitionBase<A> {
  readonly kind: 'read';
  execute(scope: AgentReadScope, args: A): Promise<ToolResult>;
}

/**
 * Everything a propose tool is given.
 *
 * An organization id and a clock. No Supabase client, no read scope, no network, no
 * callback. A `propose` function is pure in the only sense that matters here: it has
 * nothing to call.
 */
export interface ProposalContext {
  readonly organizationId: string;
  readonly now: Date;
}

/** A tool that cannot run. It describes an action for a human to decide on. */
export interface ProposeToolDefinition<A = unknown> extends ToolDefinitionBase<A> {
  readonly kind: 'propose';
  /**
   * Builds the proposal. Executes nothing — see {@link ProposalContext}, which gives it
   * nothing to execute with.
   */
  propose(context: ProposalContext, args: A): ProposalDraft;
  /**
   * Argument names carrying an identifier that must have been disclosed by a read tool
   * earlier in the same run.
   *
   * The loop refuses a proposal naming an id it never showed the model (`loop.ts`,
   * `assertReferencesDisclosed`). Nothing could have executed either way, but a proposal
   * that quotes an invented unit id is a proposal a human might approve by mistake, and
   * a hallucinated identifier is the cheapest injection payload there is.
   */
  readonly referenceArgs: readonly string[];
}

/** Either kind. A `switch` on `.kind` is exhaustive. */
export type ToolDefinition<A = never> = ReadToolDefinition<A> | ProposeToolDefinition<A>;

/* --------------------------------------------------------------- proposals -- */

/**
 * A proposed action. **Not an action.**
 *
 * `toolName` and `arguments` are the frozen `public.agent_proposals` columns, so what a
 * human approves is exactly what the model asked for, verbatim, rather than a rendering
 * of it. `rationale` is the model's own words and is shown to the human; like every other
 * model output it is stored and displayed, never logged (CLAUDE.md rule 8).
 */
export interface ProposalDraft {
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, Json>>;
  readonly rationale: string;
  /**
   * Set when the application overrode something the model asked for — today, a
   * `suggested priority` of `urgent`, clamped to `high` exactly as `resolvePriority()`
   * clamps it on the classification path. Surfaced so a reviewer can see the override
   * happened rather than discovering it by diffing.
   */
  readonly adjustments: readonly string[];
}

/** A persisted proposal, as returned to the caller and to the approval UI. */
export interface PersistedProposal extends ProposalDraft {
  /** `agent_proposals.id`, or `null` when the row could not be written. */
  readonly id: string | null;
  readonly status: 'pending';
}

/* ------------------------------------------------------------------- steps -- */

/**
 * What happened on one tool call. Safe to log in full.
 *
 * Note `argumentKeys` and `argumentBytes` rather than the arguments themselves: the
 * brief is "arguments metadata", and a `create_ticket` argument set contains a
 * description derived from a tenant's message.
 */
export interface AgentStep {
  readonly round: number;
  readonly tool: string;
  readonly kind: ToolKind | 'unknown';
  readonly outcome: AgentStepOutcome;
  readonly durationMs: number;
  readonly argumentKeys: readonly string[];
  readonly argumentBytes: number;
}

export type AgentStepOutcome =
  /** A read tool ran and returned data. */
  | 'ok'
  /** A propose tool produced a proposal. Nothing was executed. */
  | 'proposed'
  /** The model named a tool that does not exist. */
  | 'unknown_tool'
  /** The arguments failed the Zod schema. Nothing ran. */
  | 'invalid_arguments'
  /** The tool exists but its backing capability is not deployed yet. */
  | 'unavailable'
  /** A proposal quoted an identifier no read tool had disclosed. Refused. */
  | 'unverified_reference'
  /** The run's proposal ceiling was reached. Refused. */
  | 'proposal_limit'
  /** The read tool threw. */
  | 'failed';

/** Why the loop stopped. Every value except `completed` is a bound doing its job. */
export type AgentStopReason =
  /** The model answered without asking for another tool. The normal path. */
  | 'completed'
  | 'max_rounds'
  | 'max_tool_calls'
  | 'deadline'
  /** The model returned neither text nor a tool call. */
  | 'model_silent';
