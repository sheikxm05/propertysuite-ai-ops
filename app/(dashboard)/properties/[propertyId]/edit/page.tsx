/**
 * `/properties/{propertyId}/edit`
 *
 * The same `PropertyForm` as `/properties/new`, in `edit` mode, so the two paths cannot
 * validate differently — and both validate `UpdatePropertySchema` / `CreatePropertySchema`
 * from `@shared/index`, which is also what the route handler validates. One schema per
 * operation, shared between client and server (CLAUDE.md rule 4).
 *
 * Non-staff get a 404 rather than a 403 for a property they cannot see, and an explicit
 * "not permitted" for one they *can* see but may not write — a property owner reading
 * their own property. Those are genuinely different situations: the first must not confirm
 * the row exists, the second already knows it does.
 */

import { notFound } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { listOwnerOptions, resolvePageContext } from '@/features/properties/page-data';
import { PropertyForm } from '@/features/properties/property-form';
import { getProperty } from '@/features/properties/service';
import { ApiRouteError } from '@/lib/api/errors';
import { PropertyPathParamsSchema } from '@shared/index';

export const metadata = { title: 'Edit property' };

export default async function EditPropertyPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const context = await resolvePageContext();
  if (!context) notFound();

  const parsed = PropertyPathParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  let property;
  try {
    property = await getProperty(context.supabase, context.membership, parsed.data.propertyId);
  } catch (error) {
    if (error instanceof ApiRouteError && error.code === 'NOT_FOUND') notFound();
    throw error;
  }

  if (!context.canWrite) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Not permitted</AlertTitle>
        <AlertDescription>
          You can view {property.name} but only an organization administrator or a property manager
          can change it.
        </AlertDescription>
      </Alert>
    );
  }

  const owners = await listOwnerOptions(context.supabase, context.membership);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Edit property</h1>
        <p className="text-sm text-muted-foreground">{property.name}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <PropertyForm mode="edit" property={property} owners={owners} />
        </CardContent>
      </Card>
    </div>
  );
}
