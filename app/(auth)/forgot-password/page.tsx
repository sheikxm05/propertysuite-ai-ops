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
 *
 * The field lives in `components/forgot-password-form.tsx`, a Client Component — see the
 * header of `components/sign-up-form.tsx` for why that is a correctness requirement.
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

import { ForgotPasswordForm } from '../components/forgot-password-form';

export const metadata = { title: 'Reset your password' };

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>We will email you a link if the address has an account.</CardDescription>
      </CardHeader>

      <CardContent>
        <ForgotPasswordForm />
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
