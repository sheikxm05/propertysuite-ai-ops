/**
 * The automatic acknowledgement: its reference, and its one sentence.
 *
 * ===========================================================================
 * WHY THIS IS NOT A VIOLATION OF CLAUDE.md RULE 7
 * ===========================================================================
 *
 * Rule 7 says no model output reaches a mutation without an authenticated human
 * confirmation in between, and sending a WhatsApp message to a real person is exactly
 * such a mutation — it is irreversible and it lands on someone's phone.
 *
 * What makes this one permitted is that **no model is involved and no data is
 * disclosed**. `acknowledgementText` is a pure function of one opaque reference string.
 * It cannot be steered by the inbound message, it cannot interpolate a tenant's name, a
 * unit, an address or an amount, and it says nothing that would be a leak if the
 * attribution behind it turned out to be wrong. It is a receipt, not a reply.
 *
 * The AI-drafted reply is a different kind on a different code path
 * (`outbound_messages.kind = 'staff_reply'`, `drafted_by = 'ai'`), sent by an
 * authenticated person who read it first. The two must not converge. Specifically, this
 * file must never gain a parameter that carries tenant content — the moment the text is
 * a function of anything other than a reference, the reasoning above stops holding.
 *
 * The *decision* to send is in `server-only/acknowledgement.ts` and is gated on the
 * sender resolving to exactly one tenant. An `unmatched` or `ambiguous_sender` message
 * is never acknowledged: replying to a number nobody could attribute tells a stranger
 * they have reached a live property-management system, and in the ambiguous case it
 * would be replying on behalf of an organization we could not identify.
 *
 * Pure: no I/O, no configuration, no `server-only` import, so it is exported from the
 * lane barrel and is unit-testable without any environment at all.
 */

/** Prefix every reference carries, so a tenant quoting one is recognisably quoting one. */
export const ACKNOWLEDGEMENT_REFERENCE_PREFIX = 'MSG-';

/** Hex characters taken from the message id. Eight is one uuid group. */
const REFERENCE_SIGNIFICANT_CHARS = 8;

/**
 * A short, human-quotable handle for one inbound message.
 *
 * Derived from `inbound_messages.id` rather than invented, so that it needs no column,
 * no sequence and no second source of truth: the inbox lane can compute the identical
 * string from the row it is already rendering, and a staff member handed `MSG-7F3A9C21`
 * can find the row with a prefix match on the id.
 *
 * Not a key and not a secret. Eight hex characters is a conversational handle whose
 * collision probability inside one organization's inbox is negligible; the uuid remains
 * the identifier. A uuid prefix discloses nothing — it is random.
 *
 * Returns `null` for an id with fewer than eight usable hex characters, which cannot
 * happen for a `gen_random_uuid()` value and is therefore treated by the caller as "do
 * not send" rather than papered over with a placeholder.
 */
export function inboundMessageReference(inboundMessageId: string): string | null {
  if (typeof inboundMessageId !== 'string') return null;

  const hex = inboundMessageId.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < REFERENCE_SIGNIFICANT_CHARS) return null;

  return `${ACKNOWLEDGEMENT_REFERENCE_PREFIX}${hex.slice(0, REFERENCE_SIGNIFICANT_CHARS).toUpperCase()}`;
}

/**
 * The acknowledgement body. A reference and a reassurance, and nothing else.
 *
 * Exported for the API lane: a staff reply is composed elsewhere, but the two paths
 * share this adapter and this vocabulary, and a second hand-written copy of the
 * sentence is how the two drift until one of them says something it should not.
 *
 * Read the text back before changing it. Every clause is load-bearing by omission:
 * there is no name, no unit, no address, no amount, no restatement of what the tenant
 * said, and no promise of a time. "Someone from the property team" is deliberately
 * vaguer than the data we hold — naming the assignee would disclose staffing, and
 * quoting the request back would disclose the message to whoever actually holds that
 * number if the attribution were wrong.
 */
export function acknowledgementText(reference: string): string {
  return (
    `Thanks — we've received your message and logged it as ${reference}. ` +
    `Someone from the property team will follow up shortly.`
  );
}
