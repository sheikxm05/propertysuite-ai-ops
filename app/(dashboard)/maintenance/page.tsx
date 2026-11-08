/**
 * `/maintenance` — the ticket list, one screen that is five different screens.
 *
 * A property manager sees the organization's queue. A tenant sees the tickets they
 * reported. A property owner sees tickets on the properties they own. A service provider
 * sees ONLY jobs assigned to them, and only in the statuses they may act on — which is
 * acceptance criterion 7 and the most visible isolation claim in the demo.
 *
 * The role never branches the query. `listTicketPage()` applies
 * `ticketListScope(membership, query)` and RLS applies the matching policies, so the
 * difference between those five screens is entirely in the rows that come back. The one
 * place the role shows up in this file is the facet list: a provider is not offered an
 * `open` facet, because offering a filter that can only ever return nothing would
 * misrepresent the authorization model.
 *
 * Rendered server-side on every request, with `cache: no-store` semantics inherited
 * from the dynamic `searchParams` read. A tenant-scoped page must never be served from
 * a shared cache.
 */

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ListTicketsQuerySchema,
  TICKET_CREATE_ROLES,
  TICKET_STATUSES,
  type MemberRole,
  type TicketPriority,
  type TicketStatus,
} from '@shared/index';
import { PROVIDER_JOB_STATUSES, listTicketPage, toTicket } from '@/features/maintenance/domain';
import { TicketFacets, TicketTable } from '@/features/maintenance/components/ticket-table';
import { maintenancePageContext } from '@/features/maintenance/server-context';

export const metadata = { title: 'Maintenance' };

/** Next 15 passes `searchParams` as a promise. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function MaintenancePage({ searchParams }: { searchParams: SearchParams }) {
  const { supabase, membership, logger } = await maintenancePageContext();

  if (!membership) {
    return (
      <EmptyState
        title="Maintenance"
        body="You are not an active member of an organization yet, so there are no tickets to show."
      />
    );
  }

  // Parsed with the SAME schema the API route uses, so an out-of-range `limit` or a
  // malformed cursor is rejected identically whether it arrives as a query string on
  // this page or on `GET /api/v1/maintenance/tickets`. A page that validated more
  // loosely than its API would be the easier target.
  const raw = await searchParams;
  const parsed = ListTicketsQuerySchema.safeParse(flatten(raw));
  const query = parsed.success ? parsed.data : ListTicketsQuerySchema.parse({});

  const page = await listTicketPage({ supabase, membership, logger }, query);
  const tickets = page.items.map(toTicket);

  const isProvider = membership.role === 'service_provider';
  const facetStatuses: readonly TicketStatus[] = isProvider
    ? PROVIDER_JOB_STATUSES
    : TICKET_STATUSES;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isProvider ? 'My jobs' : 'Maintenance'}
          </h1>
          <p className="text-sm text-muted-foreground">{describeScope(membership.role)}</p>
        </div>
        {/* Widened to `readonly MemberRole[]`: `TICKET_CREATE_ROLES` is a narrow tuple
            of three literals, so `.includes()` would reject the five-member union
            rather than answering it. Narrowing the ARGUMENT is what the shared
            constant is for; narrowing the predicate's input is a type artefact. */}
        {(TICKET_CREATE_ROLES as readonly MemberRole[]).includes(membership.role) && (
          <Button asChild>
            <Link href="/maintenance/new">Report an issue</Link>
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Filtering happens on the server. A filter you are not entitled to returns an empty page
            rather than an error.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TicketFacets
            statuses={facetStatuses}
            activeStatus={query.status as TicketStatus | undefined}
            activePriority={query.priority as TicketPriority | undefined}
          />
        </CardContent>
      </Card>

      <TicketTable tickets={tickets} emptyMessage={emptyMessageFor(membership.role)} />

      {page.pageInfo.has_more && page.pageInfo.next_cursor && (
        <div className="flex justify-end">
          <Button asChild variant="secondary">
            <Link href={nextPageHref(query, page.pageInfo.next_cursor)}>Next page</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers -- */

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/** `searchParams` may repeat a key; the schema takes the first, as the API wrapper does. */
function flatten(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function nextPageHref(
  query: { status?: string | undefined; priority?: string | undefined },
  cursor: string,
): string {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.priority) params.set('priority', query.priority);
  params.set('cursor', cursor);
  return `/maintenance?${params.toString()}`;
}

function describeScope(role: string): string {
  switch (role) {
    case 'service_provider':
      return 'Jobs assigned to you. Work assigned to another provider is not visible here or anywhere else.';
    case 'tenant':
      return 'Tickets you have reported.';
    case 'property_owner':
      return 'Tickets on properties you own.';
    default:
      return 'Every ticket in your organization, and no ticket outside it.';
  }
}

function emptyMessageFor(role: string): string {
  return role === 'service_provider'
    ? 'No jobs are assigned to you.'
    : 'No tickets match this view.';
}
