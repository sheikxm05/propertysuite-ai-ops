/**
 * `/sign-in` — slug frozen by amendment A17. Lane w1-l1.
 *
 * `middleware.ts` redirects an unauthenticated visitor here from any protected page and
 * carries the path they wanted in `?next=`. That value is attacker-controlled, so it is
 * re-validated as a relative path in two places: `safeReturnTo` in the middleware when
 * it is set, and `safeNext` in `actions.ts` when it is used. It is rendered into a hidden
 * field here rather than kept in the URL only, so it survives a failed submission.
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

import { signIn } from '../actions';
import { ActionForm } from '../components/action-form';

export const metadata = { title: 'Sign in' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = firstValue(params.next);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the email address your organization invited.</CardDescription>
      </CardHeader>

      <CardContent>
        <ActionForm action={signIn} submitLabel="Sign in" pendingLabel="Signing in…">
          {/* Validated again server-side; never trusted as given. */}
          <input type="hidden" name="next" value={next ?? ''} />

          <FormField name="email">
            <FormLabel>Email address</FormLabel>
            <FormControl>
              <Input type="email" autoComplete="email" autoFocus required />
            </FormControl>
            <FormMessage />
          </FormField>

          <FormField name="password">
            <FormLabel>Password</FormLabel>
            <FormControl>
              <Input type="password" autoComplete="current-password" required />
            </FormControl>
            <FormMessage />
          </FormField>
        </ActionForm>
      </CardContent>

      <CardFooter className="flex-col items-start gap-2 text-sm">
        <Link href="/forgot-password" className="text-primary underline-offset-4 hover:underline">
          Forgotten your password?
        </Link>
        <p className="text-muted-foreground">
          No account yet?{' '}
          <Link href="/sign-up" className="text-primary underline-offset-4 hover:underline">
            Create one
          </Link>
          .
        </p>
      </CardFooter>
    </Card>
  );
}

/** A repeated query parameter arrives as an array; take the first value only. */
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
