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
import {
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

import { signUp } from '../actions';
import { ActionForm } from '../components/action-form';

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

        <ActionForm action={signUp} submitLabel="Create account" pendingLabel="Creating account…">
          <FormField name="full_name">
            <FormLabel>Full name</FormLabel>
            <FormControl>
              <Input autoComplete="name" autoFocus required />
            </FormControl>
            <FormMessage />
          </FormField>

          <FormField name="email">
            <FormLabel>Email address</FormLabel>
            <FormControl>
              <Input type="email" autoComplete="email" required />
            </FormControl>
            <FormMessage />
          </FormField>

          <FormField name="password">
            <FormLabel>Password</FormLabel>
            <FormControl>
              <Input type="password" autoComplete="new-password" required />
            </FormControl>
            <FormDescription>At least 8 characters.</FormDescription>
            <FormMessage />
          </FormField>
        </ActionForm>
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
