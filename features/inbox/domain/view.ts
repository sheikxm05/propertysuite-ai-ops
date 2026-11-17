/**
 * Row → screen. Everything the inbox renders is built here, once.
 *
 * Three decisions are encoded in this file rather than in the components:
 *
 * 1. **The snippet is built, never the body.** A list row shows the first 140
 *    characters of a message and the detail view shows all of it. Both come from here,
 *    so there is exactly one place where message text is truncated and exactly one
 *    place to check that it never reaches a logger (CLAUDE.md rule 8).
 *
 * 2. **"Unmatched" is computed, not read.** `inbound_messages.status` is the pipeline's
 *    own view of a row. Whether the sender maps to a tenant *in the viewer's
 *    organization* is a different question, and it is the one the demo turns on: an
 *    unknown number is the isolation boundary answering correctly, not an error. The
 *    match is resolved against the tenants the caller can already see, so a message is
 *    "matched" only when RLS would have let the viewer read that tenant anyway.
 *
 * 3. **Colour follows the one rule.** `warning` means a human has not decided yet —
 *    `components/ui/status.ts`'s stated rule, applied to a status enum that file does
 *    not know about because migration `0004` landed after it. Nothing here names a
 *    colour; every chip carries a semantic variant, because dark mode is driven
 *    entirely by semantic tokens.
 */

import type { StatusStyle, StatusVariant } from '@/components/ui/status';

import type { InboundMessageRow, InboundMessageStatus } from './wave-three';

/** Longest snippet shown in a list row. Enough to recognise, short enough to scan. */
const SNIPPET_LENGTH = 140;

/* ------------------------------------------------------------------ channel -- */

/** How a message reached us, as the inbox describes it. */
export type InboxChannel = 'whatsapp' | 'whatsapp_simulated' | 'other';

export interface ChannelStyle {
  readonly label: string;
  readonly variant: StatusVariant;
  readonly description: string;
}

/**
 * `inbound_messages.provider` is a free string written by the ingestion lane, so it is
 * classified rather than switched on. Anything containing `sim` is the simulator —
 * which is labelled honestly and never dressed up as a live WhatsApp delivery.
 */
export function channelOf(provider: string): InboxChannel {
  const value = provider.trim().toLowerCase();
  if (value.includes('sim')) return 'whatsapp_simulated';
  if (value.includes('whatsapp')) return 'whatsapp';
  return 'other';
}

export const CHANNEL_STYLE: Readonly<Record<InboxChannel, ChannelStyle>> = Object.freeze({
  whatsapp: {
    label: 'WhatsApp',
    variant: 'default',
    description: 'Delivered by Meta to the webhook and verified by signature.',
  },
  whatsapp_simulated: {
    label: 'WhatsApp · simulated',
    variant: 'secondary',
    description:
      'Injected by the in-app simulator through the same ingestion endpoint the live webhook posts to. The pipeline is real; only the carrier is not.',
  },
  other: {
    label: 'Other channel',
    variant: 'outline',
    description: 'An inbound channel this screen does not have a label for.',
  },
});

/* ------------------------------------------------------------------- status -- */

/**
 * `inbound_messages.status`, coloured by the rule in `components/ui/status.ts`.
 *
 * The six values are the ones the orchestrator froze and `0004`'s CHECK constraint
 * enforces — `received | unmatched | classified | linked | ignored | failed`. An earlier
 * draft of this file styled nine, four of which Postgres would have rejected outright;
 * they are gone, and the table is typed over `InboundMessageStatus` so adding a seventh
 * is a compile error rather than a grey chip nobody notices.
 *
 * That the map lives here rather than in `components/ui/status.ts` — which is the
 * single colour table for the application and where it belongs — is a planning defect
 * and is reported as one: that file is `components/ui/**`, read-only to this lane, and
 * `0004`'s vocabulary did not exist when it was written. The variants are taken from its
 * published rule rather than invented:
 *
 *   `warning`    a human decision is outstanding — nobody has committed to this yet
 *   `success`    a terminal good state, confirmed by a person
 *   `secondary`  neutral, not yet started
 *   `outline`    inert — no action needed, or nothing to act on
 *   `destructive` demanding attention now
 *
 * `unmatched` is `outline`, not `destructive`. A number nobody recognises is the
 * isolation boundary refusing to guess, which is the system working. Colouring it red
 * would teach the reader that a correct refusal is a malfunction.
 */
const MESSAGE_STATUS_STYLE: Readonly<Record<InboundMessageStatus, StatusStyle>> = Object.freeze({
  received: { label: 'Received', variant: 'secondary' },
  unmatched: { label: 'Unmatched sender', variant: 'outline' },
  classified: { label: 'Sender resolved · awaiting a human', variant: 'warning' },
  linked: { label: 'Ticket created', variant: 'success' },
  ignored: { label: 'Ignored by a human', variant: 'outline' },
  failed: { label: 'Ingestion failed', variant: 'destructive' },
});

/**
 * Tolerant lookup, because `status` arrives from the database as a plain `text` column.
 * An unrecognised value renders as itself in a neutral chip rather than crashing a page
 * or, worse, silently claiming a state the row is not in.
 */
