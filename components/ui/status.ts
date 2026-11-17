import type {
  MemberStatus,
  PropertyStatus,
  TenancyStatus,
  TicketPriority,
  TicketStatus,
  UnitStatus,
  VerificationStatus,
} from '@shared/index';

/**
 * `inbound_messages.status`, as frozen by the orchestrator and enforced by the CHECK
 * constraint in `0004_agentic.sql`.
 *
 * Imported rather than retyped: `services/integrations/whatsapp/constants.ts` is where
 * that vocabulary is pinned, and a second copy here would be exactly the drift this file
 * exists to end (CLAUDE.md rule 4). The import is `import type`, so it is erased at
 * compile time — this module still pulls in no runtime code beyond itself and is safe in
 * a client component.
 */
import type { InboundMessageStatus } from '@/services/integrations';

/**
 * The single table that turns a domain status into a colour.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `components/ui/badge.tsx` deliberately exposes *semantic* variants rather than
 * colours, on the reasoning that "status colour stays consistent across every surface".
 * In practice six lanes each picked their own mapping at their own call sites, and the
 * meanings drifted: a pending document is `warning` in one place and `secondary` in
 * another, "linked" is `success` here and `default` there. Colour that means different
 * things on different screens is worse than no colour, because the reader learns a rule
 * that then breaks.
 *
 * So the mapping lives here, once, keyed by the enums in `packages/shared`. Every map is
 * typed `Record<TheSharedEnum, …>`, which makes adding a status without colouring it a
 * compile error rather than an invisible grey chip.
 *
 * THE RULE THE COLOURS ENCODE
 * ---------------------------
 *   success      a terminal good state — the work is done and a human confirmed it
 *   warning      a human decision is outstanding — nobody has committed to this yet
 *   destructive  refused, terminated, or demanding attention now
 *   default      live and progressing under someone's ownership
 *   secondary    neutral, not yet started
 *   outline      inert — cancelled, archived, or simply absent
 *
 * `warning` is load-bearing for the product's central claim: AI drafts, humans commit.
 * Anything the model produced and no person has yet confirmed is amber, everywhere.
 *
 * This module is pure data plus one lookup helper, so it imports no React and is safe in
 * a server component, a client component and a test alike.
 */
export type StatusVariant =
  'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline';

export interface StatusStyle {
  readonly label: string;
  readonly variant: StatusVariant;
}

const freeze = <K extends string>(map: Record<K, StatusStyle>): Readonly<Record<K, StatusStyle>> =>
  Object.freeze(map);

/** `maintenance_tickets.status`. */
export const TICKET_STATUS_STYLE = freeze<TicketStatus>({
  open: { label: 'Open', variant: 'secondary' },
  assigned: { label: 'Assigned', variant: 'default' },
  in_progress: { label: 'In progress', variant: 'default' },
  awaiting_approval: { label: 'Awaiting approval', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
});

/** `maintenance_tickets.priority`. */
export const TICKET_PRIORITY_STYLE = freeze<TicketPriority>({
  low: { label: 'Low', variant: 'outline' },
  normal: { label: 'Normal', variant: 'secondary' },
  high: { label: 'High', variant: 'warning' },
  urgent: { label: 'Urgent', variant: 'destructive' },
});

/** `tenancies.status`. */
export const TENANCY_STATUS_STYLE = freeze<TenancyStatus>({
  draft: { label: 'Draft', variant: 'secondary' },
  active: { label: 'Active', variant: 'success' },
  expired: { label: 'Expired', variant: 'warning' },
  terminated: { label: 'Terminated', variant: 'destructive' },
});

/** `documents.verification_status` — the human-confirmation gate, rendered. */
export const VERIFICATION_STATUS_STYLE = freeze<VerificationStatus>({
  pending: { label: 'Awaiting verification', variant: 'warning' },
  verified: { label: 'Verified', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'destructive' },
});

/** `organization_members.status`. */
export const MEMBER_STATUS_STYLE = freeze<MemberStatus>({
  invited: { label: 'Invited', variant: 'warning' },
  active: { label: 'Active', variant: 'success' },
  disabled: { label: 'Disabled', variant: 'outline' },
});

/** `properties.status` — archiving is the only removal path, so it is inert, not red. */
export const PROPERTY_STATUS_STYLE = freeze<PropertyStatus>({
  active: { label: 'Active', variant: 'success' },
  archived: { label: 'Archived', variant: 'outline' },
});

/** `property_units.status`. */
export const UNIT_STATUS_STYLE = freeze<UnitStatus>({
  available: { label: 'Available', variant: 'secondary' },
  occupied: { label: 'Occupied', variant: 'success' },
  inactive: { label: 'Inactive', variant: 'outline' },
});

/* ---------------------------------------------------------------------------- */
/* Migration 0004 — the agentic surface                                          */
/* ---------------------------------------------------------------------------- */
/**
 * The three vocabularies below arrived with `supabase/migrations/0004_agentic.sql`,
 * after `packages/shared` was frozen, so — unlike every map above — their key types are
 * not `@shared/index` enums. `InboundMessageStatus` is imported from the lane that
 * pinned it; the two agent vocabularies had no type at all outside a feature folder, so
 * they are declared here, in the file every surface already imports its colours from.
 * They are tuples first and types second for the same reason the shared constants are:
 * `freeze<K>` over the derived union makes adding a seventh status without colouring it
 * a compile error. When the `packages/shared` freeze reopens, all three belong in
 * `packages/shared/constants/statuses.ts` and these declarations should be replaced by
 * imports — reported as a planning defect rather than worked around.
 */

/**
 * `inbound_messages.status`.
 *
 * `unmatched` is the one that needed deciding, and it is `warning`, not `destructive`
 * and not `outline`. A message arrived from a number that mapped to zero tenants or to
 * more than one, and the isolation boundary declined to attribute it — nothing failed
 * and nobody ignored anything, so red would teach the reader that a correct refusal is
 * a malfunction. But it is also not inert: the row is sitting unattributed until a
 * person says who sent it, which is precisely this file's definition of amber — "a human
 * decision is outstanding — nobody has committed to this yet".
 *
 * `ignored` is the genuinely inert one: a human looked at the message and decided it
 * needs no action. That distinction — refused-to-guess versus decided-not-to-act — is
 * why `0004` spends two states on them, and the colours have to keep it visible.
 */
export const MESSAGE_STATUS_STYLE = freeze<InboundMessageStatus>({
  received: { label: 'Received', variant: 'secondary' },
  unmatched: { label: 'Unmatched sender', variant: 'warning' },
  classified: { label: 'Sender resolved', variant: 'warning' },
  linked: { label: 'Ticket created', variant: 'success' },
  ignored: { label: 'Ignored', variant: 'outline' },
  failed: { label: 'Ingestion failed', variant: 'destructive' },
});

/** `agent_proposals.status` — the four values `0004`'s CHECK constraint admits. */
export const AGENT_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'executed'] as const;
export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number];

