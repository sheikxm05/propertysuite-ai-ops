/**
 * The ticket list table and its facets.
 *
 * Server components, and the facets are links rather than a client-side filter. Two
 * reasons: the filtered set must be produced by the server (`ticketListScope()` plus
 * RLS) because a client-side filter over a client-side array would be a security
 * control in the browser; and a shareable URL is the right primitive for "show me the
 * urgent ones".
 *
 * The column set is identical for every role. What differs is which ROWS arrive, which
 * is decided server-side. A table that hid a column by role would invite the mistake of
 * relying on it — the provider's tenant-name-only restriction is enforced by the
 * projection in `repository.findTenantName`, not by this component declining to render
 * an email it was handed.
 */

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  MAINTENANCE_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
} from '@shared/index';

import { PriorityBadge, StatusBadge } from './badges';

export interface TicketTableProps {
  tickets: readonly Ticket[];
  /** Rendered when the page is empty, which for a provider is the common case. */
  emptyMessage: string;
}

export function TicketTable({ tickets, emptyMessage }: TicketTableProps) {
  if (tickets.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Category</TableHead>
          <TableHead>Priority</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Reported</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tickets.map((ticket) => (
          <TableRow key={ticket.id}>
            <TableCell className="max-w-[28rem]">
              <Link
                href={`/maintenance/${ticket.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {ticket.title}
              </Link>
            </TableCell>
            <TableCell>
              <span className="text-sm text-muted-foreground">
                {MAINTENANCE_CATEGORY_LABELS[ticket.category]}
              </span>
            </TableCell>
            <TableCell>
              <PriorityBadge priority={ticket.priority} />
            </TableCell>
            <TableCell>
              <StatusBadge status={ticket.status} />
            </TableCell>
            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
              {formatDate(ticket.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/* ----------------------------------------------------------------- facets -- */

export interface FacetProps {
  /** The statuses this caller may filter by. Narrower for a provider. */
  statuses: readonly TicketStatus[];
  activeStatus: TicketStatus | undefined;
  activePriority: TicketPriority | undefined;
}

/**
 * Status and priority facets.
 *
 * `statuses` is a prop rather than `TICKET_STATUSES`, because a `service_provider` may
 * only ever see `PROVIDER_JOB_STATUSES` and offering them an `open` facet that always
 * returns nothing would be a UI that lies about the authorization model.
 */
export function TicketFacets({ statuses, activeStatus, activePriority }: FacetProps) {
  return (
    <div className="space-y-2">
      <FacetRow
        label="Status"
        param="status"
        options={statuses}
        active={activeStatus}
        activePriority={activePriority}
        activeStatus={activeStatus}
      />
      <FacetRow
        label="Priority"
        param="priority"
        options={TICKET_PRIORITIES}
        active={activePriority}
        activePriority={activePriority}
        activeStatus={activeStatus}
      />
    </div>
  );
}

function FacetRow(props: {
  label: string;
  param: 'status' | 'priority';
  options: readonly string[];
  active: string | undefined;
  activeStatus: TicketStatus | undefined;
  activePriority: TicketPriority | undefined;
}) {
  const { label, param, options, active } = props;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-16 text-xs font-medium uppercase text-muted-foreground">{label}</span>
      <Link href={facetHref(props, param, undefined)}>
        <Badge variant={active === undefined ? 'default' : 'outline'}>All</Badge>
      </Link>
      {options.map((option) => (
        <Link key={option} href={facetHref(props, param, option)}>
          <Badge variant={active === option ? 'default' : 'outline'}>
            {option.replace(/_/g, ' ')}
          </Badge>
        </Link>
      ))}
    </div>
  );
}

/**
 * Builds the facet link, preserving the other facet and DROPPING the cursor.
 *
 * Dropping it is correct, not lazy: a keyset cursor is a position in one specific
 * ordered, filtered result set. Carrying it across a filter change would resume from a
 * row that is no longer in the set.
 */
function facetHref(
  state: { activeStatus: TicketStatus | undefined; activePriority: TicketPriority | undefined },
  param: 'status' | 'priority',
  value: string | undefined,
): string {
  const next = new URLSearchParams();
  const status = param === 'status' ? value : state.activeStatus;
  const priority = param === 'priority' ? value : state.activePriority;
  if (status) next.set('status', status);
  if (priority) next.set('priority', priority);
  const query = next.toString();
  return query ? `/maintenance?${query}` : '/maintenance';
}

/* ---------------------------------------------------------------- helpers -- */

export function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat('en-AE', { dateStyle: 'medium', timeZone: 'Asia/Dubai' }).format(
    parsed,
  );
}
