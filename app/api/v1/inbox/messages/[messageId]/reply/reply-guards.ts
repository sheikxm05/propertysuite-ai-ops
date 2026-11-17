/**
 * Everything both reply routes must agree about: who may reply, to what, within what
 * deadline, and whose words were sent.
 *
 * It lives in one file so the two routes cannot drift. `/draft` and `/reply` run the
 * same gate in the same order, and the only difference between them is what happens
 * after the gate — one returns text, the other sends it. A reviewer comparing the two
 * should be able to see that the refusals are literally the same code.
 *
 * Nothing here reads a request body except `draftProvenance`, and nothing here takes an
 * `organization_id` from anywhere but `ctx.membership`, which `resolveMembership()`
 * derived from trusted rows (CLAUDE.md rule 5).
 */

import { z } from 'zod';

import { ApiRouteError } from '@/lib/api/errors';
import { AiMessageContentSchema, UuidSchema } from '@shared/index';
import {
  audienceFor,
  matchSender,
  readMessage,
  senderDirectory,
  waveThree,
  type InboundMessageRow,
  type InboxContext,
  type SenderMatch,
} from '@/features/inbox/domain';

/* --------------------------------------------------------------- contract -- */

/**
 * `POST /api/v1/inbox/messages/{messageId}/reply`.
 *
 * **`body` is the whole security story of this route.** It is the text that will be
 * sent, it arrives in the request, and there is no code path anywhere in this directory
 * that can put a model's output here instead — `/draft` returns its draft to the browser
 * and stores nothing, so the server has no copy to fall back on even if someone wanted
 * one. CLAUDE.md rule 7 is satisfied structurally rather than by inspection.
 *
 * `AiMessageContentSchema` comes from `packages/shared` rather than being spelled out
 * here (rule 4). Its 4000-character bound sits under the Cloud API's own 4096, so a body
 * this schema accepts is a body the provider will accept.
 *
 * `ai_draft` is **optional provenance, never an input to any decision.** It is the exact
 * text `/draft` returned, echoed back so the server can tell "the operator pressed send
 * on what the model wrote" from "the operator wrote this". It cannot change who may
 * send, what is sent, where it goes, or which organization is touched. See
 * `draftProvenance` for why that is the only thing it is allowed to do, and what it
 * still cannot be trusted about.
 *
 * `.strict()`, so an `organization_id`, a `to`, or a `drafted_by` in the body is a 400
 * rather than a silently ignored field. All three are derived server-side.
 */
export const SendReplySchema = z
  .object({
    body: AiMessageContentSchema,
    ai_draft: AiMessageContentSchema.optional(),
  })
  .strict();

export type SendReplyInput = z.infer<typeof SendReplySchema>;

/* ------------------------------------------------------------------- gate -- */

export interface ReplyTarget {
  readonly message: InboundMessageRow;
  /** The tenant this thread belongs to, from rows the caller may already read. */
  readonly sender: SenderMatch;
}

/**
 * Resolves the message a reply is about, or refuses.
 *
 * The order of the four refusals is the point of the function:
 *
 *  1. **Staff only.** A reply goes out *as the organization*, to a tenant, over a
 *     channel the tenant cannot tell apart from a letter on headed paper. A tenant
 *     sending one would be impersonating their landlord to a neighbour. `audienceFor`
 *     already draws this line for the inbox as a whole and is reused rather than
 *     restated — an owner and a service provider are refused for the same reason.
 *  2. **A malformed id is `NOT_FOUND`, not `VALIDATION_ERROR`.** A 400 on a non-UUID
 *     and a 404 on a UUID is a free oracle telling an enumerator which of their guesses
 *     were even the right shape.
 *  3. **Absent, another organization's, and not-yours produce one answer.** `readMessage`
 *     filters on `ctx.membership.organization.id` and returns `null` for all three, so a
 *     message id from Organization B is indistinguishable from an id that was never
 *     issued. That equivalence is the demo, not an implementation detail.
 *  4. **An unattributed message cannot be replied to.** Checked explicitly even though
 *     (3) already makes a null-organization row unreachable — see `assertAttributed`.
 *
 * Only after all four does it look up who the sender is, using the caller's own
 * credentials, so the tenant a draft is about is a tenant the caller could already have
 * found.
 */
export async function loadReplyTarget(
  ctx: InboxContext,
  rawMessageId: string | undefined,
): Promise<ReplyTarget> {
  if (audienceFor(ctx.membership.role) !== 'organization') {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'role_cannot_reply_as_organization', role: ctx.membership.role },
    });
  }

  const messageId = UuidSchema.safeParse(rawMessageId);
  if (!messageId.success) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'message_id_not_a_uuid' } });
  }

  const message = await readMessage(ctx, messageId.data);
  if (!message) {
    throw new ApiRouteError('NOT_FOUND', {
      logFields: { reason: 'inbound_message_not_visible' },
    });
  }

  assertAttributed(message);

  const sender = matchSender(message.from_identifier, await senderDirectory(ctx));
  return { message, sender };
}

