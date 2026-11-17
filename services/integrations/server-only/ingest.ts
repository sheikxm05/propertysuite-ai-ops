/**
 * Ingestion: the idempotency gate, the normalised row, and the handoff to the queue.
 *
 * The claim this module makes is narrow and testable: **an at-least-once delivery
 * channel produces exactly-once effects, and the thing that guarantees it is a database
 * constraint, not this code.**
 *
 * Meta's webhook is at-least-once by design. It retries on a timeout, on a non-200, and
 * on a response it did not like, for up to several days. So a correct handler is not one
 * that is never called twice — it is one for which being called twice is indistinguishable
 * from being called once. There are two well-known ways to attempt that:
 *
 *   check-then-act   `select … where event_id = ?`, and insert if absent. **Wrong.**
 *                    Two concurrent retries both run the select, both see nothing, and
 *                    both insert. The window is small and Meta's retry pattern is
 *                    precisely the thing that finds small windows.
 *   let it conflict  issue the insert unconditionally and read `23505` as "already
 *                    processed". The unique index does the arbitration, inside one
 *                    atomic statement, with no window at all.
 *
 * This module does the second. `recordWebhookEvent` never asks whether an event exists;
 * it inserts, and interprets the failure. That is why `unique (provider, event_id)` on
 * `public.webhook_events` is the load-bearing part of the design and this file is
 * mostly interpretation.
 *
 * **Two constraints, deliberately redundant.** `webhook_events (provider, event_id)`
 * stops a duplicate *delivery* from being processed twice.
 * `inbound_messages.external_message_id` stops any path at all — a replay, a future
 * backfill, a second integration — from creating a second row for one message. They
 * carry the same value (the `wamid`), so under normal operation the second never fires.
 * It is there for the day something other than this function writes that table.
 *
 * **The response is fast because the work is not done here.** Three single-row writes
 * and an enqueue, then 200. Sender resolution, classification and anything that calls a
 * model happen in the job. A webhook that does slow work inline is retried by Meta while
 * it is still working, which turns one slow request into several concurrent ones.
 *
 * Logging: provider, event id (as `entity_id` — the logger's allowlist has no
 * `event_id`), outcome, duration. Never `body`, never the sender's number.
 */

import 'server-only';

import type { Json } from '@shared/index';
import type { Logger } from '@/lib/observability/logger';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';
import { enqueueJob } from '@/services/workers';

import { WHATSAPP_PROVIDER } from '../whatsapp/constants';
import type { NormalisedInboundMessage } from '../whatsapp/payload';
import {
  UNDEFINED_TABLE,
  UNIQUE_VIOLATION,
  asAgenticClient,
  pgCode,
  type InboundMessageInsert,
} from './agentic-tables';
import { WHATSAPP_INBOUND_JOB_TYPE, whatsappInboundIdempotencyKey } from './inbound-job';

/* ------------------------------------------------------------------ types -- */

/** What happened to one message id. Every value is safe to log and to count. */
export type EventOutcome =
  'accepted' | 'duplicate' | 'unsupported' | 'storage_unavailable' | 'write_failed';

export interface IngestedEvent {
  readonly eventId: string;
  readonly outcome: EventOutcome;
}

export interface IngestResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly unsupported: number;
  readonly failed: number;
  readonly events: readonly IngestedEvent[];
}

export class WebhookStorageUnavailableError extends Error {
  constructor(readonly pgCodeValue: string) {
    super('webhook idempotency storage is unavailable');
    this.name = 'WebhookStorageUnavailableError';
  }
}

/* ------------------------------------------------------- the dedupe gate -- */

export type RecordOutcome = 'recorded' | 'duplicate';

/**
 * Claims an event id, or reports that it was already claimed.
 *
 * Insert-first. There is no pre-flight read, and adding one would be a regression
 * however harmless it looks: the whole guarantee lives in the index, and a read before
 * the write only creates the race it appears to prevent.
 *
 * `42P01` (undefined table) is separated out because it means migration 0004 has not
 * been applied, which is an operational state rather than a duplicate. Treating a
 * missing table as "already processed" would make the endpoint silently discard every
 * delivery with a cheerful 200 — the worst available failure mode for a channel whose
 * sender gives up after a few days of success responses.
 */
