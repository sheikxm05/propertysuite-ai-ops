'use client';

/**
 * The `/sign-in` form body. Lane w2-l3 (Wave 2 remediation).
 *
 * Client-authored for the reason spelled out in `sign-up-form.tsx`: a `FormControl` child
 * created in a Server Component can arrive as a Flight lazy wrapper rather than an
 * element, and `FormControl` clones it. `/sign-in` happened to survive the chunk layout
 * that broke `/sign-up`; that is luck, not a difference in kind.
 *
 * `next` is attacker-controlled — it comes from the query string the middleware wrote.
 * It is carried here only so it survives a failed submission; `safeNext` in `actions.ts`
 * re-validates it as a relative path before it is ever used.
 */

import { FormControl, FormField, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

import { signIn } from '../actions';
import { ActionForm } from './action-form';

export function SignInForm({ next }: { next: string | null }) {
  return (
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
  );
}
