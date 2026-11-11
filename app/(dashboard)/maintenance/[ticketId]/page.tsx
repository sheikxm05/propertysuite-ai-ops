/**
 * `/maintenance/{ticketId}` — the ticket, its timeline and the actions this caller may
 * take.
 *
 * The 404 is the interesting part. `getTicketDetail()` reads the ticket through the
 * caller's own RLS-scoped client and then re-checks the §4 matrix against the row's own
 * columns. A provider opening a ticket id that is not assigned to them gets the same
 * `notFound()` as a ticket id that does not exist — never a 403, which would confirm the
 * ticket is real. That is acceptance criterion 7 on screen, and it is why this page
 * cannot distinguish the two cases either.
 *
 * `available_transitions` comes from the server and drives the action panel. The timeline
 * is rendered read-only because `maintenance_activities` is append-only in the database;
 * there is no edit control here and no route behind one.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { isApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';
import {
  CategoryLabel,
  PriorityBadge,
  StatusBadge,
} from '@/features/maintenance/components/badges';
import { ActivityTimeline } from '@/features/maintenance/components/activity-timeline';
import { AddCommentForm, TicketActions } from '@/features/maintenance/components/ticket-actions';
import {
  TICKET_ASSIGN_ROLES,
  getTicketDetail,
  listAssignableProviders,
} from '@/features/maintenance/domain';
import { maintenancePageContext } from '@/features/maintenance/server-context';

export const metadata = { title: 'Ticket' };

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ ticketId: string }>;
}) {
  const { ticketId } = await params;
  const { supabase, membership, logger } = await maintenancePageContext();
  if (!membership) notFound();

  const context = { supabase, membership, logger };

  // A denial and an absence are rendered identically, on purpose. `getTicketDetail`
  // raises `NOT_FOUND` for a row RLS hid and `AuthorizationDeniedError` for a row the
  // matrix refuses; both become this page's 404 so the two are indistinguishable from
  // outside. Anything else is a real fault and is left to propagate to `app/error.tsx`.
  let detail;
  try {
    detail = await getTicketDetail(context, ticketId);
  } catch (error) {
    if (error instanceof AuthorizationDeniedError) notFound();
    if (isApiRouteError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) {
      notFound();
    }
    throw error;
  }

  // The provider picker is only fetched for roles that may assign, so a tenant's page
  // never issues the query at all.
  const providers = TICKET_ASSIGN_ROLES.includes(membership.role)
    ? await listAssignableProviders(context)
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/maintenance" className="underline-offset-4 hover:underline">
            Maintenance
          </Link>
        }
        title={detail.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={detail.status} />
            <PriorityBadge priority={detail.priority} />
            <CategoryLabel category={detail.category} />
          </span>
        }
        actions={
          <Button asChild variant="outline">
            <Link href="/maintenance">Back</Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Report</CardTitle>
              <CardDescription>
                {detail.property_name ?? 'Property'}
                {detail.unit_number ? ` — ${detail.unit_number}` : ''}
                {/* Name only. The §4 matrix grants a provider the tenant's name and
                    nothing else, and the query projects exactly that for every role. */}
                {detail.tenant ? ` · reported for ${detail.tenant.full_name}` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap break-words text-sm">{detail.description}</p>
              {detail.provider_company_name && (
                <>
                  <Separator className="my-4" />
                  <p className="text-sm text-muted-foreground">
                    Assigned to {detail.provider_company_name}.
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Timeline</CardTitle>
              <CardDescription>
                One entry per transition, appended by the server. Entries cannot be edited or
                removed — the table rejects both for every caller.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <ActivityTimeline activities={detail.activities ?? []} />
              <Separator />
              <AddCommentForm ticketId={detail.id} />
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-base">Actions</CardTitle>
            <CardDescription>
              Only the transitions your role may drive on this ticket, computed from the same rule
              set the server and the database enforce.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TicketActions
              ticketId={detail.id}
              transitions={detail.available_transitions ?? []}
              providers={providers}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
