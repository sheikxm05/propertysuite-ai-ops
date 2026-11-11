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
import { SearchX, Wrench } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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
      <div className="space-y-6">
        <PageHeader title="Maintenance" />
        <EmptyState
          icon={Wrench}
          title="No organization yet"
          description="You are not an active member of an organization, so there are no tickets to show. Redeem an invitation and the queue appears here."
          action={
            <Button asChild variant="outline">
              <Link href="/organization/accept">Redeem an invitation</Link>
            </Button>
          }
        />
      </div>
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
      <PageHeader
        title={isProvider ? 'My jobs' : 'Maintenance'}
        description={describeScope(membership.role)}
        actions={
          /* Widened to `readonly MemberRole[]`: `TICKET_CREATE_ROLES` is a narrow tuple
             of three literals, so `.includes()` would reject the five-member union
             rather than answering it. Narrowing the ARGUMENT is what the shared
             constant is for; narrowing the predicate's input is a type artefact. */
          (TICKET_CREATE_ROLES as readonly MemberRole[]).includes(membership.role) ? (
            <Button asChild>
              <Link href="/maintenance/new">Report an issue</Link>
            </Button>
          ) : null
        }
      />

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

      <TicketTable
        tickets={tickets}
        empty={emptyStateFor({
          role: membership.role,
          filtered: Boolean(query.status || query.priority),
          canCreate: (TICKET_CREATE_ROLES as readonly MemberRole[]).includes(membership.role),
        })}
      />

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

/**
 * What "no tickets" means, which is not one thing.
 *
 * For a provider an empty queue is the product working — it is the assignment boundary
 * seen from the inside — and offering them a "report an issue" button would be wrong
 * twice over, because they also may not create one. For a manager with a filter applied
 * the useful action is to drop the filter. For a manager with no filter it is to open
 * the first ticket.
 */
function emptyStateFor({
  role,
  filtered,
  canCreate,
}: {
  role: string;
  filtered: boolean;
  canCreate: boolean;
}) {
  if (filtered) {
    return (
      <EmptyState
        icon={SearchX}
        title="No tickets match this view"
        description="The filter is applied on the server, so an empty page here means the rows genuinely are not in your scope."
        action={
          <Button asChild variant="outline">
            <Link href="/maintenance">Clear the filters</Link>
          </Button>
        }
      />
    );
  }

  if (role === 'service_provider') {
    return (
      <EmptyState
        icon={Wrench}
        title="No jobs are assigned to you"
        description="You see work assigned to you and nothing else. Another provider's job is not hidden from this list — it is not reachable from this account at all."
      />
    );
  }

  return (
    <EmptyState
      icon={Wrench}
      title="No tickets yet"
      description="Maintenance starts when somebody reports a problem. A tenant can raise one themselves, and the assistant will draft the category and priority for a human to confirm."
      action={
        canCreate ? (
          <Button asChild>
            <Link href="/maintenance/new">Report an issue</Link>
          </Button>
        ) : null
      }
    />
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