/**
 * Refuses to reply to a message nobody could attribute.
 *
 * This is the isolation boundary, stated as a precondition for speaking.
 *
 * `0004` writes `organization_id = null, status = 'unmatched'` when a number resolves to
 * zero tenants or to more than one, because attributing it by best effort is exactly the
 * cross-tenant leak this project exists to prevent. Replying to such a number means
 * sending one organization's words — possibly quoting one tenant's complaint — to a
 * handset that belongs to nobody we can name, and plausibly to a tenant of a different
 * organization using the same WhatsApp number. One outbound message is all it takes.
 *
 * Both halves are checked, and the redundancy is deliberate. `readMessage` filters on the
 * caller's organization, so a null-`organization_id` row is already unreachable through
 * it; `0005` grants the only read path over those rows to the platform-operator plane,
 * which by construction holds no membership and so cannot reach this route at all. The
 * check still runs because this file must stay correct if either of those changes. A
 * status of `unmatched` on an otherwise attributed row is the case the first filter
 * genuinely cannot catch.
 *
 * `UNPROCESSABLE`, not `FORBIDDEN`: the caller is entitled to the message and the request
 * is well formed. The message is in a state that cannot be answered, and saying so lets
 * the UI explain it instead of implying the operator lacks permission.
 */
function assertAttributed(message: InboundMessageRow): void {
  if (!message.organization_id) {
    throw new ApiRouteError('UNPROCESSABLE', {
      message:
        'This message is not attributed to a tenant, so there is nobody it can safely be answered as.',
      logFields: { reason: 'inbound_message_has_no_organization', status: message.status },
    });
  }

  if (message.status === 'unmatched') {
    throw new ApiRouteError('UNPROCESSABLE', {
      message: 'This number does not match exactly one tenant. Match the sender before replying.',
      logFields: { reason: 'inbound_message_sender_unmatched', status: message.status },
    });
  }
}

/* ----------------------------------------------------------------- window -- */

/**
 * Meta's customer service window.
 *
 * Free-form text may only be sent within 24 hours of the customer's last inbound
 * message. Outside it the Cloud API refuses the send and only a pre-approved template
 * will go through. This is a property of the wire contract, not of our product, which is
 * why it is a constant rather than a setting — see
 * `services/integrations/whatsapp/constants.ts`, where it would live if this lane owned
 * that file. Reported as a planning defect.
 */
export const CUSTOMER_SERVICE_WINDOW_HOURS = 24;
const CUSTOMER_SERVICE_WINDOW_MS = CUSTOMER_SERVICE_WINDOW_HOURS * 60 * 60 * 1000;

export interface CustomerServiceWindow {
  /** The tenant's most recent inbound message in this organization. */
  readonly lastInboundAt: string;
  /** When free-form text stops being deliverable. */
  readonly closesAt: string;
  readonly open: boolean;
  readonly windowHours: number;
}

/**
 * Computes the window from the sender's **latest** inbound message, not from the message
 * being replied to.
 *
 * That distinction is the whole reason this is a query rather than one subtraction.
 * Meta's window is per-customer: an operator working through a backlog may be answering
 * a three-day-old message from a tenant who wrote again an hour ago, and that send is
 * perfectly legal. Measuring from the message on screen would refuse it, and the operator
 * would have no way to tell a real deadline from our arithmetic.
 *
 * `from_identifier` is matched exactly, as stored. A tenant who wrote twice from
 * differently-written forms of the same number therefore falls back to whichever rows do
 * match — which can only make the window *narrower* than reality, never wider. A fuzzy
 * match here could only ever produce a send that Meta rejects, which is strictly worse
 * than a refusal we can explain.
 *
 * The read uses the caller's own client, so RLS applies: this cannot become a way to
 * learn when somebody else's tenant last made contact.
 */
