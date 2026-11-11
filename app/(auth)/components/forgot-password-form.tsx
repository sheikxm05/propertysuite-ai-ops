'use client';

/**
 * The `/forgot-password` form body. Lane w2-l3 (Wave 2 remediation).
 *
 * Client-authored for the reason spelled out in `sign-up-form.tsx`.
 *
 * `messageVariant="default"` is deliberate: the action answers identically whether or not
 * the address has an account, so the confirmation travels in the same field an error
 * would and must not be dressed as one.
 */

import { FormControl, FormField, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

import { requestPasswordReset } from '../actions';
import { ActionForm } from './action-form';

export function ForgotPasswordForm() {
  return (
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
  );
}
