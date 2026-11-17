/**
 * The HTTP calls this lane makes, and the only ones it is allowed to make.
 *
 * ONE SEAM, DELIBERATELY
 * ----------------------
 * Every component in `features/ai-agent/**` goes through this module. No component calls
 * `fetch`, and — more importantly — no component touches the Supabase browser client.
 * That is not tidiness; it is the property the screen exists to demonstrate:
 *
 *   `supabase/migrations/0004_agentic.sql` revokes UPDATE on `agent_proposals` from
 *   `authenticated` and declares no UPDATE policy, so there is no client statement that
 *   can move a proposal from `pending` to `approved`. Approval goes button → POST here →
 *   `withApiHandler` re-authorizes against `STAFF_ROLES` → `approve_agent_proposal(p_id)`
 *   runs `security definer` and re-checks `is_org_staff()` on the proposal's *own*
 *   organization. Three independent checks, none of them in this file, none of them
 *   reachable from it.
 *
 * Keeping the browser client out of this directory entirely means that claim cannot be
 * quietly weakened later by an innocuous-looking convenience query.
 *
 * WHAT THE REQUEST BODY DOES NOT CONTAIN
 * --------------------------------------
 * `AgentRunRequestSchema` is `.strict()` and has exactly one field. No organization id
 * (it comes from trusted membership rows — CLAUDE.md rule 5), no unit id, and no
 * conversation history, because a client-supplied history is a client-supplied prompt.
 * Sending any of them is a 422, which is the correct answer and the reason this file
 * sends none of them.
 */

'use client';

import { AgentDecisionResponseSchema, AgentRunResponseSchema, type AgentRunData } from './wire';

/** `POST` — one conversational turn. Read tools run; consequential ones only propose. */
export const AGENT_RUN_URL = '/api/v1/ai/agent/run';

export type AgentDecision = 'approve' | 'reject';

/**
 * The human decision endpoints.
 *
 * `approve` is shipped by lane w3-l4. `reject` is **not yet**: the RPC
 * `public.reject_agent_proposal(uuid)` exists in migration 0004 — added there precisely
 * because, with UPDATE revoked, "a human who declines a proposal would have no way to say
 * so" — but no route calls it. `app/api/v1/ai/agent/**` belongs to w3-l4, so this lane
 * cannot add one. The URL is named here, in the shape its sibling already uses, so that
 * wiring it is a new file in that lane and no change at all in this one. Reported as a
 * planning defect.
 */
export function proposalDecisionUrl(proposalId: string, decision: AgentDecision): string {
  return `/api/v1/ai/agent/proposals/${encodeURIComponent(proposalId)}/${decision}`;
}

/**
 * Send a message; get back the summary, the step trace, and anything awaiting a human.
 *
 * Parsed with the producer's own schema. A response that does not match is a failure
 * rather than something to render optimistically: half a trace is more misleading than
 * no trace, because the missing half is the part that would have shown a refusal.
 */
export async function runAgent(message: string): Promise<AgentRunData> {
  const payload = await postJson(AGENT_RUN_URL, { message });

  const parsed = AgentRunResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AgentRequestError('The assistant returned a response this screen cannot read.');
  }
  return parsed.data.data;
}

export interface DecisionOutcome {
  readonly proposalId: string;
  readonly status: 'approved' | 'rejected';
  /**
   * Always `false` today, and read from the response rather than assumed.
   *
   * Approving records that a human agreed with a proposal; it does not carry the action
   * out. If a later lane makes approval execute, this flag is how the card learns to say
   * so instead of being edited to lie about it.
   */
  readonly executed: boolean;
}

/**
 * Record a human's decision on one proposal.
 *
 * The response is the server's confirmation — `{ proposal_id, status, executed }` — not a
 * re-read of the row, so this returns a decision rather than a proposal and the caller
 * keeps the two apart. Nothing is updated locally before this resolves: an optimistic
 * "Approved" that the server had in fact refused is the one lie this screen cannot
 * afford, since being an honest account of what the system did is its entire job.
 */
export async function decideProposal(
  proposalId: string,
  decision: AgentDecision,
): Promise<DecisionOutcome> {
  // The same explicit-confirmation literal every mutation reachable from model output
  // carries in this codebase (`ConfirmationSchema` is `z.literal(true)`, not a boolean).
  // The approve route takes no body today and ignores it; sending it keeps the intent
  // legible and costs nothing.
  const payload = await postJson(proposalDecisionUrl(proposalId, decision), { confirmed: true });

  if (decision === 'approve') {
    const parsed = AgentDecisionResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AgentRequestError('The approval was sent but the response could not be read.');
    }
    return {
      proposalId: parsed.data.data.proposal_id,
      status: parsed.data.data.status,
      executed: parsed.data.data.executed,
    };
  }

  // The reject route is not shipped yet and its response shape is therefore not frozen.
  // A 2xx is taken at face value; anything else has already thrown above.
  return { proposalId, status: 'rejected', executed: false };
}

/* ------------------------------------------------------------------- errors -- */

/**
 * A failed call, carrying the frozen envelope's `request_id` when the server sent one.
 *
 * The id is surfaced in the UI on purpose: it is the correlation key the server logs are
 * written against, so quoting it connects a screen to a log line without the screen
 * having to print anything about the failure itself (CLAUDE.md rule 8).
 */
export class AgentRequestError extends Error {
  readonly requestId: string | null;
  readonly status: number | null;

  constructor(
    message: string,
    options: { requestId?: string | null; status?: number | null } = {},
  ) {
    super(message);
    this.name = 'AgentRequestError';
    this.requestId = options.requestId ?? null;
    this.status = options.status ?? null;
  }
}

/** Reads the frozen error envelope without inventing an error code outside the eight. */
async function postJson(url: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body),
    });
  } catch {
    throw new AgentRequestError('The assistant could not be reached. Check your connection.');
  }

  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return payload;

  const envelope =
    typeof payload === 'object' && payload !== null
      ? (payload as { error?: { message?: unknown; request_id?: unknown } }).error
      : undefined;

  const message =
    typeof envelope?.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : fallbackMessage(response.status);
  const requestId = typeof envelope?.request_id === 'string' ? envelope.request_id : null;

  throw new AgentRequestError(message, { requestId, status: response.status });
}

/**
 * What to say when the server sent no message of its own.
 *
 * 403 gets its own sentence because on this screen it is not a bug — it is the
 * authorization model answering — and 429 gets one because the agent route is rate
 * limited to four runs a minute, which a demo can genuinely reach.
 */
function fallbackMessage(status: number): string {
  switch (status) {
    case 401:
      return 'Your session has expired. Sign in again.';
    case 403:
      return 'Your role may not take this action. Nothing was changed.';
    case 404:
      return 'That endpoint is not available in this build. Nothing was changed.';
    case 409:
      return 'This proposal has already been decided.';
    case 422:
      return 'The request was rejected as invalid. Nothing was changed.';
    case 429:
      return 'Rate limited — the assistant allows four runs a minute. Wait, then try again.';
    default:
      return 'The request was rejected. Nothing was changed.';
  }
}
