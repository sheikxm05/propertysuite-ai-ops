'use client';

/**
 * The `/sign-up` form body. Lane w2-l3 (Wave 2 remediation).
 *
 * **Why this is a Client Component and not three more lines inside `page.tsx`.**
 * `FormControl` wires accessibility attributes onto its child with
 * `React.cloneElement(children, …)`, which first reads `children.props`. When the element
 * is *created inside a Server Component* it does not reach `FormControl` as an element:
 * it is serialised into the Flight stream and re-parsed on the other side, and React's
 * Flight client replaces an element whose dependencies are still in flight with a lazy
 * wrapper — `{ $$typeof: REACT_LAZY_TYPE, _payload, _init }` (`createLazyChunkWrapper`
 * in `react-server-dom-webpack-client`). A lazy has no `.props`, so `children.props.name`
 * threw `TypeError: Cannot read properties of undefined (reading 'name')` and `/sign-up`
 * returned HTTP 500 in production while returning 200 from `next dev`.
 *
 * Whether a given element is wrapped depends on chunk ordering, which is why the crash
 * moved between builds and hit `/sign-up` but not `/sign-in`. Authoring the fields here
 * removes the condition instead of dodging it: every element below is constructed on the
 * client, so `FormControl` always receives a real element.
 *
 * Nothing is validated here — `signUp` parses the submission server-side and its answer
 * is the only one. See `components/action-form.tsx`.
 */

import {
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

import { signUp } from '../actions';
import { ActionForm } from './action-form';

export function SignUpForm() {
  return (
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
  );
}
