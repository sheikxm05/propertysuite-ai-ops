/**
 * `POST /api/v1/inbox/messages/{messageId}/reply` — the human sends.
 *
 * This is the other half of the pair, and the pair is the clearest statement of
 * CLAUDE.md rule 7 in the codebase. Read the two files next to each other:
 *
 *     draft/route.ts   calls a model, writes nothing, returns text
 *     route.ts (here)  writes and sends, and never calls a model
 *
 * **The text that goes to the tenant is `ctx.body.body`.** It came out of the request.
 * There is no import in this file that can produce text — `services/ai/reply` is not
 * imported here and nothing in this directory stores a draft — so there is no path, not
 * a queue, not a cache, not a column, by which the model's output from `/draft` could
 * arrive at this send. It gets here by being typed into a browser by a person who is
 * authenticated, who is staff, and whose profile id is written into the row and named in
 * the audit trail. A reviewer can confirm that from the import list alone, which is the
 * property worth having: the guarantee does not depend on anyone reading the body of the
 * function correctly.
 *
 * `ai_draft` does not weaken that. It is an optional echo used to label the row's
 * provenance and nothing else; `draftProvenance` explains what it can and cannot claim.
 * If it were deleted, every row would read `drafted_by = 'human'` and not one byte of
 * what is sent, to whom, or by whose authority would change.
 *
 * Order of operations, and why each step is where it is:
 *
 *   1. Authorize, attribute, resolve the sender. Nothing is written until the message is
 *      known to be this organization's and to belong to exactly one tenant.
 *   2. Check the 24-hour window. Before the row, so a refusal leaves no state.
 *   3. Write the `queued` row. Before the send, so a message cannot reach a tenant with
 *      no record of it — and so its id can be the send's idempotency key.
 *   4. Send.
 *   5. Settle the row to `sent` or `failed`, and audit.
 *
 * 202, not 201: the row exists and the provider has accepted it, but delivery to the
 * handset is the provider's to complete. `status` in the body says exactly how far it
 * got.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { accepted } from '@/lib/api/responses';
import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { STAFF_ROLES } from '@shared/index';
import { inboxContextFrom } from '@/features/inbox/domain';
import { OutboundSendError, type OutboundFailureReason } from '@/services/integrations';
import { whatsappOutbound } from '@/services/integrations/server-only/whatsapp-outbound';

import { queueStaffReply, settleStaffReply } from './outbound-messages';
import {
  SendReplySchema,
  customerServiceWindow,
  draftProvenance,
  loadReplyTarget,
  windowClosed,
  type SendReplyInput,
} from './reply-guards';

/**
 * Lower than a read, higher than the draft.
 *
 * Each call puts a message on a real person's phone, so the bucket protects the tenant
 * from a loop in the UI rather than protecting us from cost. Ten a minute is more than
 * an operator can type and far fewer than a runaway client would attempt.
 */
const SEND_RATE_LIMIT = { key: 'inbox:reply-send', perMinute: 10 } as const;

