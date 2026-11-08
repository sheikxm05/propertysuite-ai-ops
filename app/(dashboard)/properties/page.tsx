/**
 * `/properties` — the property list.
 *
 * A server component. The membership is resolved here, the service is called here, and
 * the rows are already authorized by the time any component sees them. The only client
 * components on the page are the two controls that need interactivity: the filter bar and
 * the cursor navigation.
 *
 * What each role sees, enforced in `features/properties/service.ts` *and* by RLS:
 *
 *   organization_admin / property_manager   the organization's whole portfolio
 *   property_owner                          only properties recorded against their membership
 *   tenant                                  only the property containing a unit they actively lease
 *   service_provider                        only the property behind a ticket assigned to them
 *
 * The page does not branch on role to decide what to query. It calls one function, and
 * the scope resolution inside it does the narrowing — so there is no second place for the
 * role rules to drift.
 */

import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CursorNav } from '@/features/properties/cursor-nav';
import { ListControls } from '@/features/properties/list-controls';
import { firstParam, resolvePageContext } from '@/features/properties/page-data';
import { PropertyTable } from '@/features/properties/property-table';
import { listProperties } from '@/features/properties/service';
import { ListPropertiesQuerySchema } from '@shared/index';

export const metadata = { title: 'Properties' };

/** `searchParams` is a promise in Next 15. */
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function PropertiesPage({ searchParams }: { searchParams: SearchParams }) {
  const context = await resolvePageContext();
  if (!context) return <NoMembership />;

  const params = await searchParams;

  // Picked key by key and parsed with the frozen query schema — the same schema the route
  // handler uses as its `querySchema`. `ListPropertiesQuerySchema` is `.strict()`, so
  // forwarding the whole bag would reject the page for carrying `unitCursor`.
  const parsed = ListPropertiesQuerySchema.safeParse({
    cursor: firstParam(params.cursor) ?? '',
    limit: firstParam(params.limit) ?? '',
    status: firstParam(params.status) ?? '',
    q: firstParam(params.q) ?? '',
  });

  // A bad parameter falls back to the default page rather than erroring: a stale link is
  // the overwhelmingly likely cause, and the schema has already refused to act on it.
  const query = parsed.success ? parsed.data : ListPropertiesQuerySchema.parse({});
  const page = await listProperties(context.supabase, context.membership, query);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Properties</h1>
          <p className="text-sm text-muted-foreground">
            {context.canWrite
              ? 'Every property in your organization.'
              : 'The properties you are authorized to see.'}
          </p>
        </div>

        {context.canWrite ? (
          <Button asChild>
            <Link href="/properties/new">New property</Link>
          </Button>
        ) : null}
      </header>

      {parsed.success ? null : (
        <Alert variant="destructive">
          <AlertTitle>Filters ignored</AlertTitle>
          <AlertDescription>
            One of the filters in this link is not valid, so the unfiltered list is shown.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <ListControls />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <PropertyTable
            properties={page.rows}
            emptyMessage={
              query.q || query.status
                ? 'No properties match these filters.'
                : context.canWrite
                  ? 'No properties yet. Create the first one to get started.'
                  : 'No properties are visible to you.'
            }
          />
          <CursorNav param="cursor" nextCursor={page.nextCursor} count={page.rows.length} />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Shown to an authenticated user who belongs to no organization — a real state while an
 * invitation is pending, not an error. Deliberately not a redirect: see
 * `resolvePageContext`.
 */
function NoMembership() {
  return (
    <Alert>
      <AlertTitle>No organization yet</AlertTitle>
      <AlertDescription>
        Your account is not an active member of an organization, so there are no properties to show.
        Accept an invitation, or ask an administrator to add you.
      </AlertDescription>
    </Alert>
  );
}
