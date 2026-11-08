'use client';

/**
 * Sign out. Lane w1-l1.
 *
 * A `<form>` posting to a server action, not an `onClick` handler calling
 * `supabase.auth.signOut()` in the browser. Two reasons, both about where the session
 * actually lives:
 *
 *  - The session is an HttpOnly cookie set by the server. A browser-side sign-out clears
 *    the client's own copy of the token and leaves the cookie for the next request to
 *    present. Only the server can unset it.
 *  - `signOut` uses `scope: 'global'`, which revokes every refresh token for the user
 *    rather than this browser's. That is the case a sign-out button most needs to cover,
 *    and it is not reachable from an anon-key client.
 *
 * A form also means this works with JavaScript disabled, which is the baseline a
 * sign-out control should meet.
 */

import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { signOut } from '@/app/(auth)/actions';

export function SignOutButton() {
  return (
    <form action={signOut}>
      <Button type="submit" variant="ghost" size="sm">
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </form>
  );
}