/** `agent_runs.status` — the four values `0004`'s CHECK constraint admits. */
export const AGENT_RUN_STATUSES = ['running', 'completed', 'failed', 'cancelled'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/**
 * `agent_proposals.status` — "AI drafts, humans commit", rendered.
 *
 * `pending` is the single most load-bearing chip in the product: a tool call the model
 * wants to make, which has done nothing and will do nothing until a person approves it.
 * It wears the same amber as an unverified document and a ticket awaiting approval,
 * because it is the same claim on the same reader. The label says so in the second
 * person — the proposal is not merely "open", it is waiting on whoever is looking at it.
 *
 * `approved` and `executed` are deliberately different labels on the same `success`
 * token: a human has committed in both cases, and the difference between "said yes" and
 * "and the action has since run" is a fact about the row, not a different verdict.
 * `rejected` is `destructive` because a person actively refused — unlike `unmatched`
 * above, red here is a decision, not a failure.
 */
export const AGENT_PROPOSAL_STATUS_STYLE = freeze<AgentProposalStatus>({
  pending: { label: 'Awaiting your decision', variant: 'warning' },
  approved: { label: 'Approved', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'destructive' },
  executed: { label: 'Carried out', variant: 'success' },
});

/**
 * `agent_runs.status`.
 *
 * A run is bookkeeping, not a decision: nothing consequential hangs off it, which is why
 * `running` is `default` — live and progressing under someone's ownership — rather than
 * amber. Amber in this application means a person owes an answer, and a run in flight
 * owes nobody anything. The proposals it produced are where the human decision lives.
 */
export const AGENT_RUN_STATUS_STYLE = freeze<AgentRunStatus>({
  running: { label: 'Running', variant: 'default' },
  completed: { label: 'Completed', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
});

/**
 * Remaining days on a tenancy, coloured by the same rule as everything else: inside the
 * notice window a renewal is an outstanding human decision (amber); past due or due
 * immediately it is urgent (red).
 */
export function expiryVariant(daysRemaining: number): StatusVariant {
  if (daysRemaining <= 14) return 'destructive';
  if (daysRemaining <= 60) return 'warning';
  return 'secondary';
}

/**
 * Narrowing lookup for the rare caller holding a `string` from an unvalidated boundary.
 * Returns `outline` and the raw value rather than throwing — a dashboard chip is the
 * wrong place to crash a page over an unexpected enum member.
 */
export function styleFor<K extends string>(
  table: Readonly<Record<K, StatusStyle>>,
  value: string,
): StatusStyle {
  return (
    (table as Readonly<Record<string, StatusStyle | undefined>>)[value] ?? {
      label: value.replace(/_/g, ' '),
      variant: 'outline',
    }
  );
}