export function messageStatusStyle(status: string): StatusStyle {
  return (
    (MESSAGE_STATUS_STYLE as Readonly<Record<string, StatusStyle | undefined>>)[status] ?? {
      label: status.replace(/_/g, ' '),
      variant: 'outline',
    }
  );
}

/* -------------------------------------------------------------------- match -- */

/** A tenant the caller is already entitled to see, reduced to what matching needs. */
export interface TenantDirectoryEntry {
  readonly id: string;
  readonly fullName: string;
  readonly phone: string | null;
  /** The unit on the tenant's current active tenancy, when there is exactly one. */
  readonly unit: { readonly id: string; readonly label: string } | null;
}

/** What the inbox could resolve about the sender, from rows the caller may read. */
export interface SenderMatch {
  readonly matched: boolean;
  readonly tenantId: string | null;
  readonly tenantName: string | null;
  readonly unitId: string | null;
  readonly unitLabel: string | null;
}

export const UNMATCHED: SenderMatch = Object.freeze({
  matched: false,
  tenantId: null,
  tenantName: null,
  unitId: null,
  unitLabel: null,
});

/**
 * Comparable form of a phone number.
 *
 * Digits only, last nine kept. A UAE mobile reaches us as `+971501234567`,
 * `00971501234567` or `0501234567` depending on who typed it, and all three are the
 * same subscriber; the national significant number is what they share. Nine rather than
 * the full number because the country code and the trunk zero are exactly the parts that
 * vary. Shorter than nine digits is not matched at all — a four-digit shortcode must not
 * collide with a real line.
 */
export function phoneKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

/** Index a directory by comparable phone. Later entries do not overwrite earlier ones. */
export function indexByPhone(
  tenants: readonly TenantDirectoryEntry[],
): ReadonlyMap<string, TenantDirectoryEntry> {
  const index = new Map<string, TenantDirectoryEntry>();
  for (const tenant of tenants) {
    const key = phoneKey(tenant.phone);
    if (key && !index.has(key)) index.set(key, tenant);
  }
  return index;
}

export function matchSender(
  fromIdentifier: string,
  directory: ReadonlyMap<string, TenantDirectoryEntry>,
): SenderMatch {
  const key = phoneKey(fromIdentifier);
  const tenant = key ? directory.get(key) : undefined;
  if (!tenant) return UNMATCHED;

  return {
    matched: true,
    tenantId: tenant.id,
    tenantName: tenant.fullName,
    unitId: tenant.unit?.id ?? null,
    unitLabel: tenant.unit?.label ?? null,
  };
}

/* --------------------------------------------------------------- view model -- */

export interface InboxMessageView {
  readonly id: string;
  readonly from: string;
  /** `from`, middle digits masked. What a list row shows. */
  readonly fromMasked: string;
  readonly channel: InboxChannel;
  readonly receivedAt: string;
  readonly status: string;
  readonly ticketId: string | null;
  readonly snippet: string;
  readonly truncated: boolean;
  readonly sender: SenderMatch;
}

/** The detail view adds the full text. Nothing else differs. */
export interface InboxMessageDetailView extends InboxMessageView {
  readonly body: string;
  readonly externalMessageId: string;
}

export function toMessageView(
  row: InboundMessageRow,
  directory: ReadonlyMap<string, TenantDirectoryEntry>,
): InboxMessageView {
  const body = row.body ?? '';
  return {
    id: row.id,
    from: row.from_identifier,
    fromMasked: maskIdentifier(row.from_identifier),
    channel: channelOf(row.provider),
    receivedAt: row.received_at,
    status: row.status,
    ticketId: row.ticket_id,
    snippet: body.length > SNIPPET_LENGTH ? `${body.slice(0, SNIPPET_LENGTH).trimEnd()}…` : body,
    truncated: body.length > SNIPPET_LENGTH,
    sender: matchSender(row.from_identifier, directory),
  };
}

export function toMessageDetailView(
  row: InboundMessageRow,
  directory: ReadonlyMap<string, TenantDirectoryEntry>,
): InboxMessageDetailView {
  return {
    ...toMessageView(row, directory),
    body: row.body ?? '',
    externalMessageId: row.external_message_id,
  };
}

/**
 * Masks the middle of a phone number for the list.
 *
 * The country code and the last two digits are enough for a manager to recognise a
 * number they already know, and not enough for a shoulder-surfer to write one down. The
 * detail view shows it in full, because that is where a human is deciding whether the
 * sender is who they claim to be.
 */
export function maskIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 6) return trimmed;
  const head = trimmed.slice(0, 4);
  const tail = trimmed.slice(-2);
  return `${head}${'•'.repeat(Math.max(3, trimmed.length - 6))}${tail}`;
}

/**
 * `received_at` as a Dubai-local, fixed-format string.
 *
 * Formatted on the server with an explicit locale and time zone so the markup the server
 * renders and the markup the browser would render are byte-identical. A bare
 * `toLocaleString()` produces a hydration mismatch on any machine not set to en-GB, and
 * the demo is recorded on one machine and reviewed on another.
 */
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatReceivedAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? '—' : `${TIMESTAMP_FORMAT.format(parsed)} GST`;
}
