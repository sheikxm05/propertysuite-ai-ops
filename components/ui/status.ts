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
