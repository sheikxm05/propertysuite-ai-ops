/**
 * The `whatsapp_inbound` job handler: resolve the sender, then stop.
 *
 * This runs after the webhook has already returned 200. That split is the point — the
 * webhook's budget is three writes and an acknowledgement, and everything that could be
 * slow or could fail lives out here where a failure is a retry rather than a
 * redelivery storm.
 *
 * **What it does.** Reads the `inbound_messages` row by its `external_message_id`, asks
 * `resolveSender` who owns the number, and writes `classified` + `organization_id`, or
 * `unmatched` + nothing. On `classified` — and only then — it sends the tenant a fixed
 * acknowledgement over WhatsApp. That is the whole handler.
 *
 * **The acknowledgement is not an exception to rule 7.** It is a constant string with
 * no tenant data in it, produced by a pure function with no model anywhere near it, and
 * it is sent only when the sender resolved to exactly one tenant in exactly one
 * organization. An `unmatched` or `ambiguous_sender` message is never answered. The
 * full argument is at the top of `acknowledgement.ts` and `../whatsapp/acknowledgement.ts`;
 * the AI-drafted reply a human reviews is a different kind, on a different path, in a
 * different lane.
 *
 * `classified` reads oddly for a handler that runs no classifier, and the name is the
 * orchestrator's frozen one rather than this lane's: `inbound_messages.status` is a
 * single column shared with the inbox, and 0004's CHECK constraint is the arbiter. What
 * it means here is "the sender resolved; this message is attributable to one
 * organization and is waiting for a human" — which is the state the inbox needs to
 * render, whatever produced it.
 *
 * **What it deliberately does not do, and must not be extended to do.** It does not
 * create a maintenance ticket. A WhatsApp message is an unauthenticated stranger's text
 * — the number is self-asserted and the content is uncontrolled — and CLAUDE.md rule 7
 * says no model output reaches a mutation without an authenticated human confirmation
 * in between. The inbox (lane w3-l7) is that confirmation: a staff member reads the
 * message, agrees it is a maintenance request, and *they* create the ticket, at which
 * point the row moves to `linked` with a `ticket_id`. A handler that created the ticket
 * itself would make an inbound message a write primitive for anyone who can guess a
 * tenant's phone number.
 *
 * That is also why this handler writes only three of the six frozen statuses —
 * `received` (by the webhook), `classified` and `unmatched`. `linked` and `ignored`
 * both record a person's decision, and nothing running without `auth.uid()` should be
 * able to reach a state that claims a human made one.
 *
 * **Why it is safe for this to use a service-role client.** It has to: a job has no
 * `auth.uid()`. The scoping burden lands on `resolveSender`, which derives an
 * organization from a matched `tenants` row and never from the job payload. The payload
 * carries one opaque message id and nothing that could steer the read.
 *
 * **Registration.** `services/workers/**` is read-only to this lane, so
 * `createDefaultRegistry()` does not know about this handler. The caller registers it:
 *
 *     new JobHandlerRegistry()
 *       .register(createDocumentExtractionHandler())
 *       .register(createWhatsAppInboundHandler());
 *
 * That is reported as a planning defect — the production registry should include it —
 * rather than fixed by editing another lane's file.
 */

import 'server-only';

import { z } from 'zod';

import type { JobType } from '@shared/index';
import { PermanentJobError, RetryableJobError } from '@/services/workers';
import type { JobHandler, JobHandlerContext } from '@/services/workers';

import { WHATSAPP_PROVIDER, type InboundMessageStatus } from '../whatsapp/constants';
import { sendAcknowledgement } from './acknowledgement';
import { asAgenticClient, pgCode, UNDEFINED_TABLE } from './agentic-tables';
import { resolveSender } from './sender-resolution';

/**
 * `jobs.type` for this handler.
 *
 * PLANNING DEFECT, reported: `JOB_TYPES` in `packages/shared/constants/statuses.ts`
 * contains only `document_extraction`, and `packages/shared/**` belongs to w0-l4. The
 * cast is the narrowest possible expression of "this value belongs on the frozen list
 * and is not on it yet" — it appears exactly once, here, so adding the literal to
 * `JOB_TYPES` makes it redundant and nothing else moves.
 *
 * `jobs.type` is plain `text` in `0003` with no check constraint, so the database
 * accepts the value today; this is a typing gap, not a schema one.
 */
export const WHATSAPP_INBOUND_JOB_TYPE = 'whatsapp_inbound' as JobType;

/**
 * The payload: one opaque message id, the provider, and the correlation id.
 *
 * `.strict()` because a job payload is read by a handler holding a service-role client,
 * and the discipline that keeps that safe is that the payload can express almost
 * nothing. There is no organization id here — not even as a cross-check — because at
 * enqueue time nobody had resolved one, and a field that is sometimes authoritative and
 * sometimes absent is worse than no field.
 */
export const WhatsAppInboundPayloadSchema = z
  .object({
    provider: z.literal(WHATSAPP_PROVIDER),
    external_message_id: z.string().min(1).max(256),
    request_id: z.string().min(1).max(64).optional(),
  })
  .strict();

export type WhatsAppInboundPayload = z.infer<typeof WhatsAppInboundPayloadSchema>;

/** The exactly-once key. Derived from the `wamid`, so a re-enqueue collapses to one job. */
export function whatsappInboundIdempotencyKey(externalMessageId: string): string {
  return `whatsapp_inbound:${externalMessageId}`;
}

/* --------------------------------------------------------------- handler -- */

export function createWhatsAppInboundHandler(): JobHandler {
  return {
    type: WHATSAPP_INBOUND_JOB_TYPE,
    run: runWhatsAppInboundJob,
  };
}

