/**
 * Writing the run and its proposals, and the two RPCs that record a human decision.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY WRITES IN THIS SUBSYSTEM
 * ---------------------------------------------------------------------------
 * Four statements exist in `services/ai/agent/**`, all of them here:
 *
 *   INSERT public.agent_runs        — that a run happened, and the instruction that
 *                                     started it
 *   INSERT public.agent_proposals   — what the agent suggested, always `'pending'`
 *   SELECT approve_agent_proposal() — a human's approval
 *   SELECT reject_agent_proposal()  — a human's rejection
 *
 * None of them is reachable from a tool call. The two inserts are performed by the
 * orchestrator after the loop has finished, from values it collected; no model output
 * chooses whether or where they happen. The two RPCs are reachable only from a route with
 * an authenticated session behind it, and only ever from a human pressing a button.
 *
 * `status` on a proposal is written as the literal `'pending'` and is never taken from an
 * argument. It could not be anything else even if this file tried: migration `0004`
 * revokes `UPDATE` on `agent_proposals` from `authenticated` and declares no UPDATE
 * policy, so there is no client statement that can move a proposal out of `pending`. The
 * decision RPCs are `security definer` and check `is_org_staff()` themselves. A
 * compromised browser session — or a bug in this file — cannot promote a proposal.
 *
 * Every statement runs through the **caller-scoped** Supabase client with Row Level
 * Security in force. There is no service-role client in this directory, which is why
 * `app/api/v1/ai/agent/run` uses `withApiHandler` rather than its privileged variant.
 *
 * ---------------------------------------------------------------------------
 * THE TYPING BRIDGE — A LIVE PLANNING DEFECT, NOT A SHORTCUT
 * ---------------------------------------------------------------------------
 * `packages/shared/types/database.ts` is generated from the schema and still has no entry
 * for `agent_runs`, `agent_proposals` or the two RPCs, because migration `0004` landed in
 * this wave and **no wave-3 lane owns that file**, so it cannot be regenerated here. This
 * is not unique to this lane: the same gap produces typecheck failures in w3-l7's
 * `features/inbox/**`, which is how one knows it is a planning defect rather than a local
 * inconvenience. It is reported with the regeneration command.
 *
 * Until it is regenerated, these statements go through {@link AgentWriteClient}: a narrow
 * structural view of the client naming exactly the two tables and the two functions this
 * file uses, applied in a single documented cast. It is not a local copy of a shared type
 * — it describes statements, not rows — and it deletes itself the day `database.ts` is
 * regenerated. It also cannot express an `UPDATE` or a `DELETE`, so the workaround for a
 * missing type cannot double as a way to widen what this file can do.
 *
 * ---------------------------------------------------------------------------
 * DEGRADING WHEN THE MIGRATION HAS NOT BEEN APPLIED
 * ---------------------------------------------------------------------------
 * If the tables are absent in an environment (SQLSTATE `42P01`), the run still answers
 * and its proposals come back with `id: null`. That is the fail-safe direction rather
 * than a fudge: approval takes a row id, so a proposal with no row is a proposal nobody
 * can approve. The degraded state is reported in the response as `persisted: false`
 * instead of being discovered later as missing history.
 */

import {
  ApiRouteError,
  isPostgresErrorLike,
  postgresErrorToApiError,
  type PostgresErrorLike,
} from '@/lib/api/errors';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import type { Json } from '@shared/index';

import type { AgentStopReason, PersistedProposal, ProposalDraft } from './types';

/** `relation does not exist`. The migration has not been applied in this environment. */
const UNDEFINED_TABLE = '42P01';
/** `undefined_function`. The decision RPCs have not been created yet. */
const UNDEFINED_FUNCTION = '42883';

/** The decision functions `0004` exposes. Named here so a typo is a compile error. */
type DecisionRpc = 'approve_agent_proposal' | 'reject_agent_proposal';

interface InsertResult {
  readonly data: readonly { readonly id: string }[] | null;
  readonly error: PostgresErrorLike | null;
}

interface RpcResult {
  readonly data: unknown;
  readonly error: PostgresErrorLike | null;
}

