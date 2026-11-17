/**
 * The Cloud API delivery envelope, and its reduction to rows this application stores.
 *
 * Two things shape the schema below.
 *
 * **It is permissive at the edges and strict at the centre.** Meta adds fields to this
 * envelope without notice and without a version bump, so a `.strict()` object would
 * turn a Meta product change into a wave of 4xx responses and, because Meta retries a
 * rejected delivery for days, a wave of them. Unknown keys are therefore ignored. The
 * fields this application actually *uses* — the message id, the sender, the body — are
 * validated exactly, because those are the ones a forged or malformed payload would
 * aim at.
 *
 * **It never reaches for anything it does not need.** `contacts[].profile.name` is in
 * every delivery and is deliberately not read: a WhatsApp display name is attacker
 * -chosen personal data, and the only thing this lane is entitled to infer from an
 * inbound message is which tenant, if any, owns the number it came from — which is
 * decided against `tenants.phone`, a row we control, not against a name the sender
 * typed.
 *
 * Nothing in this file logs. `body` is tenant content (CLAUDE.md rule 8) and the
 * normalised record carries it only as far as the `inbound_messages` row.
 */

import { z } from 'zod';

/** A WhatsApp message id (`wamid.…`). Opaque to us; the dedupe key. */
const MessageIdSchema = z.string().min(1).max(256);

/** A sender identifier: digits, no `+`, as the Cloud API sends it. */
const IdentifierSchema = z.string().min(3).max(32);

/**
 * One message. `type` is open because Meta ships new ones; `text.body` is the only
 * content this build understands and the rest are acknowledged without a row.
 */
const MessageSchema = z.object({
  id: MessageIdSchema,
  from: IdentifierSchema,
  /** Unix seconds, as a string. Meta sends it as a string; treat it as one. */
  timestamp: z.string().min(1).max(32).optional(),
  type: z.string().min(1).max(64).optional(),
  text: z.object({ body: z.string().max(65536) }).optional(),
});

/** A delivery receipt (sent/delivered/read). Counted, never stored. */
const StatusSchema = z.object({ id: z.string().min(1).max(256) });

const ChangeValueSchema = z.object({
  messaging_product: z.string().optional(),
  metadata: z
    .object({
      display_phone_number: z.string().optional(),
      phone_number_id: z.string().max(64).optional(),
    })
    .optional(),
  messages: z.array(MessageSchema).optional(),
  statuses: z.array(StatusSchema).optional(),
});

const ChangeSchema = z.object({
  field: z.string().optional(),
  value: ChangeValueSchema,
});

const EntrySchema = z.object({
  id: z.string().max(64).optional(),
  changes: z.array(ChangeSchema).optional(),
});

/**
 * The delivery.
 *
 * `object` is checked loosely rather than pinned to `whatsapp_business_account`: a
 * Meta-side product rename would otherwise take the endpoint down, and the value proves
 * nothing anyway — the signature already proved who sent it.
 */
export const WhatsAppDeliverySchema = z.object({
  object: z.string().max(128).optional(),
  entry: z.array(EntrySchema).max(100).optional(),
});

export type WhatsAppDelivery = z.infer<typeof WhatsAppDeliverySchema>;

/* ------------------------------------------------------------- normalised -- */

/**
 * One inbound text message, flattened out of the envelope.
 *
 * `eventId` is the `wamid`, and it is both the `webhook_events.event_id` and the
 * `inbound_messages.external_message_id`. Using the same value for both is what makes
 * the two unique constraints redundant *on purpose*: the first stops a duplicate
 * delivery from being processed twice, the second stops any other path from creating a
 * second row for one message.
 */
export interface NormalisedInboundMessage {
  readonly eventId: string;
  /** The sender's number, exactly as Meta sent it. Normalisation happens at match time. */
  readonly fromIdentifier: string;
  /** Tenant content. Never logged. */
  readonly body: string;
  /** ISO-8601. Derived from Meta's unix-seconds string, or the receive time. */
  readonly receivedAt: string;
  /** The business number the message arrived on, when Meta included it. */
  readonly phoneNumberId: string | null;
}

/** What a whole delivery reduces to. The counts are loggable; the messages are not. */
export interface NormalisedDelivery {
  readonly messages: readonly NormalisedInboundMessage[];
  /** Delivery receipts seen. Acknowledged, not stored. */
  readonly statusCount: number;
  /** Messages of a type this build does not store (image, audio, location, …). */
  readonly unsupportedCount: number;
}

/**
 * Flattens a validated delivery.
 *
 * Within one delivery Meta can repeat a `wamid` across entries when a webhook
 * subscription overlaps; duplicates are collapsed here so the batch presented to the
 * database is already distinct. The database's unique constraint remains the actual
 * guarantee — this only avoids making it do pointless work and, more usefully, keeps
 * the "accepted" count in the response honest.
 */
export function normaliseDelivery(
  delivery: WhatsAppDelivery,
  receivedAt: Date = new Date(),
): NormalisedDelivery {
  const messages: NormalisedInboundMessage[] = [];
  const seen = new Set<string>();
  let statusCount = 0;
  let unsupportedCount = 0;

  for (const entry of delivery.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      statusCount += value.statuses?.length ?? 0;
      const phoneNumberId = value.metadata?.phone_number_id ?? null;

      for (const message of value.messages ?? []) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);

        const body = message.text?.body;
        if (typeof body !== 'string') {
          // An image, a voice note, a location pin. Still gets a `webhook_events` row
          // from the caller, so Meta's retry of it is still deduplicated — it simply
          // produces no `inbound_messages` row, because there is no text to show and
          // this build will not invent a placeholder that reads like tenant content.
          unsupportedCount += 1;
          continue;
        }

        messages.push({
          eventId: message.id,
          fromIdentifier: message.from,
          body,
          receivedAt: toIsoTimestamp(message.timestamp, receivedAt),
          phoneNumberId,
        });
      }
    }
  }

  return { messages, statusCount, unsupportedCount };
}

/**
 * Every message id in a delivery, text or not.
 *
 * The dedupe gate is wider than the storage path on purpose: a delivery containing only
 * an image must still be recorded as seen, or Meta's retries of it would be accepted
 * forever and the endpoint would report "0 accepted" every time while doing fresh work
 * every time.
 */
export function deliveryEventIds(delivery: WhatsAppDelivery): readonly string[] {
  const ids = new Set<string>();
  for (const entry of delivery.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) ids.add(message.id);
    }
  }
  return [...ids];
}

/** Meta sends unix seconds as a string. Anything unparseable falls back to arrival. */
function toIsoTimestamp(timestamp: string | undefined, fallback: Date): string {
  if (typeof timestamp === 'string' && /^\d{1,13}$/.test(timestamp)) {
    const seconds = Number(timestamp);
    if (Number.isFinite(seconds) && seconds > 0) {
      const date = new Date(seconds * 1000);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return fallback.toISOString();
}
