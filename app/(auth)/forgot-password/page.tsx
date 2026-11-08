/**
 * `/forgot-password` — slug frozen by amendment A17. Lane w1-l1.
 *
 * The action always reports the same thing, whether or not the address has an account.
 * That is the whole security content of this page: a form that answered honestly would
 * be a free account-enumeration endpoint, and the person who legitimately mistyped their
 * address is served just as well by "check your inbox".
 *
 * The confirmation therefore arrives in the action's `message` field with the
 * non-destructive variant — the same channel an error uses, because to this page they
 * are the same event.
 */

import Link from 'next/link';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FormControl, FormField, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

import { requestPasswordReset } from '../actions';
import { ActionForm } from '../components/action-form';

export const metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>We will email you a link if the address has an account.</CardDescription>
      </CardHeader>

      <CardContent>
        <ActionForm
          action={requestPasswordReset}
          submitLabel="Send reset link"
          pendingLabel="Sending…"
          messageVariant="default"
        >
          <FormField name="email">
            <FormLabel>Email address</FormLabel>
            <FormControl>
              <Input type="email" autoComplete="email" autoFocus required />
            </FormControl>
            <FormMessage />
          </FormField>
        </ActionForm>
      </CardContent>

      <CardFooter className="text-sm text-muted-foreground">
        <p>
          <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
            Back to sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
