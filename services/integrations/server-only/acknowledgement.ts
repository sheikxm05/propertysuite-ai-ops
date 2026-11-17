/**
 * Send one tenant an immediate, fixed acknowledgement — once, and never for a message
 * we could not attribute.
 *
 * ===========================================================================
 * THE LINE THIS FILE SITS ON
 * ===========================================================================
 *
 * CLAUDE.md rule 7 forbids model output reaching a mutation without an authenticated
 * human confirmation, and a WhatsApp message landing on a real person's phone is such a
 * mutation. This path is permitted because **no model is involved**: the body is
 * `acknowledgementText(reference)`, a pure function of one opaque reference string, and
 * it contains no tenant name, no unit, no address and no amount. Read the reasoning at
 * the top of `../whatsapp/acknowledgement.ts` before changing anything here.
 *
 * The AI-drafted reply is `kind = 'staff_reply'`, `drafted_by = 'ai'`, sent by an
 * authenticated person through the same adapter and a different caller. The two kinds
 * must not converge on one function, because what makes this one safe to send without a
 * human is precisely that it cannot say anything.
 *
 * ===========================================================================
 * WHEN IT SENDS
 * ===========================================================================
 *
 * Only when sender resolution returned `matched` — exactly one tenant in exactly one
 * organization. The caller enforces that (see `inbound-job.ts`) and this function
 * re-states it by requiring a non-null `organizationId` and `tenantId` in its input,
 * which only the matched branch of `SenderResolution` can produce.
 *
 *   unmatched         no reply, ever. The number belongs to someone we do not know.
 *                     Answering it confirms to a stranger that they have reached a live
 *                     property-management system, which is free reconnaissance.
 *   ambiguous_sender  no reply, ever. Two organizations hold this number. Replying
 *                     means replying on behalf of one of them, chosen by a coin flip,
 *                     across the isolation boundary this project exists to defend.
 *
 * ===========================================================================
 * THE 24-HOUR CUSTOMER SERVICE WINDOW
 * ===========================================================================
 *
 * Meta permits a business to send free-form text to a user only within 24 hours of that
 * user's last inbound message; outside it, only an approved template may be sent, and a
 * free-form send is rejected by the Cloud API. This path is **always** inside the
 * window by construction — it runs from the job enqueued by the webhook that received
 * the message, seconds after it arrived — so it needs no window check.
 *
 * The staff-reply lane does NOT have that guarantee. A reply drafted on Monday and
 * approved on Wednesday is outside the window, and the Graph API will refuse it. That
 * lane needs the inbound message's `received_at` and a template fallback; this one does
 * not, and adding a speculative check here would imply a correctness concern that does
 * not exist on this path.
 *
 * ===========================================================================
 * HOW IT CANNOT SEND TWICE
 * ===========================================================================
 *
 * `outbound_messages` carries a partial unique index on `(inbound_message_id) where
 * kind = 'acknowledgement'`. The row is inserted with `status = 'queued'` BEFORE the
 * provider is called, so the index — not this code — arbitrates the race between two
 * concurrent attempts, in one atomic statement with no check-then-act window. A `23505`
 * means another attempt already owns this acknowledgement, which is **success**, not an
 * error. That is the same discipline `ingest.ts` applies to duplicate deliveries.
 *
 * The adapter's own `idempotencyKey` is set too, but it is the weaker of the two
 * guards: `InMemoryIdempotencyStore` is per-process and empty after a cold start. It
 * stops a double send within one process; the index stops it everywhere.
 *
 * The cost of claiming first is that a crash between the insert and the send loses the
 * acknowledgement permanently — the retry sees `23505` and declines. That is the right
 * trade. A lost courtesy message is a small harm; a second unexpected message to a
 * tenant is a real one, and resending on the strength of a `queued` row would do
 * exactly that whenever the crash happened *after* the provider accepted the send.
 *
 * ===========================================================================
 * WHY NOTHING HERE THROWS
 * ===========================================================================
 *
 * A failed acknowledgement must not fail the job. By the time this runs, the message is
 * already stored and already attributed — the valuable part is done. Throwing would
 * mark the job failed and, on retry, re-run resolution against a row that is no longer
 * `received`, which exits early; the net effect of treating a send failure as fatal is
 * a permanently failed job and no acknowledgement either. So every outcome is a
 * returned value, the failure is recorded as `status = 'failed'` on the row, and the
 * caller continues.
 *
 * Logging matches `inbound-job.ts`: `entity_id`, `outcome`, `reason`, and opaque ids
 * only. Never the body, never the number, never a name (CLAUDE.md rule 8).
 */