export async function recordWebhookEvent(
  client: PrivilegedSupabaseClient,
  params: { readonly provider: string; readonly eventId: string; readonly payload?: Json },
): Promise<RecordOutcome> {
  const { error } = await asAgenticClient(client)
    .from('webhook_events')
    .insert({
      provider: params.provider,
      event_id: params.eventId,
      received_at: new Date().toISOString(),
      // The raw envelope is NOT stored. It contains the message body, and a ledger whose
      // purpose is deduplication has no business holding a second copy of tenant content
      // (CLAUDE.md rule 8). `inbound_messages.body` is the single home for that text.
      //
      // `{}` and NOT `null`: the column is `not null default '{}'::jsonb`, and a default
      // applies only when the key is OMITTED. Sending an explicit null is a 23502, which
      // is what this did for every real Meta delivery -- the signature verified, the
      // handler reported `accepted`, and then the idempotency ledger silently refused the
      // row. Caught against a live delivery; no simulated path reached it, because the
      // simulator always supplies a payload.
      payload: params.payload ?? {},
    });

  if (!error) return 'recorded';

  const code = pgCode(error);
  if (code === UNIQUE_VIOLATION) return 'duplicate';
  if (code === UNDEFINED_TABLE) throw new WebhookStorageUnavailableError(code);
  throw new WebhookIngestError('webhook_event_insert_failed', code, { cause: error });
}

export class WebhookIngestError extends Error {
  readonly reason: string;
  readonly pgCodeValue: string;

