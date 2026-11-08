'use client';

/**
 * Issue an invitation, and show its token once. Lane w1-l1.
 *
 * **The one-time token is the whole reason this component is careful.**
 * `invite_member` returns the plaintext token exactly once; `organization_invitations`
 * stores only a SHA-256 hash, so once this panel is dismissed the value cannot be
 * recovered from anywhere — not by an administrator, not by a database read, not by a
 * support engineer. It can only be reissued by revoking and inviting again.
 *
 * So the token is:
 *
 *  - rendered once, on an explicit panel that says it will not be shown again;
 *  - held in component state only, never in a URL, `localStorage`, a cookie or a
 *    server-rendered page;
 *  - cleared when the admin dismisses the panel or issues another invitation;
 *  - never sent anywhere. The copy button uses the clipboard API and falls back to the
 *    selectable text when the browser refuses — a demo over plain HTTP, for instance,
 *    where `navigator.clipboard` is unavailable.
 *
 * Role is a `<select>` over `MEMBER_ROLES` from `packages/shared`, so the option list
 * cannot drift from the Postgres enum. The server re-validates it against
 * `InviteMemberSchema` regardless; this list is convenience, not enforcement.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Copy, Mail } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormLabel } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { MEMBER_ROLES, MEMBER_ROLE_LABELS, type InviteMemberResult } from '@shared/index';

import { ApiClientError, apiCall } from '../api-client';

export function InviteMemberForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<InviteMemberResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(formData: FormData) {
    setError(null);
    setIssued(null);
    setCopied(false);

    const body = {
      email: String(formData.get('email') ?? ''),
      role: String(formData.get('role') ?? ''),
    };

    try {
      const result = await apiCall<InviteMemberResult>('/api/v1/members', {
        method: 'POST',
        body,
      });
      setIssued(result);
      // Refresh the server-rendered invitation list beside this form.
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(
        cause instanceof ApiClientError ? cause.message : 'The invitation could not be sent.',
      );
    }
  }

  function copyToken(token: string) {
    void navigator.clipboard
      ?.writeText(token)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  }

  return (
    <div className="space-y-4">
      <Form
        action={(formData: FormData) => {
          void submit(formData);
        }}
      >
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <FormField name="email">
          <FormLabel>Email address</FormLabel>
          <FormControl>
            <Input type="email" autoComplete="off" required />
          </FormControl>
          <FormDescription>
            The invitation can only be redeemed by an account with this exact address.
          </FormDescription>
        </FormField>

        <FormField name="role">
          <FormLabel>Role</FormLabel>
          <FormControl>
            <select
              name="role"
              required
              defaultValue="tenant"
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
            >
              {MEMBER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {MEMBER_ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </FormControl>
          <FormDescription>
            Decides what the member can see and do. Changeable afterwards from the member list.
          </FormDescription>
        </FormField>

        <Button type="submit" disabled={pending}>
          <Mail aria-hidden="true" />
          Send invitation
        </Button>
      </Form>

      {issued ? (
        <Alert variant="warning">
          <AlertTitle>Copy this token now — it will not be shown again</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              Give it to the invitee yourself. Only a SHA-256 hash of it is stored, so nobody —
              including you — can read it back. If it is lost, revoke the invitation and issue a new
              one.
            </p>
            <code className="block select-all break-all rounded-md border bg-background p-2 font-mono text-xs">
              {issued.token}
            </code>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => copyToken(issued.token)}
              >
                <Copy aria-hidden="true" />
                {copied ? 'Copied' : 'Copy token'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setIssued(null)}>
                I have saved it
              </Button>
            </div>
            <p className="text-xs">
              Expires {new Date(issued.expires_at).toLocaleString('en-AE')}.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