export async function customerServiceWindow(
  ctx: InboxContext,
  message: InboundMessageRow,
  now: Date = new Date(),
): Promise<CustomerServiceWindow> {
  const organizationId = ctx.membership.organization.id;

  const { data, error } = await waveThree(ctx.supabase)
    .from('inbound_messages')
    .select('received_at')
    .eq('organization_id', organizationId)
    .eq('from_identifier', message.from_identifier)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    ctx.logger.warn('inbox read failed', { reason: 'last_inbound_read_failed' });
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'last_inbound_read_failed' },
    });
  }

  // The message being replied to matches its own `from_identifier`, so the query can
  // only come back empty if the row vanished between the two reads. Falling back to it
  // keeps the window closed-by-default rather than undefined.
  const lastInboundAt = data?.received_at ?? message.received_at;
  const closesAtMs = new Date(lastInboundAt).getTime() + CUSTOMER_SERVICE_WINDOW_MS;

  return {
    lastInboundAt,
    closesAt: new Date(closesAtMs).toISOString(),
    // `Number.isNaN` guards an unparseable timestamp into a closed window rather than
    // an open one: `NaN > x` is false, so the comparison alone would already fail safe,
    // and being explicit says that was on purpose.
    open: !Number.isNaN(closesAtMs) && now.getTime() < closesAtMs,
    windowHours: CUSTOMER_SERVICE_WINDOW_HOURS,
  };
}

/**
 * The refusal for a closed window.
 *
 * A named, explainable 422 — not a 500 and not a provider error leaking through. This
 * happens constantly in real use: a tenant messages on Friday evening, the operator
 * answers on Monday, and Meta refuses the send. The UI has to be able to say which of
 * those two things went wrong, and the only channel the frozen envelope gives it is the
 * code plus the message, so the message carries the deadline.
 *
 * Checked before anything is written and before anything is sent, so a refusal here
 * leaves no row and no partial state.
 */
export function windowClosed(window: CustomerServiceWindow): ApiRouteError {
  return new ApiRouteError('UNPROCESSABLE', {
    message: `WhatsApp only accepts a free-form reply within ${CUSTOMER_SERVICE_WINDOW_HOURS} hours of the tenant's last message. That window closed at ${window.closesAt}. Call them, or start a new conversation from an approved template.`,
    logFields: { reason: 'whatsapp_customer_service_window_closed', provider: 'whatsapp' },
  });
}

/* ------------------------------------------------------------- provenance -- */

/**
 * Decides whether the text that was sent is the text the model wrote.
 *
 * **The mechanism.** `/draft` returns its draft and stores nothing — that is the entire
 * point of splitting the two routes, and it means the server keeps no copy to compare
 * against. A comparison therefore has exactly two possible sources: something the client
 * echoes back, or a second model call on the send path. The second is disqualified on
 * sight: putting a model call inside the send would make the model a participant in the
 * mutation, which is the thing rule 7 forbids. So the client echoes the draft it was
 * shown, and the server reports `'ai'` only when the submitted body is that draft
 * character-for-character, modulo whitespace an editor may have introduced.
 *
 * **Why trusting the client here is acceptable, when rule 5 says it never is.** Rule 5 is
 * about authorization inputs — an `organization_id` that decides which rows are reachable.
 * `ai_draft` decides nothing. It cannot change the recipient, the organization, the
 * sender, the text, or whether the send is permitted; every one of those is derived
 * server-side and would be unchanged if this function always returned `'human'`. It
 * annotates a row.
 *
 * **It fails toward human accountability.** The field is optional and the default is
 * `'human'`. A client that omits it, mangles it, or sends nonsense produces a row
 * attributed wholly to the person who pressed send. `sent_by_profile_id` is the
 * authenticated caller in every branch, and the audit row names that person whichever
 * label applies — so no value of `ai_draft` can make a message less attributable to a
 * human.
 *
 * **The residual risk, stated plainly.** A client that echoes `ai_draft` equal to text a
 * person actually typed can label human words as AI-drafted. It cannot do the reverse in
 * any way that hides the person. The unforgeable version of this is for `/draft` to
 * return a keyed MAC over (message id, profile id, draft text, issued-at) which `/reply`
 * verifies, giving `'ai'` only to text the server itself provably produced for this
 * caller. That needs a server-side signing key and helper, which live under `lib/**` and
 * belong to another lane; it is in this lane's planning-defect report.
 */
export function draftProvenance(body: string, aiDraft: string | undefined): 'ai' | 'human' {
  if (!aiDraft) return 'human';
  return normaliseForComparison(body) === normaliseForComparison(aiDraft) ? 'ai' : 'human';
}

/**
 * Whitespace-insensitive, case-sensitive, punctuation-sensitive.
 *
 * A textarea turns `\r\n` into `\n` and operators add or lose a trailing newline without
 * meaning anything by it, so whitespace is normalised. Nothing else is: changing a word,
 * a name, a number or a full stop is an edit, and an edit means a person took
 * responsibility for the wording. Normalising case or stripping punctuation would quietly
 * classify a genuinely edited message as AI-drafted.
 */
function normaliseForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
