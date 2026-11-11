'use client';

/**
 * The "create an organization" form body on the onboarding panel. Lane w2-l3.
 *
 * Client-authored for the reason spelled out in `app/(auth)/components/sign-up-form.tsx`:
 * a `FormControl` child created inside a Server Component can reach `FormControl` as a
 * Flight lazy wrapper rather than an element, and `FormControl` clones it. Every element
 * below is constructed on the client, so that cannot happen here.
 *
 * `createFirstOrganization` runs as a server action rather than through `withApiHandler`
 * because the wrapper resolves membership first and refuses a caller who has none — which
 * is exactly the caller this form exists for.
 */

import {
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

import { createFirstOrganization } from '@/app/(auth)/actions';
import { ActionForm } from '@/app/(auth)/components/action-form';

export function CreateOrganizationForm() {
  return (
    <ActionForm
      action={createFirstOrganization}
      submitLabel="Create organization"
      pendingLabel="Creating…"
    >
      <FormField name="name">
        <FormLabel>Organization name</FormLabel>
        <FormControl>
          <Input autoFocus required />
        </FormControl>
        <FormMessage />
      </FormField>

      <FormField name="slug">
        <FormLabel>Address</FormLabel>
        <FormControl>
          <Input required placeholder="marina-properties" />
        </FormControl>
        <FormDescription>
          Lowercase letters, digits and single hyphens. Permanent — there is no rename path in this
          build.
        </FormDescription>
        <FormMessage />
      </FormField>
    </ActionForm>
  );
}
