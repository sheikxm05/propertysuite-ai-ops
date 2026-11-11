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

import * as React from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { TICKET_PRIORITY_STYLE, TICKET_STATUS_STYLE, styleFor } from '@/components/ui/status';
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
  /**
   * Rendered when the page is empty, which for a provider is the common case — and for
   * a provider it is also the correct answer rather than a gap, so the page composes the
   * whole state and this component only decides where to put it.
   */
  empty: React.ReactNode;
}

export function TicketTable({ tickets, empty }: TicketTableProps) {
  if (tickets.length === 0) return <>{empty}</>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          {/* Category folds away below `md`. Priority and status never do: they are the
              two columns somebody triaging a queue is actually scanning. */}
          <TableHead className="hidden md:table-cell">Category</TableHead>
          <TableHead>Priority</TableHead>
          <TableHead>Status</TableHead>
          <TableHead numeric className="hidden sm:table-cell">
            Reported
          </TableHead>
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
            <TableCell className="hidden md:table-cell">
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
            <TableCell
              numeric
              className="hidden whitespace-nowrap text-sm text-muted-foreground sm:table-cell"
            >
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
          {/*
            The facet label is the same string the chip in the table uses — it used to be
            `option.replace(/_/g, ' ')`, so the filter read "awaiting approval" while the
            row it selected read "Awaiting approval". The variant stays `default` /
            `outline` because this chip means "selected", not "this status is amber".
          */}
          <Badge variant={active === option ? 'default' : 'outline'}>
            {facetLabel(param, option)}
          </Badge>
        </Link>
      ))}
    </div>
  );
}

/** The chip label for a facet option, taken from the same table the rows use. */
function facetLabel(param: 'status' | 'priority', option: string): string {
  return param === 'status'
    ? styleFor(TICKET_STATUS_STYLE, option).label
    : styleFor(TICKET_PRIORITY_STYLE, option).label;
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