import 'server-only';

import type { Logger } from '@/lib/observability/logger';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

import { acknowledgementText, inboundMessageReference } from '../whatsapp/acknowledgement';
import { WHATSAPP_PROVIDER } from '../whatsapp/constants';
import { OutboundSendError, type WhatsAppOutboundAdapter } from '../whatsapp/outbound';
import {
  UNDEFINED_TABLE,
  UNIQUE_VIOLATION,
  asAgenticClient,
  pgCode,
  type OutboundMessageInsert,
} from './agentic-tables';
import { whatsappOutbound } from './whatsapp-outbound';

/* ------------------------------------------------------------------ types -- */

/**
 * What happened. Every value is a closed-vocabulary string and safe to log.
 *
 * `already_acknowledged` is deliberately not an error: it is the unique index doing its
 * job, and a retried job reaching it is the system working as designed.
 */
export type AcknowledgementOutcome =
  | 'sent'
  | 'already_acknowledged'
  | 'not_eligible'
  | 'send_failed'
  | 'record_failed'
  | 'storage_unavailable';

/**
 * Everything needed to acknowledge one message.
 *
 * `organizationId` and `tenantId` are required and non-nullable so that the only value
 * that can be passed here is one the matched branch of `SenderResolution` produced. An
 * optional organization id would make "acknowledge an unattributed message" a typo away
 * rather than impossible.
 */
export interface AcknowledgementRequest {
  /** `inbound_messages.id`. The reference is derived from it and the index keys on it. */
  readonly inboundMessageId: string;
  /** Correlation only — never written to the row, never used to scope a read. */
  readonly externalMessageId: string;
  readonly organizationId: string;
  readonly tenantId: string;
  /** The number the message came from. Personal data: stored, never logged. */
  readonly toIdentifier: string;
}

export interface AcknowledgementOptions {
  /** Injected in tests. Defaults to the process-wide adapter. */
  readonly adapter?: WhatsAppOutboundAdapter;
}

/** The adapter's dedupe key. Derived from the `wamid`, so a re-run collapses to one send. */
export function acknowledgementIdempotencyKey(externalMessageId: string): string {
  return `whatsapp_ack:${externalMessageId}`;
}

/* ------------------------------------------------------------------- send -- */

/**
 * Records and sends the acknowledgement. Never throws; never sends twice.
 *
 * Order of operations, and why it is this order:
 *
 *   1. build the body      pure, cannot fail in a way worth recording
 *   2. INSERT … 'queued'   claims the right to send. 23505 ⇒ someone else has it.
 *   3. send                the only step that touches the network
 *   4. UPDATE 'sent'       or 'failed', either way the row tells the truth afterwards
 */
