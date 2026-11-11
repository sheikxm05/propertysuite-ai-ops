/**
 * `/sign-up` — slug frozen by amendment A17. Lane w1-l1.
 *
 * **No profile row is created by this page or its action.** `0003` creates it from an
 * `auth.users` AFTER INSERT trigger and `0002` grants no client INSERT policy on
 * `profiles` (amendment A6): a client that could insert its own profile could choose its
 * own `id` and pre-empt a pending invitation. The display name is passed as auth user
 * metadata and the trigger reads it.
 *
 * The note about invitations is load-bearing rather than decorative. `accept_invitation`
 * requires the authenticated account's email to match the invitation, so somebody who
 * signs up with a different address cannot redeem the invitation they were sent — and
 * there is no self-service way to change the address of record, because that lives in
 * `auth.users` and is an identity operation.
 *
 * The fields live in `components/sign-up-form.tsx`, a Client Component, and that is a
 * correctness requirement rather than taste — see the header of that file for the Flight
 * lazy-wrapper crash it fixes.
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

import { SignUpForm } from '../components/sign-up-form';

export const metadata = { title: 'Create an account' };

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>
          Then create an organization, or redeem an invitation to join one.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <Alert>
          <AlertDescription>
            If you were invited, sign up with{' '}
            <strong>exactly the address the invitation was sent to</strong>. An invitation can only
            be redeemed by the account it names.
          </AlertDescription>
        </Alert>

        <SignUpForm />
      </CardContent>

      <CardFooter className="text-sm text-muted-foreground">
        <p>
          Already have an account?{' '}
          <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
          .
        </p>
      </CardFooter>
    </Card>
  );
}
