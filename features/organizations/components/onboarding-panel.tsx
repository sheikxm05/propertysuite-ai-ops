/**
 * What an authenticated user with no membership sees. Lane w1-l1.
 *
 * This state is legitimate, not an error: `0003` creates a `profiles` row from an
 * `auth.users` trigger the moment somebody signs up, but membership comes from
 * `organization_members`, and there is no INSERT policy on that table at all. The only
 * two ways in are `create_organization` (become an administrator of a new organization)
 * and `accept_invitation` (join an existing one), so those are the only two things this
 * panel offers.
 *
 * Both run as server actions rather than through `withApiHandler`, because the wrapper
 * resolves membership before the handler and refuses a caller who has none — which is
 * exactly this caller. See the header of `app/(auth)/actions.ts`.
 */

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { CreateOrganizationForm } from './create-organization-form';

export function OnboardingPanel() {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Create an organization</CardTitle>
          <CardDescription>
            You become its administrator. Both happen in one transaction, so an organization never
            exists with nobody able to run it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrganizationForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Join an organization</CardTitle>
          <CardDescription>
            If an administrator invited you, redeem the token they gave you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The invitation must have been issued to the email address on this account. Possession of
            the token alone is not enough — the database checks the two match.
          </p>
          <Button asChild variant="outline">
            <Link href="/organization/accept">Redeem an invitation</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
