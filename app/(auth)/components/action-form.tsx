'use client';

/**
 * The client half of every form in this lane. Lane w1-l1.
 *
 * One component, because every form here has the same three needs: run a server action,
 * show the server's field errors, and disable the submit button while it is in flight.
 * `useActionState` carries the action's return value, and the form primitives from
 * `components/ui/form.tsx` render `fieldErrors` directly — amendment A1 built them around
 * `ZodError.flatten().fieldErrors` precisely so one Zod parse on the server feeds both
 * validation and display.
 *
 * **Nothing is validated here.** Not "validation is duplicated on the client for
 * convenience" — there is deliberately no client-side check at all, because a form that
 * appears to validate invites the reader to believe the check matters. The server parses
 * the submission against a schema from `packages/shared` and its answer is the only one.
 * `noValidate` on the underlying `<form>` (set by `components/ui/form.tsx`) keeps the
 * browser from forming the same impression.
 */

import { useActionState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';

import type { ActionState } from '../actions';

export interface ActionFormProps {
  action: (state: ActionState | null, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  pendingLabel?: string;
  /** Rendered inside the form, above the submit button. Receives nothing. */
  children: React.ReactNode;
  /**
   * How the action's `message` is shown. A failed sign-in is `destructive`; a
   * password-reset confirmation is `default`, because "a link is on its way" is not an
   * error even though it travels in the same field.
   */
  messageVariant?: 'destructive' | 'default';
}

export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  children,
  messageVariant = 'destructive',
}: ActionFormProps) {
  const [state, submit, pending] = useActionState(action, null);

  return (
    <Form action={submit} errors={state?.fieldErrors ?? null}>
      {state?.message ? (
        <Alert variant={messageVariant}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}

      {children}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? (pendingLabel ?? 'Working…') : submitLabel}
      </Button>
    </Form>
  );
}
