/**
 * `/properties/{propertyId}` — property detail and unit management.
 *
 * Every refusal on this page is a 404, never a 403. A property in another organization, a
 * property that does not exist, and a property this caller has no path to are rendered
 * identically, because telling the three apart confirms which ids exist — the rule stated
 * in `lib/api/errors.ts` and implemented by `assertVisible`.
 *
 * `canWrite` decides which controls appear. It hides, it does not protect: a property
 * owner reading the property they own sees the tables and no buttons, and would still be
 * refused by `authorize()` and by `property_units_update_staff` if they called the route
 * directly.
 */

import { notFound } from 'next/navigation';
import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ArchiveButton } from '@/features/properties/archive-button';
import {
  formatDate,
  propertyStatusLabel,
  propertyStatusVariant,
  propertyTypeLabel,
} from '@/features/properties/labels';
import { firstParam, resolveOwnerName, resolvePageContext } from '@/features/properties/page-data';
import { getProperty, listUnits } from '@/features/properties/service';
import { UnitsPanel } from '@/features/properties/units-panel';
import { ApiRouteError } from '@/lib/api/errors';
import { ListUnitsQuerySchema, PropertyPathParamsSchema } from '@shared/index';

/** `params` and `searchParams` are both promises in Next 15. */
interface PageProps {
  params: Promise<{ propertyId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function PropertyDetailPage({ params, searchParams }: PageProps) {
  const context = await resolvePageContext();
  if (!context) notFound();

  // A path segment that is not a UUID is a 404, not a 500 from Postgres' `22P02`.
  const parsedParams = PropertyPathParamsSchema.safeParse(await params);
  if (!parsedParams.success) notFound();
  const { propertyId } = parsedParams.data;

  const search = await searchParams;
  const unitQueryResult = ListUnitsQuerySchema.safeParse({
    cursor: firstParam(search.unitCursor) ?? '',
    limit: firstParam(search.unitLimit) ?? '',
    status: firstParam(search.unitStatus) ?? '',
  });
  const unitQuery = unitQueryResult.success ? unitQueryResult.data : ListUnitsQuerySchema.parse({});

  const { supabase, membership, canWrite } = context;

  // `getProperty` and `listUnits` raise `NOT_FOUND` for anything the caller may not see.
  // Translated to Next's own 404 here so the page renders `app/not-found.tsx` rather than
  // the generic error boundary — the body a visitor sees must not distinguish the two.
  let property;
  let units;
  try {
    property = await getProperty(supabase, membership, propertyId);
    units = await listUnits(supabase, membership, propertyId, unitQuery);
  } catch (error) {
    if (error instanceof ApiRouteError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  // Resolved through `lib/auth/roles.ts`, the only module permitted to read `profiles`.
  // `null` means this caller may not see the name — correct for a tenant or a provider —
  // and the field falls back to an id-based label rather than failing the page.
  const ownerName = await resolveOwnerName(supabase, membership, property.owner_member_id);

  const archived = property.status === 'archived';

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/properties" className="underline-offset-4 hover:underline">
            Properties
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {property.name}
            <Badge variant={propertyStatusVariant(property.status)} className="whitespace-nowrap">
              {propertyStatusLabel(property.status)}
            </Badge>
          </span>
        }
        description={`${property.address_line}, ${property.city}, ${property.emirate}`}
        actions={
          canWrite ? (
            <>
              <Button asChild variant="outline" size="sm">
                <Link href={`/properties/${property.id}/edit`}>Edit</Link>
              </Button>
              <ArchiveButton propertyId={property.id} status={property.status} />
            </>
          ) : null
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Type" value={propertyTypeLabel(property.property_type)} />
            <Detail label="City" value={property.city} />
            <Detail label="Emirate" value={property.emirate} />
            <Detail label="Added" value={formatDate(property.created_at)} />
            <Detail
              label="Owner"
              value={
                property.owner_member_id
                  ? (ownerName ?? `Member ${property.owner_member_id.slice(0, 8)}`)
                  : 'Not assigned'
              }
            />
            <Detail label="Last updated" value={formatDate(property.updated_at)} />
          </dl>
        </CardContent>
      </Card>

      <Separator />

      <UnitsPanel
        propertyId={property.id}
        units={units.rows}
        nextCursor={units.nextCursor}
        cursorParam="unitCursor"
        canWrite={canWrite}
        propertyArchived={archived}
      />
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}
