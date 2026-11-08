/**
 * Status and priority chips.
 *
 * The colour decision lives here, once, rather than at each call site —
 * `components/ui/badge.tsx` deliberately exposes semantic variants ("Keep semantic names
 * here rather than colours at the call site, so status colour stays consistent across
 * every surface"). The two maps are keyed by the shared enums and typed
 * `Record<TicketStatus, ...>` / `Record<TicketPriority, ...>`, so adding a status to
 * `packages/shared` without colouring it here is a compile error rather than an
 * invisible grey chip.
 *
 * Labels are written out rather than derived from the enum value because
 * `awaiting_approval` should read "Awaiting approval" and `in_progress` "In progress" —
 * a `replace('_', ' ')` would also happily render a future enum member as nonsense.
 */

import { Badge } from '@/components/ui/badge';
import {
  MAINTENANCE_CATEGORY_LABELS,
  type MaintenanceCategory,
  type TicketPriority,
  type TicketStatus,
} from '@shared/index';

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline';

const STATUS_STYLE: Readonly<Record<TicketStatus, { label: string; variant: BadgeVariant }>> = {
  open: { label: 'Open', variant: 'secondary' },
  assigned: { label: 'Assigned', variant: 'default' },
  in_progress: { label: 'In progress', variant: 'default' },
  awaiting_approval: { label: 'Awaiting approval', variant: 'warning' },
  completed: { label: 'Completed', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
};

const PRIORITY_STYLE: Readonly<Record<TicketPriority, { label: string; variant: BadgeVariant }>> = {
  low: { label: 'Low', variant: 'outline' },
  normal: { label: 'Normal', variant: 'secondary' },
  high: { label: 'High', variant: 'warning' },
  urgent: { label: 'Urgent', variant: 'destructive' },
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  const style = STATUS_STYLE[status];
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const style = PRIORITY_STYLE[priority];
  return <Badge variant={style.variant}>{style.label}</Badge>;
}

/** Category labels come from `MAINTENANCE_CATEGORY_LABELS` in `packages/shared`. */
export function CategoryLabel({ category }: { category: MaintenanceCategory }) {
  return (
    <span className="text-sm text-muted-foreground">{MAINTENANCE_CATEGORY_LABELS[category]}</span>
  );
}

export function statusLabel(status: TicketStatus): string {
  return STATUS_STYLE[status].label;
}

export function priorityLabel(priority: TicketPriority): string {
  return PRIORITY_STYLE[priority].label;
}