export async function runWhatsAppInboundJob(context: JobHandlerContext): Promise<void> {
  const { job, client, logger } = context;

  const parsed = WhatsAppInboundPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // The same bytes will fail the same way on every attempt.
    throw new PermanentJobError('payload_invalid');
  }
  const externalMessageId = parsed.data.external_message_id;

  const agentic = asAgenticClient(client);

  const { data: message, error: readError } = await agentic
    .from('inbound_messages')
    .select('id, from_identifier, status, organization_id')
    .eq('provider', WHATSAPP_PROVIDER)
    .eq('external_message_id', externalMessageId)
    .maybeSingle();

  if (readError) {
    if (pgCode(readError) === UNDEFINED_TABLE) throw new PermanentJobError('payload_invalid');
    throw new RetryableJobError('database_write_failed', { cause: readError });
  }

  if (!message) {
    // The webhook claims the event id before it writes the row, so a crash in between
    // leaves a job pointing at nothing. Permanent: the row will never appear, because
    // Meta's retry of that delivery is now deduplicated away.
    throw new PermanentJobError('payload_invalid');
  }

  // Already resolved by an earlier attempt, or already acted on by a human.
  // Re-resolving would be harmless for `classified`/`unmatched` and actively wrong for
  // `linked` and `ignored`, where a staff member's decision is recorded. Idempotent exit.
  if (message.status !== 'received') {
    logger.info('inbound message already resolved', {
      provider: WHATSAPP_PROVIDER,
      entity_id: externalMessageId,
      entity_type: 'inbound_message',
      status: message.status,
      outcome: 'already_resolved',
      job_id: job.id,
    });
    return;
  }

  const startedAt = Date.now();
  const resolution = await resolveSender(client, message.from_identifier);

  if (!resolution.matched && resolution.reason === 'lookup_failed') {
    // A database problem, not a verdict. Retrying is correct; recording `unmatched`
    // would turn a transient outage into a permanent misattribution-by-omission.
    throw new RetryableJobError('database_write_failed');
  }

  // The two statuses this handler is entitled to write. Typed through
  // `InboundMessageStatus` rather than as bare literals, so that if 0004's CHECK
  // constraint moves again the mismatch is a compile error here instead of a 23514 at
  // three in the morning.
  const patch: { status: InboundMessageStatus; organization_id: string | null } = resolution.matched
    ? { status: 'classified', organization_id: resolution.organizationId }
    : { status: 'unmatched', organization_id: null };

  const { data: updated, error: updateError } = await agentic
    .from('inbound_messages')
    .update(patch)
    .eq('id', message.id)
    // Compare-and-swap on the status we read. If a human linked the message to a ticket
    // or ignored it while resolution was running, this matches zero rows and their
    // decision stands — the same technique `services/workers/job-queue.ts` uses for a
    // claim.
    .eq('status', 'received')
    // The affected rows, so the acknowledgement below can be conditioned on "this
    // attempt is the one that classified the message" rather than merely on "resolution
    // succeeded". Without it, a lost race would still produce a reply.
    .select('id');

  if (updateError) {
    throw new RetryableJobError('database_write_failed', { cause: updateError });
  }

  const applied = (updated ?? []).length > 0;

  // --------------------------------------------------------- acknowledgement --
  //
  // The one thing this handler sends to a human being, and the conditions are narrow by
  // design: exactly one tenant matched, and this attempt is the one that wrote
  // `classified`. The body is a fixed string with no tenant data in it and no model
  // anywhere near it — see `acknowledgement.ts` for why that keeps CLAUDE.md rule 7
  // satisfied, and for why an `unmatched` or `ambiguous_sender` message is never
  // answered.
  //
  // `sendAcknowledgement` does not throw, and the `catch` is a belt on top of that
  // brace. A failed acknowledgement must not fail the job: the message is already
  // stored and already attributed, and failing here would retry into an early exit,
  // leaving a failed job AND no acknowledgement.
  //
  // Its outcome is not folded into the line below: `sendAcknowledgement` emits its own
  // line through this same logger, so it carries the same `request_id` and the trace is
  // already joined up, without inventing a log field the allowlist would drop.
  if (resolution.matched && resolution.reason === 'matched' && applied) {
    try {
      await sendAcknowledgement(client, logger, {
        inboundMessageId: message.id,
        externalMessageId,
        organizationId: resolution.organizationId,
        tenantId: resolution.tenantId,
        toIdentifier: message.from_identifier,
      });
    } catch {
      // Deliberately swallowed and deliberately not given the error: an unexpected
      // throw from the send path could carry provider text that echoes the body.
      logger.warn('acknowledgement threw', {
        provider: WHATSAPP_PROVIDER,
        entity_id: externalMessageId,
        entity_type: 'outbound_message',
        organization_id: resolution.organizationId,
        outcome: 'send_failed',
        reason: 'unexpected_throw',
      });
    }
  }

  logger.info('inbound message resolved', {
    provider: WHATSAPP_PROVIDER,
    entity_id: externalMessageId,
    entity_type: 'inbound_message',
    status: patch.status,
    // `organization_id` is allowlisted and is an opaque uuid. It is the one field that
    // makes an isolation failure visible in a log; `from_identifier` never appears.
    organization_id: resolution.matched ? resolution.organizationId : null,
    reason: resolution.reason,
    // `superseded` when the compare-and-swap matched no row — a human reached the
    // message first and their decision stands. Reporting `classified` in that case
    // would claim a write that did not happen.
    outcome: applied ? (resolution.matched ? 'classified' : 'unmatched') : 'superseded',
    duration_ms: Date.now() - startedAt,
    job_id: job.id,
  });
}
