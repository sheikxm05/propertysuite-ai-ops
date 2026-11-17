/**
 * `POST /api/v1/inbox/messages/{messageId}/reply/draft` — ask the model for words.
 *
 * THIS ROUTE WRITES NOTHING. Not a row, not a status chip, not a column. That is not a
 * description of what it happens to do today; it is the reason the file exists
 * separately from `../route.ts`, and the three things below are what make it checkable
 * rather than merely claimed:
 *
 *  1. **It is `withApiHandler`, not `withPrivilegedApiHandler`.** `ctx.serviceRole` is
 *     `undefined` here. `0004` revokes INSERT and UPDATE on `inbound_messages` from
 *     `authenticated` and this lane assumes `0006` does the same for
 *     `outbound_messages`, so the only client on this context is one Postgres will
 *     refuse every relevant write from. The sibling route has to opt in by name to get
 *     a client that can write at all.
 *  2. **It imports nothing that can write.** There is no `outbound-messages` import in
 *     this file and no WhatsApp adapter. `draftTenantReply()` holds no Supabase client.
 *     Compare the import lists of the two routes — the difference is the whole design.
 *  3. **It declares no `audit`.** Every state change in this codebase leaves an audit
 *     row; this one declares none because there is no state change to record. A draft
 *     that produced an audit row would be a draft that looked like a decision.
 *
 * The draft is not stored anywhere. It travels to the browser, a person reads it, edits
 * it or does not, and sends it back to `../route.ts` as the `body` of a new authenticated
 * request. There is no server-side copy, which means there is no path — not a queue, not
 * a cache, not a column — by which this model output can reach the send without passing
 * through someone's keyboard. CLAUDE.md rule 7, enforced by the absence of a mechanism
 * rather than by a check.
 *
 * It also reports the WhatsApp customer service window, which is a read and changes
 * nothing. A draft the operator cannot actually send is worth knowing about *before* they
 * write a reply, and the UI needs somewhere to get "the window closed at 19:42" from. The
 * send route re-checks it independently: this is information, not permission.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { STAFF_ROLES } from '@shared/index';
import { inboxContextFrom } from '@/features/inbox/domain';
import { toApiRouteError } from '@/services/ai/errors';
import { draftTenantReply, type ReplyDraft } from '@/services/ai/reply';

import { customerServiceWindow, loadReplyTarget } from '../reply-guards';

/** Each call is a paid model request. Six a minute is already a busy operator. */
const DRAFT_RATE_LIMIT = { key: 'inbox:reply-draft', perMinute: 6 } as const;

export const POST = withApiHandler(
  {
    // Coarse gate, before the body is even looked at. `loadReplyTarget` re-derives the
    // same decision from `audienceFor` once the membership is in hand — a tenant must
    // not be able to obtain text written in their landlord's voice, even unsent.
    roles: STAFF_ROLES,
    rateLimit: DRAFT_RATE_LIMIT,
  },
  async (ctx) => {
    const context = inboxContextFrom(ctx);

    /* 1. Authorization, attribution and the sender — before the model is involved. */
    const { message, sender } = await loadReplyTarget(context, ctx.params.messageId);

    /*
     * `body` is nullable in `0004`: an image or a voice note produces no text, and the
     * ingestion path refuses to invent a placeholder that reads like tenant content.
     * There is nothing to reply to, and saying so beats sending an empty string to a
     * paid model call that would fail validation anyway.
     */
    const text = message.body?.trim() ?? '';
    if (text.length === 0) {
      throw new ApiRouteError('UNPROCESSABLE', {
        message: 'This message carries no text, so there is nothing to draft a reply to.',
        logFields: { reason: 'inbound_message_has_no_text' },
      });
    }

    /* 2. The deadline, read and reported. Not enforced here — nothing is being sent. */
    const window = await customerServiceWindow(context, message);

    /* 3. The model call. Validated or thrown — never partially believed. */
    let draft: ReplyDraft;
    try {
      draft = await draftTenantReply({
        messageBody: text,
        tenantName: sender.tenantName,
        // `maintenance_tickets` has no human-readable reference column, so the id is
        // the only reference that exists. Reported as a planning defect.
        ticketReference: message.ticket_id,
      });
    } catch (error) {
      // Outcome only. Neither the tenant's message nor the model's reply is logged
      // (CLAUDE.md rule 8).
      ctx.logger.warn('tenant reply draft failed', {
        entity_id: message.id,
        outcome: 'failed',
      });
      throw toApiRouteError(error);
    }

    ctx.logger.info('tenant reply drafted', {
      entity_id: message.id,
      tenant_id: sender.tenantId,
      // The confidence band and the number of open questions, never the words.
      status: draft.confidence,
      count: draft.clarifyingQuestions.length,
      outcome: 'drafted',
    });

    return ok(
      {
        /** Nothing in this object has been stored. It exists only in this response. */
        draft,
        /**
         * `created: false` is stated rather than implied, the same way
         * `../classify/route.ts` states it. A client reading this response should not
         * have to infer from the absence of an id that nothing happened.
         */
        created: false as const,
        window,
      },
      ctx.requestId,
    );
  },
);