/**
 * The narrow view of the Supabase client this file uses.
 *
 * Two table names, two function names, `insert` and `rpc`. There is no `update` and no
 * `delete` on this interface, which is the point: see the module header.
 */
interface AgentWriteClient {
  from(table: 'agent_runs' | 'agent_proposals'): {
    insert(values: readonly Record<string, unknown>[]): {
      select(columns: string): PromiseLike<InsertResult>;
    };
  };
  rpc(fn: DecisionRpc, args: { p_id: string }): PromiseLike<RpcResult>;
}

/** The single documented cast. See the module header. */
function bridge(supabase: AppSupabaseClient): AgentWriteClient {
  return supabase as unknown as AgentWriteClient;
}

function errorCode(error: PostgresErrorLike | null): string {
  return typeof error?.code === 'string' ? error.code : '';
}

/** `true` when the schema simply is not there yet, as opposed to a genuine failure. */
function isSchemaMissing(error: PostgresErrorLike | null): boolean {
  const code = errorCode(error);
  return code === UNDEFINED_TABLE || code === UNDEFINED_FUNCTION;
}

/* ------------------------------------------------------------------- runs -- */

/**
 * `agent_runs.status`, derived from why the loop stopped.
 *
 * The three outcomes are different facts and `0004`'s check constraint has words for all
 * of them, so they are not flattened into "completed". A run cut off by a bound did not
 * finish, and a reader of the history should be able to see that without reading a log.
 */
function runStatus(stopReason: AgentStopReason): 'completed' | 'failed' | 'cancelled' {
  switch (stopReason) {
    case 'completed':
      return 'completed';
    case 'model_silent':
      return 'failed';
    case 'max_rounds':
    case 'max_tool_calls':
    case 'deadline':
      return 'cancelled';
  }
}

/** What the orchestrator knows about a finished run. */
export interface AgentRunRecord {
  readonly organizationId: string;
  /**
   * `profiles.id` of the caller, from `Membership`.
   *
   * `0004`'s insert policy requires this to equal `current_profile_id()`, so a staff
   * member cannot attribute a run to a colleague even by sending a different value —
   * Postgres rejects the row. Passing it from membership rather than from a body is the
   * application-side half of the same rule (CLAUDE.md rule 5).
   */
  readonly actorProfileId: string;
  /**
   * The instruction that started the run. Stored, because a run with no record of what
   * was asked is unauditable — and never logged, because it is a human's free text
   * (CLAUDE.md rule 8, and the column's own comment in `0004`).
   */
  readonly input: string;
  readonly stopReason: AgentStopReason;
}

export interface PersistedRun {
  /** `agent_runs.id`, or `null` when the table is not deployed in this environment. */
  readonly runId: string | null;
  readonly proposals: readonly PersistedProposal[];
  /** `false` when the run or its proposals could not be stored. */
  readonly persisted: boolean;
}

/**
 * Writes the run row, then its proposals.
 *
 * The column list matches `0004` exactly — `agent_runs` holds the instruction, the actor
 * and a status, and nothing about tokens, rounds or models. Those are observability
 * facts; they go to the logger and to the audit row, where field names are policed by
 * `lib/observability/redaction.ts`, rather than becoming columns nobody queries.
 */
