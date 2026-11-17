'use client';

/**
 * The browser's side of the inbox API.
 *
 * Every mutation goes through these functions rather than an inline `fetch`, for the
 * same reason `features/maintenance/components/api-client.ts` says: the frozen envelope
 * `{ error: { code, message, request_id } }` must reach the user as the *server's*
 * message. A hand-rolled fetch that printed "Something went wrong" would throw away a
 * `409` saying this message is already a ticket, and the `request_id` that joins the
 * complaint to the log.
 *
 * These functions decide nothing. No role check, no state check, no priority
 * calculation. The server decides and these report. And none of them sends an
 * `organization_id` — there is nowhere in any of these bodies to put one.
 */

import type { AgentRunData } from '@/services/ai/agent/schemas';

import type { ReplyFailureSignal } from '../domain/reply';

const BASE = '/api/v1/inbox';

/** The frozen §5.2 envelope, as the browser sees it. */
export interface ApiErrorEnvelope {
  error: { code: string; message: string; request_id: string };
}

export class InboxApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, envelope: ApiErrorEnvelope | null) {
    super(envelope?.error.message ?? 'The request could not be completed.');
    this.name = 'InboxApiError';
    this.status = status;
    this.code = envelope?.error.code ?? 'INTERNAL_ERROR';
    this.requestId = envelope?.error.request_id ?? '';
  }
}

/** The server's own message plus the correlation id, never an invented one. */
export function describe(error: unknown): string {
  if (error instanceof InboxApiError) {
    return error.requestId ? `${error.message} (reference ${error.requestId})` : error.message;
  }
  return 'The request could not be completed.';
}

/** POST to an inbox route. */
function send<TResult>(path: string, body?: unknown): Promise<TResult> {
  return post(`${BASE}${path}`, body);
}

/** POST to any route in this application, with the frozen envelope surfaced on failure. */
async function post<TResult>(url: string, body?: unknown): Promise<TResult> {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) throw new InboxApiError(response.status, await readEnvelope(response));
  return (await response.json()) as TResult;
}

async function readEnvelope(response: Response): Promise<ApiErrorEnvelope | null> {
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof (parsed as ApiErrorEnvelope).error?.code === 'string'
    ) {
      return parsed as ApiErrorEnvelope;
    }
  } catch {
    // A non-JSON body on a failure IS the failure; fall through to the default message.
  }
  return null;
}

/* -------------------------------------------------------------- simulator -- */

export interface SimulateResponse {
  data: {
    id: string | null;
    external_message_id: string;
    ingestion_path: 'webhook' | 'direct';
    /** `simulated` or `live`, as the webhook itself reported it. */
    webhook_mode: string | null;
    webhook_status: number | null;
    fallback_reason: string | null;
    received: number;
    accepted: number;
    /** Ids the `unique (provider, event_id)` index had already seen. */
    duplicates: number;
    /** `received | unmatched | classified | …` after sender resolution ran. */
    resolution_status: string | null;
    /** False when the sender resolved to nobody, so the row belongs to no organization. */
    attributed: boolean;
  };
}

/**
 * Injects a message into the ingestion pipeline.
 *
 * Exactly one of `tenant_id` and `from` is sent. Naming a tenant means "use the number on
 * their record", which the server resolves; sending a number means "use this one", which
 * is how an unknown sender is demonstrated.
 */
export function simulateMessage(input: {
  body: string;
  tenant_id?: string;
  from?: string;
  scenario?: string;
  /** Re-send under an id the webhook has already seen — the duplicate demonstration. */
  replay_of?: string;
}): Promise<SimulateResponse> {
  return send('/simulate', input);
}

/* ------------------------------------------------------------- classifier -- */

export interface Classification {
  category: string;
  summary: string;
  reported_symptoms: string[];
  suggested_priority: string;
  missing_information: string[];
  requires_clarification: boolean;
  clarification_question: string | null;
}

export interface ClassifyResponse {
  data: {
    created: false;
    draft: Classification;
    resolved_priority: string;
    suggested_priority: string | null;
    suggestion_capped: boolean;
    priority_reasons: string[];
    suggested_title: string | null;
    suggested_description: string | null;
    property_unit_id: string | null;
    unit_label: string | null;
    tenant_id: string | null;
    tenant_name: string | null;
    model: string;
    provider: string;
    prompt_version: string;
  };
}