  constructor(reason: string, pgCodeValue: string, options: { cause?: unknown } = {}) {
    super(
      `webhook ingest failed: ${reason}`,
      options.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'WebhookIngestError';
    this.reason = reason;
    this.pgCodeValue = pgCodeValue;
  }
}

/* --------------------------------------------------------------- the row -- */

/**
 * Writes the normalised message.
 *
 * `status: 'received'` and `organization_id: null` are the only honest initial values:
 * at this instant nobody has resolved who sent it, and a column that will shortly hold
 * an organization id must not be populated with a provisional one. The job moves it to
 * `classified` or `unmatched`.
 *
 * A `23505` here means the `webhook_events` gate was bypassed or lost — the second
 * constraint firing. It is reported as a duplicate, not an error: the row already
 * exists, which is the state the caller wanted.
 */
export async function insertInboundMessage(
  client: PrivilegedSupabaseClient,
  message: NormalisedInboundMessage,
): Promise<{ readonly id: string | null; readonly duplicate: boolean }> {
  const row: InboundMessageInsert = {
    provider: WHATSAPP_PROVIDER,
    external_message_id: message.eventId,
    from_identifier: message.fromIdentifier,
    body: message.body,
    received_at: message.receivedAt,
    status: 'received',
    organization_id: null,
    ticket_id: null,
  };

  const { data, error } = await asAgenticClient(client)
    .from('inbound_messages')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (!error) return { id: data?.id ?? null, duplicate: false };

  const code = pgCode(error);
  if (code === UNIQUE_VIOLATION) return { id: null, duplicate: true };
  if (code === UNDEFINED_TABLE) throw new WebhookStorageUnavailableError(code);
  throw new WebhookIngestError('inbound_message_insert_failed', code, { cause: error });
}

/* ---------------------------------------------------------------- ingest -- */

export interface IngestOptions {
  readonly client: PrivilegedSupabaseClient;
  readonly logger: Logger;
  /** Text messages, already flattened out of the delivery envelope. */
  readonly messages: readonly NormalisedInboundMessage[];
  /** Every message id in the delivery, including types with no text. */
  readonly allEventIds: readonly string[];
  /** Correlation id, carried into the job payload so the trace survives the handoff. */
  readonly requestId: string;
}

/**
 * Processes one delivery.
 *
 * Order per message, and the order matters:
 *
 *   1. claim the event id        — a duplicate stops here, having changed nothing
 *   2. insert the normalised row — fails closed; the claim stays, see below
 *   3. enqueue the job           — idempotent on its own key
 *
 * A crash between 1 and 2 leaves a claimed event with no row, and Meta's retry will be
 * reported as a duplicate — one message lost. The alternative ordering loses more: a row
 * with no claim means every retry inserts again and the unique index on
 * `external_message_id` becomes the only thing standing between us and duplicate
 * tickets. Given a choice between "one message needs a resend" and "a tenant's request
 * appears five times", the first is the better failure, and it is the rarer one.
 *
 * Nothing in this loop throws past a single message: one bad row must not cause a
 * non-200, because a non-200 asks Meta to redeliver the whole batch including the
 * messages that succeeded. Per-message failures are counted and reported instead.
 */
export async function ingestDelivery(options: IngestOptions): Promise<IngestResult> {
  const { client, logger, messages, allEventIds, requestId } = options;

  const byEventId = new Map(messages.map((message) => [message.eventId, message]));
  const events: IngestedEvent[] = [];

  let accepted = 0;
  let duplicates = 0;
  let unsupported = 0;
  let failed = 0;

  for (const eventId of allEventIds) {
    const startedAt = Date.now();
    let outcome: EventOutcome;

    try {
      const claim = await recordWebhookEvent(client, {
        provider: WHATSAPP_PROVIDER,
        eventId,
      });

      if (claim === 'duplicate') {
        outcome = 'duplicate';
        duplicates += 1;
      } else {
        const message = byEventId.get(eventId);
        if (!message) {
          // Acknowledged and deduplicated, but not stored: an image or a voice note.
          // The claim is what stops Meta's retries of it being treated as new work.
          outcome = 'unsupported';
          unsupported += 1;
        } else {
          const inserted = await insertInboundMessage(client, message);
          await enqueueInboundJob(client, { eventId, requestId });
          outcome = inserted.duplicate ? 'duplicate' : 'accepted';
          if (inserted.duplicate) duplicates += 1;
          else accepted += 1;
        }
      }
    } catch (thrown) {
      if (thrown instanceof WebhookStorageUnavailableError) throw thrown;
      outcome = 'write_failed';
      failed += 1;
      logger.error('webhook event ingest failed', {
        provider: WHATSAPP_PROVIDER,
        entity_id: eventId,
        entity_type: 'webhook_event',
        outcome,
        duration_ms: Date.now() - startedAt,
        reason: thrown instanceof WebhookIngestError ? thrown.reason : 'unexpected',
        pg_code: thrown instanceof WebhookIngestError ? thrown.pgCodeValue : 'unknown',
      });
    }

    events.push({ eventId, outcome });

    if (outcome !== 'write_failed') {
      logger.info('webhook event ingested', {
        provider: WHATSAPP_PROVIDER,
        entity_id: eventId,
        entity_type: 'webhook_event',
        outcome,
        duration_ms: Date.now() - startedAt,
      });
    }
  }

  return { accepted, duplicates, unsupported, failed, events };
}

/**
 * Hands the message to the existing queue.
 *
 * `services/workers/**` is read-only to this lane, so nothing there is modified: the
 * job type and its handler are exported from this lane and registered by the caller.
 * The idempotency key is derived from the `wamid`, so an enqueue that is somehow issued
 * twice resolves to one job through `jobs.idempotency_key`'s unique index — the same
 * technique as the webhook gate, one layer down.
 */
export async function enqueueInboundJob(
  client: PrivilegedSupabaseClient,
  params: { readonly eventId: string; readonly requestId: string },
): Promise<void> {
  await enqueueJob(client, {
    type: WHATSAPP_INBOUND_JOB_TYPE,
    idempotencyKey: whatsappInboundIdempotencyKey(params.eventId),
    payload: {
      provider: WHATSAPP_PROVIDER,
      // The message id, not the message. The job re-reads the row it needs; a payload
      // carrying the body would put tenant content in a table nothing redacts.
      external_message_id: params.eventId,
      request_id: params.requestId,
    },
  });
}