export async function persistAgentRun(
  supabase: AppSupabaseClient,
  record: AgentRunRecord,
  proposals: readonly ProposalDraft[],
): Promise<PersistedRun> {
  const client = bridge(supabase);

  const inserted = await client
    .from('agent_runs')
    .insert([
      {
        organization_id: record.organizationId,
        actor_profile_id: record.actorProfileId,
        input: record.input,
        status: runStatus(record.stopReason),
      },
    ])
    .select('id');

  if (inserted.error) {
    if (isSchemaMissing(inserted.error)) {
      return { runId: null, proposals: unpersisted(proposals), persisted: false };
    }
    throw postgresErrorToApiError(inserted.error);
  }

  const runId = inserted.data?.[0]?.id ?? null;
  if (!runId) {
    // An insert that returns no id means the write was accepted but the row is not
    // visible to the caller, which would leave proposals unattachable. Fail rather than
    // write orphans against a run nobody can read.
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'agent_run_insert_returned_no_id' },
    });
  }

  if (proposals.length === 0) {
    return { runId, proposals: [], persisted: true };
  }

  const rows = proposals.map((proposal) => ({
    organization_id: record.organizationId,
    run_id: runId,
    tool_name: proposal.toolName,
    // The model's own arguments, verbatim. What a human approves must be what was
    // proposed, not a re-rendering of it.
    arguments: proposal.arguments as Json,
    rationale: proposal.rationale,
    // A literal. Never an argument, never derived from model output — and `0004`'s
    // insert policy would reject anything else anyway.
    status: 'pending',
  }));

  const written = await client.from('agent_proposals').insert(rows).select('id');

  if (written.error) {
    if (isSchemaMissing(written.error)) {
      return { runId, proposals: unpersisted(proposals), persisted: false };
    }
    throw postgresErrorToApiError(written.error);
  }

  const ids = written.data ?? [];
  return {
    runId,
    // PostgREST returns inserted rows in payload order, so the pairing is positional. A
    // missing id degrades that one proposal to unapprovable rather than risking pairing
    // it with somebody else's row.
    proposals: proposals.map((proposal, index) => ({
      ...proposal,
      id: ids[index]?.id ?? null,
      status: 'pending' as const,
    })),
    persisted: ids.length === proposals.length,
  };
}

function unpersisted(proposals: readonly ProposalDraft[]): readonly PersistedProposal[] {
  return proposals.map((proposal) => ({ ...proposal, id: null, status: 'pending' as const }));
}

/* --------------------------------------------------------------- decisions -- */

/**
 * Records a human's decision on one proposal.
 *
 * Everything that matters about this function is what it is not. It is not called from
 * the loop, not called from a tool, and not called from anything a model can reach: the
 * loop has no HTTP client and the propose tools are handed an organization id and a
 * clock. It takes a proposal id from a route path and an authenticated session.
 *
 * The decision itself is Postgres's. Both RPCs run `security definer`, re-read the row
 * `for update`, check `is_org_staff()` against the proposal's own organization, and
 * refuse a proposal that is not `pending`. A proposal that does not exist and a proposal
 * in another organization raise the identical error, so the endpoint cannot be used as an
 * existence oracle across organizations.
 *
 * **A decision is not an execution.** Approving marks that a human agreed. Carrying an
 * approved proposal out is a separate, deliberate step that must re-derive every
 * security-relevant value under that human's own credentials, exactly as
 * `app/api/v1/ai/maintenance/confirm` re-derives the unit, the property and the priority
 * rather than trusting the draft it was handed. `0004` makes the same point from the
 * other side: `executed` is unreachable from a client at all, because only the trusted
 * component that actually performed the action may claim it happened.
 */
async function decideAgentProposal(
  supabase: AppSupabaseClient,
  proposalId: string,
  rpc: DecisionRpc,
): Promise<void> {
  const { error } = await bridge(supabase).rpc(rpc, { p_id: proposalId });

  if (!error) return;

  if (isSchemaMissing(error)) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: `${rpc}_not_deployed` },
      cause: error,
    });
  }
  if (isPostgresErrorLike(error)) throw postgresErrorToApiError(error);

  throw new ApiRouteError('INTERNAL_ERROR', {
    logFields: { reason: `${rpc}_failed` },
    cause: error,
  });
}

/** A human approves. See {@link decideAgentProposal}. */
export function approveAgentProposal(
  supabase: AppSupabaseClient,
  proposalId: string,
): Promise<void> {
  return decideAgentProposal(supabase, proposalId, 'approve_agent_proposal');
}

/**
 * A human declines.
 *
 * Without this the lifecycle is unreachable: `UPDATE` is revoked on the table, so a
 * manager who disagrees with a proposal would have no way to say so and the review queue
 * would only ever grow. `0004` records the same observation from the migration's side.
 */
export function rejectAgentProposal(
  supabase: AppSupabaseClient,
  proposalId: string,
): Promise<void> {
  return decideAgentProposal(supabase, proposalId, 'reject_agent_proposal');
}
