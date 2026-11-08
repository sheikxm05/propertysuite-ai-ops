/**
 * `/accept-invitation` — slug frozen by amendment A17. Lane w1-l1.
 *
 * **This page cannot be the page that redeems the invitation, and that is a planning
 * defect, not a design choice.** `middleware.ts` treats all four A17 slugs as
 * signed-out-only: a visitor with a session who lands on any of them is redirected to
 * `/dashboard`. But `accept_invitation` requires `auth.uid()` — it is callable *only*
 * while signed in. So the one slug named for the operation is the one slug on which the
 * operation is impossible.
 *
 * Rather than widen the middleware (not this lane's file, and not this lane's call), the
 * flow is split at the only place it can be:
 *
 *   /accept-invitation      this page. Signed-out landing: explains the two steps and
 *                           sends the invitee to sign-up or sign-in.
 *   /organization/accept    the protected page that actually redeems the token, inside
 *                           the dashboard group where a session is guaranteed.
 *
 * The token is never put in a link or a query string on either page. `0003` stores only
 * its SHA-256 hash and `AcceptInvitationSchema` spells out why the body is the right
 * place: a URL ends up in access logs, browser history and referrer headers. So the
 * invitee carries the token themselves and pastes it into a form — which is also why
 * there is no `?token=` parameter read anywhere in this lane.
 */

import Link from 'next/link';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Accept an invitation' };

export default function AcceptInvitationPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>You have been invited</CardTitle>
        <CardDescription>
          Two steps: get an account on the invited address, then redeem your token.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <Alert>
          <AlertDescription>
            Your invitation can only be redeemed by an account whose email address matches the
            invitation exactly. Possession of the token is not enough on its own.
          </AlertDescription>
        </Alert>

        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            Create an account with the invited email address, or sign in if you already have one.
          </li>
          <li>
            Open <strong>Organization → Redeem an invitation</strong> and paste the token your
            administrator gave you.
          </li>
        </ol>

        <div className="flex flex-wrap gap-2">
          {/*
            `next` is carried through sign-in so the invitee lands on the redemption page
            rather than on an empty dashboard. It is a path only — never the token.
          */}
          <Button asChild>
            <Link href="/sign-up">Create an account</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/sign-in?next=%2Forganization%2Faccept">I already have an account</Link>
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Invitations expire seven days after they are issued. If yours has lapsed, ask your
          administrator to send another — a token can never be re-read, only reissued.
        </p>
      </CardContent>
    </Card>
  );
}