export async function sendAcknowledgement(
  client: PrivilegedSupabaseClient,
  logger: Logger,
  request: AcknowledgementRequest,
  options: AcknowledgementOptions = {},
): Promise<AcknowledgementOutcome> {
  const startedAt = Date.now();

  /** The fields every line from this function carries. All opaque or enum-valued. */
  const base = {
    provider: WHATSAPP_PROVIDER,
    entity_id: request.externalMessageId,
    entity_type: 'outbound_message',
    organization_id: request.organizationId,
    tenant_id: request.tenantId,
  } as const;

  const reference = inboundMessageReference(request.inboundMessageId);
  if (!reference || !request.organizationId || !request.tenantId || !request.toIdentifier) {
    // Unreachable from the matched branch of `SenderResolution` against a real row.
    // Reported rather than thrown, because this function's contract is that the caller
    // never has to handle it.
    logger.warn('acknowledgement skipped', {
      ...base,
      outcome: 'not_eligible',
      reason: 'incomplete_request',
    });
    return 'not_eligible';
  }

  const body = acknowledgementText(reference);

  const row: OutboundMessageInsert = {
    organization_id: request.organizationId,
    inbound_message_id: request.inboundMessageId,
    tenant_id: request.tenantId,
    to_identifier: request.toIdentifier,
    body,
    kind: 'acknowledgement',
    // Not `'ai'`, and not `'human'`. A fixed string written by this module, which is
    // what entitles it to be sent with no confirmation step.
    drafted_by: 'system',
    // No human authorised this one, and recording a profile id here would be a lie that
    // an audit would later rely on.
    sent_by_profile_id: null,
    provider: WHATSAPP_PROVIDER,
    status: 'queued',
  };

  const agentic = asAgenticClient(client);

  const { data: inserted, error: insertError } = await agentic
    .from('outbound_messages')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (insertError) {
    const code = pgCode(insertError);

    if (code === UNIQUE_VIOLATION) {
      // The partial unique index refused a second acknowledgement for this message.
      // This is the guard working, so it is success.
      logger.info('acknowledgement already sent', {
        ...base,
        outcome: 'already_acknowledged',
        reason: 'duplicate_acknowledgement',
        duration_ms: Date.now() - startedAt,
      });
      return 'already_acknowledged';
    }

    if (code === UNDEFINED_TABLE) {
      // Migration 0006 has not been applied. An operational state, not a failure of
      // this message — and emphatically not a reason to send without recording, which
      // would remove the only durable double-send guard there is.
      logger.warn('acknowledgement storage unavailable', {
        ...base,
        outcome: 'storage_unavailable',
        reason: 'outbound_messages_missing',
        pg_code: code,
      });
      return 'storage_unavailable';
    }

    logger.warn('acknowledgement not recorded', {
      ...base,
      outcome: 'record_failed',
      reason: 'insert_failed',
      pg_code: code,
      duration_ms: Date.now() - startedAt,
    });
    return 'record_failed';
  }

  if (!inserted) {
    // No row and no error: nothing was claimed, so nothing may be sent.
    logger.warn('acknowledgement not recorded', {
      ...base,
      outcome: 'record_failed',
      reason: 'insert_returned_no_row',
      duration_ms: Date.now() - startedAt,
    });
    return 'record_failed';
  }

  const outboundId = inserted.id;
  const adapter = options.adapter ?? whatsappOutbound();

  let providerMessageId: string;
  try {
    const result = await adapter.sendText({
      to: request.toIdentifier,
      body,
      idempotencyKey: acknowledgementIdempotencyKey(request.externalMessageId),
    });
    providerMessageId = result.messageId;
  } catch (cause) {
    // `OutboundSendError.reason` is a closed list precisely so that it can be logged;
    // an arbitrary error's message could echo the request, including the body.
    const reason = cause instanceof OutboundSendError ? cause.reason : 'send_threw';

    await markOutbound(agentic, logger, base, outboundId, { status: 'failed' });

    logger.warn('acknowledgement send failed', {
      ...base,
      outcome: 'send_failed',
      reason,
      status_code: cause instanceof OutboundSendError ? cause.statusCode : null,
      duration_ms: Date.now() - startedAt,
    });
    return 'send_failed';
  }

  await markOutbound(agentic, logger, base, outboundId, {
    status: 'sent',
    provider_message_id: providerMessageId,
    sent_at: new Date().toISOString(),
  });

  logger.info('acknowledgement sent', {
    ...base,
    outcome: 'sent',
    reason: 'matched',
    duration_ms: Date.now() - startedAt,
  });
  return 'sent';
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Writes the delivery outcome back to the row. Swallows its own failure.
 *
 * The send has already happened or already failed by the time this runs, and neither of
 * those is undone by a database error here. A `queued` row left behind by a failed
 * update is a reporting inaccuracy; the index still prevents a second send, so it is not
 * a safety one. It is logged so the inaccuracy is discoverable.
 */
async function markOutbound(
  agentic: ReturnType<typeof asAgenticClient>,
  logger: Logger,
  base: Record<string, unknown>,
  outboundId: string,
  patch: { status: 'sent' | 'failed'; provider_message_id?: string; sent_at?: string },
): Promise<void> {
  const { error } = await agentic.from('outbound_messages').update(patch).eq('id', outboundId);

  if (error) {
    logger.warn('acknowledgement status not recorded', {
      ...base,
      outcome: 'record_failed',
      reason: 'status_update_failed',
      status: patch.status,
      pg_code: pgCode(error),
    });
  }
}
