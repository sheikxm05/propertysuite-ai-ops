'use client';

/**
 * The `/organization/accept` form body. Lane w2-l3 (Wave 2 remediation).
 *
 * Client-authored for the reason spelled out in `sign-up-form.tsx`. It lives beside the
 * other `(auth)` form bodies because the action it runs, `acceptInvite`, lives in
 * `app/(auth)/actions.ts` — the redemption page is under `(dashboard)` only because that
 * is the one route group where a session is guaranteed.
 *
 * The token is typed, never linked: it is posted in a body so it stays out of access
 * logs, browser history and referrer headers.
 */

import { FormControl, FormDescription, FormField, FormLabel } from '@/components/ui/form';
import { Input } from '@/components/ui/input';

import { acceptInvite } from '../actions';
import { ActionForm } from './action-form';

export function RedeemInvitationForm() {
  return (
    <ActionForm action={acceptInvite} submitLabel="Redeem" pendingLabel="Redeeming…">
      <FormField name="invitation_token">
        <FormLabel>Invitation token</FormLabel>
        <FormControl>
          {/*
            `autoComplete="off"` and `spellCheck={false}`: this is a credential, not a
            word. Browsers should not offer to remember or correct it.
          */}
          <Input autoComplete="off" spellCheck={false} autoFocus required />
        </FormControl>
        <FormDescription>
          64 hexadecimal characters. Invitations expire seven days after they are issued.
        </FormDescription>
      </FormField>
    </ActionForm>
  );
}
