/**
 * Status and priority chips for the maintenance surfaces.
 *
 * The colour decision no longer lives here. It lives in `components/ui/status.ts`, the
 * single table that maps every domain status in the product onto a semantic badge
 * variant — because this file used to hold one of six separate mappings and the meanings
 * had drifted: amber meant "a human still has to decide" on the ticket screens and
 * something else on the document ones. Colour that means different things on different
 * pages teaches the reader a rule and then breaks it.
 *
 * The maps there are keyed by the enums in `packages/shared`, so adding a status without
 * colouring it is still a compile error rather than an invisible grey chip — the
 * property this file was written to protect, kept, just one level up.
 *
 * What stays here is the maintenance-specific rendering: the two chip components and the
 * category label, which are what the ticket screens actually import.
 */

import { Badge } from '@/components/ui/badge';
import { TICKET_PRIORITY_STYLE, TICKET_STATUS_STYLE } from '@/components/ui/status';
import {
  MAINTENANCE_CATEGORY_LABELS,
  type MaintenanceCategory,
  type TicketPriority,
  type TicketStatus,
} from '@shared/index';

export function StatusBadge({ status }: { status: TicketStatus }) {
  const style = TICKET_STATUS_STYLE[status];
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const style = TICKET_PRIORITY_STYLE[priority];
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

/** Category labels come from `MAINTENANCE_CATEGORY_LABELS` in `packages/shared`. */
export function CategoryLabel({ category }: { category: MaintenanceCategory }) {
  return (
    <span className="text-sm text-muted-foreground">{MAINTENANCE_CATEGORY_LABELS[category]}</span>
  );
}

export function statusLabel(status: TicketStatus): string {
  return TICKET_STATUS_STYLE[status].label;
}

export function priorityLabel(priority: TicketPriority): string {
  return TICKET_PRIORITY_STYLE[priority].label;
}
