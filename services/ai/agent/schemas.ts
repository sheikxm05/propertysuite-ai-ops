/**
 * The request and response contracts for `/api/v1/ai/agent/*`.
 *
 * The response is parsed on the way out as well as the way in, like every other route in
 * this application, and it carries one literal that is the whole point of the feature:
 *
 *     executed: z.literal(false)
 *
 * The run endpoint cannot return a body claiming anything was done, because the schema it
 * is validated against will not permit the word. That is the same device
 * `ClassifyResponseSchema` uses with `created: false`, and it exists so the property is
 * asserted by a parser rather than by a comment.
 *
 * `message` reuses `AiMessageContentSchema` from `packages/shared`. A second bound for
 * the same thing would be a local copy of a shared schema (CLAUDE.md rule 4) and the two
 * would eventually disagree about what 4000 characters means.
 */

import { z } from 'zod';

import {
  AiMessageContentSchema,
  JsonValueSchema,
  UuidSchema,
  resourceResponseSchema,
} from '@shared/index';

/**
 * What a caller may send.
 *
 * One field. There is deliberately no `organization_id`, no `property_unit_id` and no
 * conversation history: the organization comes from `ctx.membership` (CLAUDE.md rule 5),
 * the unit is something the agent looks up through tools scoped to that membership, and
 * a client-supplied history would be a client-supplied prompt.
 */
export const AgentRunRequestSchema = z
  .object({
    /** **Untrusted.** Fenced before it reaches the model; never in the system role. */
    message: AiMessageContentSchema,
  })
  .strict();

export type AgentRunRequestInput = z.infer<typeof AgentRunRequestSchema>;

/** One tool call, as reported to the caller. Metadata only — never a tool result. */
export const AgentStepSchema = z
  .object({
    round: z.number().int().min(1),
    tool: z.string(),
    kind: z.enum(['read', 'propose', 'unknown']),
    outcome: z.enum([
      'ok',
      'proposed',
      'unknown_tool',
      'invalid_arguments',
      'unavailable',
      'unverified_reference',
      'proposal_limit',
      'failed',
    ]),
    duration_ms: z.number().int().min(0),
  })
  .strict();

/**
 * A proposal, as returned for a human to decide on.
 *
 * `id` is nullable: a proposal that could not be stored is reported honestly rather than
 * silently dropped, and since approval takes a row id, a null id is an unapprovable
 * proposal. That is the safe direction for the failure to point in.
 */
export const AgentProposalSchema = z
  .object({
    id: UuidSchema.nullable(),
    tool_name: z.string(),
    /** The model's arguments, verbatim. What is approved is what was proposed. */
    arguments: z.record(JsonValueSchema),
    rationale: z.string(),
    status: z.literal('pending'),
    /** Server overrides applied to the model's request, for example a capped priority. */
    adjustments: z.array(z.string()),
  })
  .strict();

export const AgentRunDataSchema = z
  .object({
    run_id: UuidSchema.nullable(),
    /** The assistant's closing summary, or null when a bound stopped the run first. */
    summary: z.string().nullable(),
    stop_reason: z.enum(['completed', 'max_rounds', 'max_tool_calls', 'deadline', 'model_silent']),
    rounds: z.number().int().min(0),
    /**
     * A literal, not a computed value. No agent run can report otherwise, and a test can
     * assert the property against the schema rather than against the handler.
     */
    executed: z.literal(false),
    /** `false` when the run or its proposals could not be stored. */
    persisted: z.boolean(),
    steps: z.array(AgentStepSchema),
    proposals: z.array(AgentProposalSchema),
    prompt_version: z.string(),
    model: z.string(),
  })
  .strict();

export const AgentRunResponseSchema = resourceResponseSchema(AgentRunDataSchema);

export type AgentRunData = z.infer<typeof AgentRunDataSchema>;

/** Path parameter for the approval route. Validated before it reaches the RPC. */
export const AgentProposalIdSchema = z.object({ proposalId: UuidSchema }).strict();

/**
 * The decision response, shared by approve and reject.
 *
 * `executed: false` is a literal on both. A decision records that a human agreed or
 * disagreed; it does not carry the action out. Anything that later acts on an approved
 * proposal must re-derive its facts under that human's own credentials — and migration
 * `0004` makes the same point from the database's side, where `executed` is unreachable
 * from a client entirely, because only the component that actually performed an action
 * may claim it happened.
 */
export const AgentDecisionDataSchema = z
  .object({
    proposal_id: UuidSchema,
    status: z.enum(['approved', 'rejected']),
    executed: z.literal(false),
  })
  .strict();

export const AgentDecisionResponseSchema = resourceResponseSchema(AgentDecisionDataSchema);

export type AgentDecisionData = z.infer<typeof AgentDecisionDataSchema>;

/**
 * The approval response, narrowed to `approved`.
 *
 * Kept distinct from {@link AgentDecisionDataSchema} rather than folded into it so the
 * approve endpoint is parsed against a schema that cannot describe a rejection. A route
 * that returned the wrong decision would fail its own output check.
 */
export const AgentApprovalDataSchema = z
  .object({
    proposal_id: UuidSchema,
    status: z.literal('approved'),
    executed: z.literal(false),
  })
  .strict();

export const AgentApprovalResponseSchema = resourceResponseSchema(AgentApprovalDataSchema);

/** The rejection response, narrowed to `rejected`, for the same reason. */
export const AgentRejectionDataSchema = z
  .object({
    proposal_id: UuidSchema,
    status: z.literal('rejected'),
    executed: z.literal(false),
  })
  .strict();

export const AgentRejectionResponseSchema = resourceResponseSchema(AgentRejectionDataSchema);