export const POST = withPrivilegedApiHandler<SendReplyInput>(
  {
    /*
     * Staff only, and this is the role gate that matters most in the lane. A reply goes
     * out as the organization, over a channel the tenant cannot distinguish from an
     * official letter. A tenant who could reach this route could write to a neighbour in
     * their landlord's voice. `loadReplyTarget` re-derives the same decision from
     * `audienceFor` once the membership is resolved; this gate refuses before the body
     * is even parsed.
     */
    roles: STAFF_ROLES,
    bodySchema: SendReplySchema,
    rateLimit: SEND_RATE_LIMIT,
    audit: { action: 'inbound_message_replied', entityType: 'outbound_message' },
  },
  async (ctx) => {
    const { body, membership, logger } = ctx;
    const organizationId = membership.organization.id;
    const context = inboxContextFrom(ctx);

    /* 1. Authorization, attribution, sender. Same gate as `/draft`, same code. */
    const { message, sender } = await loadReplyTarget(context, ctx.params.messageId);

    /* 2. The deadline, enforced before anything exists. */
    const window = await customerServiceWindow(context, message);
    if (!window.open) throw windowClosed(window);

    /*
     * 3. Provenance of the words. A label on the row, never an input to a decision — and
     *    `'human'` unless the submitted text provably matches the draft that was shown.
     */
    const draftedBy = draftProvenance(body.body, body.ai_draft);

    if (!ctx.serviceRole) {
      // `0006` revokes writes on `outbound_messages` from `authenticated`, so there is
      // no caller-scoped fallback to try. Failing here means nothing was sent, which is
      // the correct outcome for a deployment with no service-role credential.
      throw new ApiRouteError('INTERNAL_ERROR', {
        logFields: { reason: 'service_role_unavailable_for_outbound' },
      });
    }

    /*
     * 4. The row, first.
     *
     * Every field that decides where this goes is derived server-side:
     * `organization_id` from `ctx.membership` (CLAUDE.md rule 5), `to_identifier` from
     * the inbound row rather than from the request — a client-supplied destination would
     * turn this endpoint into an open relay that sends in the organization's name —
     * `tenant_id` from the directory the caller may already read, and
     * `sent_by_profile_id` from the verified session. The request contributes exactly
     * one thing: the words.
     */
    const outbound = await queueStaffReply(ctx.serviceRole, logger, {
      organizationId,
      inboundMessageId: message.id,
      tenantId: sender.tenantId,
      toIdentifier: message.from_identifier,
      body: body.body,
      draftedBy,
      sentByProfileId: membership.profile.id,
    });

    /* 5. The send. The row id is the idempotency key, so a retry cannot double-message. */
    let providerMessageId: string;
    let deduplicated: boolean;
    try {
      const result = await whatsappOutbound().sendText({
        to: message.from_identifier,
        body: body.body,
        idempotencyKey: outbound.id,
      });
      providerMessageId = result.messageId;
      deduplicated = result.deduplicated;
    } catch (error) {
      await settleStaffReply(ctx.serviceRole, logger, {
        organizationId,
        outboundMessageId: outbound.id,
        status: 'failed',
      });
      logger.warn('staff reply not delivered', {
        entity_id: outbound.id,
        provider: 'whatsapp',
        reason: error instanceof OutboundSendError ? error.reason : 'send_threw',
        outcome: 'failed',
      });
      throw sendFailure(error);
    }

    /* 6. Settle, then audit. */
    await settleStaffReply(ctx.serviceRole, logger, {
      organizationId,
      outboundMessageId: outbound.id,
      status: 'sent',
      providerMessageId,
    });

    logger.info('staff reply sent', {
      entity_id: outbound.id,
      tenant_id: sender.tenantId,
      provider: 'whatsapp',
      status: 'sent',
      cache: deduplicated ? 'deduplicated' : 'delivered',
      outcome: 'sent',
    });

    ctx.audit({
      entityId: outbound.id,
      metadata: {
        /*
         * WHAT THIS AUDIT ROW SAYS, AND WHAT IT DELIBERATELY DOES NOT.
         *
         * It says a reply was sent, who sent it (`log_audit` fills `actor_profile_id`
         * from `current_profile_id()`), to which tenant, over which provider, and
         * whether a model wrote the words. It does NOT carry the words: an audit row is
         * readable by an organization admin and lives forever, and putting the message
         * text in one would make the audit trail a second, less guarded copy of the
         * conversation (CLAUDE.md rule 8). The text lives in `outbound_messages.body`,
         * under that table's own policies, and this row points at it by id.
         *
         * `event` carries the AI-drafted bit because `drafted_by` is not on
         * `LOGGABLE_FIELDS` in `lib/observability/redaction.ts` and is therefore dropped
         * by `redactMetadata`. `drafted_by` is passed anyway: it is harmlessly dropped
         * today and becomes the primary record the moment that lane adds it. Reported as
         * a planning defect.
         */
        event: draftedBy === 'ai' ? 'staff_reply_ai_drafted' : 'staff_reply_human_written',
        drafted_by: draftedBy,
        status: 'sent',
        provider: 'whatsapp',
        tenant_id: sender.tenantId,
      },
    });

    return accepted({ outboundMessageId: outbound.id, status: 'sent' as const }, ctx.requestId);
  },
);

/**
 * Maps an outbound failure onto the frozen eight.
 *
 * The split is "did the provider refuse this message, or did our side fail to ask?" —
 * because those are different things to a person looking at the screen, and a blanket
 * 500 tells them neither.
 *
 * `provider_rejected` is a 4xx from Meta and the most common cause is the customer
 * service window closing between our check and the send. The response body is
 * deliberately never read — a Graph API error echoes the request it refused, including
 * the message text — so the real reason cannot be quoted, and the message says what is
 * actually known: nothing was delivered, and the attempt is recorded as `failed`.
 * Guessing at a specific cause we cannot see would be worse than saying so.
 */
function sendFailure(error: unknown): ApiRouteError {
  const reason: OutboundFailureReason | 'send_threw' =
    error instanceof OutboundSendError ? error.reason : 'send_threw';

  switch (reason) {
    case 'body_empty':
    case 'body_too_long':
      // `AiMessageContentSchema` already bounds this, so reaching here means the schema
      // and the provider's limits disagree — a contract defect, reported as a 400 rather
      // than a 500 because the request is what has to change.
      return new ApiRouteError('VALIDATION_ERROR', {
        message: 'That reply is not a length WhatsApp will accept.',
        logFields: { reason, provider: 'whatsapp' },
      });

    case 'destination_not_a_phone_number':
      return new ApiRouteError('UNPROCESSABLE', {
        message: 'The number this message came from is not one WhatsApp can deliver to.',
        logFields: { reason, provider: 'whatsapp' },
      });

    case 'provider_rejected':
      return new ApiRouteError('UNPROCESSABLE', {
        message:
          'WhatsApp refused this reply. Nothing was delivered and the attempt is recorded as failed. The usual cause is the 24-hour reply window closing — check the thread and call the tenant if it has.',
        logFields: { reason, provider: 'whatsapp' },
      });

    default:
      // `transport_failed`, `provider_response_unreadable`, `idempotency_key_missing`
      // and anything unanticipated. These are our side of the wire, and a 500 is the
      // honest answer: the caller did nothing wrong and a retry may well work.
      return new ApiRouteError('INTERNAL_ERROR', {
        logFields: { reason, provider: 'whatsapp' },
      });
  }
}
