/**
 * Frozen constants for the WhatsApp Cloud API integration.
 *
 * Everything here is either dictated by Meta's wire contract (header names, the
 * `sha256=` prefix, the Graph host) or is a vocabulary this lane must pin down because
 * the table it describes is created by a concurrent lane. The latter are marked, and
 * every one of them appears in this lane's planning-defect report so that
 * `0004_agentic.sql` and `packages/shared` can adopt them rather than diverge.
 */

/** `webhook_events.provider` and `inbound_messages.provider` for this integration. */
export const WHATSAPP_PROVIDER = 'whatsapp' as const;

/** Graph API version the outbound adapter targets. */
export const WHATSAPP_GRAPH_VERSION = 'v21.0' as const;

/** Graph API host. Not configurable: a configurable API host is an exfiltration knob. */
export const WHATSAPP_GRAPH_HOST = 'https://graph.facebook.com' as const;

/** Meta's signature header. Lowercase — `Headers.get` is case-insensitive anyway. */
export const SIGNATURE_HEADER = 'x-hub-signature-256' as const;

/** Every value of that header is `sha256=` followed by lowercase hex. */
export const SIGNATURE_PREFIX = 'sha256=' as const;

/** Meta's verification-handshake query parameters. */
export const HUB_MODE_PARAM = 'hub.mode' as const;
export const HUB_VERIFY_TOKEN_PARAM = 'hub.verify_token' as const;
export const HUB_CHALLENGE_PARAM = 'hub.challenge' as const;

/** The only `hub.mode` Meta ever sends. */
export const HUB_SUBSCRIBE_MODE = 'subscribe' as const;

/**
 * The key used to verify a payload when no `WHATSAPP_APP_SECRET` is configured.
 *
 * This is **not a secret** and is deliberately a published constant. Simulated mode
 * exists so the signature path can be demonstrated without Meta business verification,
 * which takes days; pretending the key were secret would be a lie that someone would
 * eventually act on.
 *
 * What makes simulated mode safe is not this value — it is that:
 *
 *  - a configured `WHATSAPP_APP_SECRET` always wins, so a real deployment never reaches
 *    this constant (`resolveWebhookMode`);
 *  - `NODE_ENV=production` with no app secret is a hard failure, not a downgrade;
 *  - the *code path* is identical. The same HMAC, the same `timingSafeEqual`, the same
 *    rejection of an absent or malformed header. Only the key's provenance differs, so
 *    a green simulated run is evidence about the live path rather than a substitute for
 *    it.
 */
export const SIMULATED_SIGNING_KEY = 'propertysuite-simulated-whatsapp-app-secret' as const;

/** The verify token accepted by the handshake when `WHATSAPP_VERIFY_TOKEN` is absent. */
export const SIMULATED_VERIFY_TOKEN = 'propertysuite-simulated-verify-token' as const;

/**
 * `inbound_messages.status`.
 *
 * FROZEN BY THE ORCHESTRATOR, and enforced by a CHECK constraint in
 * `0004_agentic.sql`. This lane originally pinned `received | matched | unmatched |
 * converted`; w3-l7 independently pinned an overlapping-but-different set, which is
 * exactly the kind of collision a six-lane wave is supposed to surface rather than
 * discover at runtime. The orchestrator reconciled the two into the six below and
 * amended 0004. `matched` and `converted` are **not** in the constraint, so the writer
 * in `inbound-job.ts` was remapped onto `classified` and `linked`; an insert using the
 * old names would have been rejected by Postgres.
 *
 *   received    accepted at the webhook; sender resolution has not run yet
 *   unmatched   resolution ran and refused to guess — zero matches, or more than one
 *   classified  the sender resolved to exactly one tenant; nothing has been created
 *   linked      a human confirmed it and a maintenance ticket exists (`ticket_id` set)
 *   ignored     a human decided it needs no action
 *   failed      ingestion or resolution could not complete
 *
 * `unmatched` earned its own state rather than collapsing into `ignored` because the
 * two mean opposite things. `ignored` is a human decision that a message needs no
 * action. `unmatched` is the isolation boundary working: a number nobody recognises
 * must surface in the inbox unattributed, because silently attaching it to the
 * closest-looking tenant would cross the boundary this project exists to defend.
 *
 * This lane writes exactly three of the six — `received`, `classified`, `unmatched`.
 * `linked` and `ignored` are w3-l7's to write, behind a human action; `failed` belongs
 * to whichever path gives up. A background job must not be able to reach a state that
 * represents a person's decision.
 */
export const INBOUND_MESSAGE_STATUSES = [
  'received',
  'unmatched',
  'classified',
  'linked',
  'ignored',
  'failed',
] as const;

export type InboundMessageStatus = (typeof INBOUND_MESSAGE_STATUSES)[number];

/**
 * `outbound_messages.kind`.
 *
 * FROZEN BY THE ORCHESTRATOR alongside migration 0006, and the distinction is the
 * security-relevant one in the whole outbound half of the lane:
 *
 *   acknowledgement  a fixed string this lane sends automatically on receipt. No model
 *                    is involved, no human is involved, and it contains no tenant data.
 *   staff_reply      free text a human wrote or approved. Sent by the API lane, by an
 *                    authenticated person, with a `sent_by_profile_id`.
 *
 * The two must never share a code path, because the thing that makes the first one safe
 * to send without a human is precisely that it cannot say anything.
 */
export const OUTBOUND_MESSAGE_KINDS = ['acknowledgement', 'staff_reply'] as const;

export type OutboundMessageKind = (typeof OUTBOUND_MESSAGE_KINDS)[number];

/**
 * `outbound_messages.drafted_by` — provenance of the text, kept separate from `kind`.
 *
 * `'ai'` exists so that a drafted reply is *recorded* as model output even after a human
 * approves and sends it. Collapsing it into `'human'` on send would erase the only
 * durable evidence that CLAUDE.md rule 7's confirmation step ever happened; the pair
 * (`drafted_by = 'ai'`, `sent_by_profile_id = <uuid>`) is what proves a person committed
 * a model's words.
 *
 * This lane writes `'system'` and nothing else.
 */
export const OUTBOUND_DRAFT_SOURCES = ['system', 'ai', 'human'] as const;

export type OutboundDraftSource = (typeof OUTBOUND_DRAFT_SOURCES)[number];

/**
 * `outbound_messages.status`.
 *
 *   queued  the row exists and claims the right to send; the provider has not been called
 *   sent    the provider accepted it and returned a message id
 *   failed  the provider refused or could not be reached. Terminal for this row.
 *
 * `queued` is written *before* the send rather than after, so the row — and the partial
 * unique index on `(inbound_message_id) where kind = 'acknowledgement'` — is what
 * arbitrates "has this already been sent?", in one atomic statement, the same way
 * `webhook_events (provider, event_id)` arbitrates duplicate deliveries inbound. See
 * `server-only/acknowledgement.ts`.
 */
export const OUTBOUND_MESSAGE_STATUSES = ['queued', 'sent', 'failed'] as const;

export type OutboundMessageStatus = (typeof OUTBOUND_MESSAGE_STATUSES)[number];

/** Largest webhook body accepted, before parsing. Meta's deliveries are far smaller. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/** Largest outbound text body the Cloud API accepts. */
export const MAX_OUTBOUND_TEXT_LENGTH = 4096;
