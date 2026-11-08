/**
 * "Open tickets by priority" — the dashboard widget's body.
 *
 * An async server component, so the counts are read on the server with the caller's own
 * client and never travel to the browser as a query. `countOpenByPriority()` reuses
 * `ticketListScope()`, which means the widget counts EXACTLY the rows the list page
 * would show: a provider's tile counts their assigned jobs, a tenant's counts their own
 * reports, and a tile can never advertise the existence of a row its owner may not open.
 *
 * Counted statuses are the four non-terminal ones. "Open" in the widget's title means
 * "still live", not literally `status = 'open'` — a ticket awaiting approval is
 * outstanding work and hiding it would make the tile useless for triage.
 *
 * Each priority links into the list with the matching facet, so the tile is a filter and
 * not just a number.
 */

import Link from 'next/link';

import { TICKET_PRIORITIES, type TicketPriority } from '@shared/index';
import { countOpenByPriority } from '@/features/maintenance/domain';
import { maintenancePageContext } from '@/features/maintenance/server-context';

import { priorityLabel } from './badges';

/** Highest priority first: the number a manager needs is at the left. */
const DISPLAY_ORDER: readonly TicketPriority[] = [...TICKET_PRIORITIES].reverse();

export async function OpenTicketsByPriority() {
  const { supabase, membership, logger } = await maintenancePageContext();

  if (!membership) {
    return <p className="text-sm text-muted-foreground">No organization yet.</p>;
  }

  const counts = await countOpenByPriority({ supabase, membership, logger });
  const total = DISPLAY_ORDER.reduce((sum, priority) => sum + counts[priority], 0);

  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {membership.role === 'service_provider'
          ? 'No jobs are assigned to you.'
          : 'No outstanding maintenance.'}
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {DISPLAY_ORDER.map((priority) => (
        <Link
          key={priority}
          href={`/maintenance?priority=${priority}`}
          className="rounded-md border p-3 transition-colors hover:bg-muted/50"
        >
          <span className="block text-2xl font-semibold tabular-nums">{counts[priority]}</span>
          <span className="block text-xs text-muted-foreground">{priorityLabel(priority)}</span>
        </Link>
      ))}
    </div>
  );
}
