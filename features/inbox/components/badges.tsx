/**
 * The inbox's chips, in one file so they cannot drift apart.
 *
 * Every variant here is semantic — `success`, `warning`, `secondary`, `outline`,
 * `destructive`. Not one colour class appears in this lane, because dark mode is driven
 * entirely by semantic tokens and a hard-coded `text-amber-600` is a chip that is
 * invisible on one of the two themes.
 *
 * The colour rule is the one `components/ui/status.ts` states: `warning` means a human
 * has not decided yet. That is why a classified message is amber and a committed one is
 * green, and why an unmatched sender is `outline` rather than `destructive` — nothing
 * has gone wrong, the system simply does not know this number, which is the isolation
 * boundary answering correctly.
 *
 * A plain server component: no state, no client bundle.
 */

import { Badge } from '@/components/ui/badge';

import {
  CHANNEL_STYLE,
  messageStatusStyle,
  type InboxChannel,
  type SenderMatch,
} from '../domain/view';

/** `inbound_messages.status`, as a chip. */
export function MessageStatusBadge({ status }: { status: string }) {
  const style = messageStatusStyle(status);
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

/** How the message arrived. The simulator is labelled, never disguised. */
export function ChannelBadge({ channel }: { channel: InboxChannel }) {
  const style = CHANNEL_STYLE[channel];
  return (
    <Badge variant={style.variant} title={style.description}>
      {style.label}
    </Badge>
  );
}

/**
 * Whether we know who sent this.
 *
 * The unmatched chip is the one a reviewer should look at twice, so it carries its own
 * explanation in the tooltip. It is NOT red: a number we cannot place is the expected
 * outcome for a stranger, and colouring it as an error would teach the reader that the
 * boundary failing closed is a malfunction.
 */
export function SenderBadge({ sender }: { sender: SenderMatch }) {
  if (!sender.matched) {
    return (
      <Badge
        variant="outline"
        title="No tenant in this organization has this number. Nothing is hidden from you here — there is no match to show."
      >
        Unmatched sender
      </Badge>
    );
  }
  return <Badge variant="secondary">{sender.tenantName}</Badge>;
}

/**
 * Which path the delivery actually took.
 *
 * `destructive` for the direct write, not `warning`. Amber in this product means a human
 * has not decided yet; a bypassed webhook is not an outstanding decision, it is a
 * failure of the thing the simulator exists to exercise. If this chip is red during a
 * demo, the demo is not showing what it claims to be showing.
 */
export function IngestionBadge({ path }: { path: 'webhook' | 'direct' }) {
  if (path === 'webhook') {
    return (
      <Badge
        variant="success"
        title="Signed, verified and ingested by the production webhook handler."
      >
        Signed · webhook verified
      </Badge>
    );
  }
  return (
    <Badge
      variant="destructive"
      title="The webhook endpoint could not be reached, so the simulator wrote the row itself. Signature verification and the idempotency gate did NOT run."
    >
      Webhook bypassed — degraded
    </Badge>
  );
}