export function classifyMessage(messageId: string): Promise<ClassifyResponse> {
  return send(`/messages/${messageId}/classify`);
}

/* ------------------------------------------------------------------ agent -- */

/**
 * The agent run, typed from lane w3-l4's own schema rather than restated here.
 *
 * `AgentRunData` is `z.infer<typeof AgentRunDataSchema>` in
 * `services/ai/agent/schemas.ts`, which is pure Zod and safe in a client bundle —
 * importing the *type* erases entirely at build time, so nothing server-side is dragged
 * across. Writing the shape out again by hand would be a second copy of a contract that
 * already has one (CLAUDE.md rule 4) and would drift the first time w3-l4 changed a
 * field.
 */
export type { AgentRunData } from '@/services/ai/agent/schemas';

/** Derived from the run data, so neither can drift from the other. */
export type AgentStep = AgentRunData['steps'][number];
export type AgentProposal = AgentRunData['proposals'][number];

export interface AgentRunResponse {
  data: {
    available: boolean;
    /** `agent_absent`, `agent_refused`, `agent_unreachable`, `agent_contract_mismatch`. */
    reason: string | null;
    upstream_status: number | null;
    run: AgentRunData | null;
  };
}

export function runAgent(messageId: string): Promise<AgentRunResponse> {
  return send(`/messages/${messageId}/agent`);
}

/** `AgentApprovalDataSchema` / `AgentRejectionDataSchema` — w3-l4's frozen replies. */
export interface ProposalDecisionResponse {
  data: { proposal_id: string; status: 'approved' | 'rejected'; executed: false };
}

/**
 * Approves or rejects a proposal, through lane w3-l4's own endpoints.
 *
 * NOT through an inbox route. Those two endpoints are gated on `STAFF_ROLES`, call the
 * security-definer RPC that is the only transition into `approved` or `rejected`, and
 * write their own audit row. Wrapping them in an inbox-flavoured proxy would create a
 * second implementation of one decision, and the one with the privileges is theirs.
 *
 * `executed: false` comes back as a literal in both replies: a decision is recorded, not
 * carried out. The UI says so rather than implying a record was created.
 */
export function decideProposal(
  proposalId: string,
  decision: 'approve' | 'reject',
): Promise<ProposalDecisionResponse> {
  return post(`/api/v1/ai/agent/proposals/${proposalId}/${decision}`);
}

/* ----------------------------------------------------------------- ticket -- */

export interface CommitTicketResponse {
  data: { id: string; status: string; priority: string; category: string };
}

export function commitTicket(
  messageId: string,
  body: {
    property_unit_id: string;
    title: string;
    description: string;
    category: string;
    priority?: string;
  },
): Promise<CommitTicketResponse> {
  return send(`/messages/${messageId}/ticket`, { ...body, confirmed: true });
}

/* ------------------------------------------------------------------ reply -- */

/**
 * The two reply calls, deliberately typed as `unknown`.
 *
 * Every other function in this file names the shape it expects. These two do not,
 * because their routes are being written in another lane as this ships and the frozen
 * reply contract (`{ draft }`, `{ outboundMessageId, status }`) is not the envelope the
 * rest of this application uses (`{ data: … }`, snake_case). Rather than assert a shape
 * and be wrong in the browser, the body is handed to `parseReplyDraft` /
 * `parseReplyReceipt` in `../domain/reply`, which accept either and are the one place
 * that has to change when the route lands.
 *
 * Neither function sends an `organization_id`, and `sendReply` sends exactly what the
 * operator typed — not the model's draft, not a merge of the two. If a person edited a
 * word, the edited word is what goes out, which is the whole point of the gate.
 */
export function draftReply(messageId: string): Promise<unknown> {
  return send(`/messages/${messageId}/reply/draft`);
}

export function sendReply(messageId: string, body: string): Promise<unknown> {
  return send(`/messages/${messageId}/reply`, { body });
}

/**
 * Reduces a thrown error to what `classifyReplyFailure` reads.
 *
 * Returns `null` for anything that is not an `InboxApiError` — a network failure, an
 * aborted request — which that function treats as `unknown`: nothing was sent, and the
 * screen says so without inventing a reason.
 */
export function failureSignal(error: unknown): ReplyFailureSignal | null {
  if (!(error instanceof InboxApiError)) return null;
  return { status: error.status, code: error.code, message: error.message };
}
