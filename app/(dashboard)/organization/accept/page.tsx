/**
 * `/organization/accept` — redeem an invitation token. Lane w1-l1.
 *
 * **Why acceptance happens here and not at `/accept-invitation`.** Amendment A17 froze
 * `/accept-invitation` as an `(auth)` slug, and `middleware.ts` treats all four A17 slugs
 * as signed-out-only: a visitor with a session is redirected away from them. But
 * `accept_invitation` requires `auth.uid()` and is callable only *while* signed in. So
 * the operation cannot live on the slug named after it. Reported as a planning defect;
 * `/accept-invitation` is the signed-out landing page that sends the invitee here.
 *
 * This route is under the `(dashboard)` group, so `middleware.ts` guarantees a session
 * before the page renders, and the layout tolerates a caller with no membership — which
 * is who this page is for.
 *
 * The token is typed into a form and posted in a body. It is never a query parameter:
 * `0003` stores only its SHA-256 hash, and a URL ends up in access logs, browser history
 * and referrer headers. It is not logged, not echoed back in an error, and not retained
 * after the submission.
 */

import Link from 'next/link';

import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FormControl, FormDescription, FormField, FormLabel } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { acceptInvite } from '@/app/(auth)/actions';
import { ActionForm } from '@/app/(auth)/components/action-form';
import { requireContext } from '@/features/organizations/server-context';

export const metadata = { title: 'Redeem an invitation' };

export default async function AcceptInvitationPage() {
  const { session } = await requireContext();

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Redeem an invitation</CardTitle>
          <CardDescription>
            Paste the token your administrator gave you. It can be used once.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription>
              You are signed in as <strong>{session.email ?? 'this account'}</strong>. An invitation
              is only redeemable by the account it was issued to, so a token sent to a different
              address will be refused even though it is valid.
            </AlertDescription>
          </Alert>

          <ActionForm action={acceptInvite} submitLabel="Redeem" pendingLabel="Redeeming…">
            <FormField name="invitation_token">
              <FormLabel>Invitation token</FormLabel>
              <FormControl>
                {/*
                  `autoComplete="off"` and `spellCheck={false}`: this is a credential, not
                  a word. Browsers should not offer to remember or correct it.
                */}
                <Input autoComplete="off" spellCheck={false} autoFocus required />
              </FormControl>
              <FormDescription>
                64 hexadecimal characters. Invitations expire seven days after they are issued.
              </FormDescription>
            </FormField>
          </ActionForm>
        </CardContent>

        <CardFooter className="text-sm text-muted-foreground">
          <p>
            No token?{' '}
            <Link href="/dashboard" className="text-primary underline-offset-4 hover:underline">
              Back to the dashboard
            </Link>
            . An administrator can issue a new one — a token can never be read back, only reissued.
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
