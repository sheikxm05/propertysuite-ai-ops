/**
 * `/properties/new` — create a property.
 *
 * Staff only. The role check here hides the form; it does not protect anything. The real
 * refusals are `roles: STAFF_ROLES` on `POST /api/v1/properties`, `authorize()` inside
 * `createProperty`, and `properties_insert_staff` in `0002` — three independent layers, so
 * a non-staff caller who navigates here directly and posts the body by hand gets a 403
 * from the route whatever this page rendered.
 */

import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { listOwnerOptions, resolvePageContext } from '@/features/properties/page-data';
import { PropertyForm } from '@/features/properties/property-form';

export const metadata = { title: 'New property' };

export default async function NewPropertyPage() {
  const context = await resolvePageContext();

  if (!context) {
    return (
      <Alert>
        <AlertTitle>No organization yet</AlertTitle>
        <AlertDescription>
          Your account is not an active member of an organization, so there is nothing to add a
          property to.
        </AlertDescription>
      </Alert>
    );
  }

  if (!context.canWrite) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Not permitted</AlertTitle>
        <AlertDescription>
          Only an organization administrator or a property manager can create a property.
        </AlertDescription>
      </Alert>
    );
  }

  const owners = await listOwnerOptions(context.supabase, context.membership);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        eyebrow="Portfolio"
        title="New property"
        description={`The property is created in ${context.membership.organization.name}.`}
        actions={
          <Button asChild variant="outline">
            <Link href="/properties">Cancel</Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
          <CardDescription>
            Units are added after the property exists, from its detail page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PropertyForm mode="create" owners={owners} />
        </CardContent>
      </Card>
    </div>
  );
}
