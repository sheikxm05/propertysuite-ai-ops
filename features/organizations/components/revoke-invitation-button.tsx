'use client';

/**
 * Revoke a pending invitation. Lane w1-l1.
 *
 * A POST to `/revoke`, not a DELETE: no tenant-scoped table in this application has a
 * DELETE path (CLAUDE.md rule 6). The row survives with `status = 'revoked'`, so the
 * record still shows that an invitation was issued and then withdrawn.
 *
 * The confirmation step is not ceremony. Revoking is irreversible in the sense that
 * matters — the token cannot be un-invalidated — so an accidental click costs the
 * invitee a round trip with their administrator.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Ban } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { ApiClientError, apiCall } from '../api-client';

export interface RevokeInvitationButtonProps {
  invitationId: string;
  /** Shown for context in the confirmation prompt. Not sent anywhere. */
  email: string;
}

export function RevokeInvitationButton({ invitationId, email }: RevokeInvitationButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setError(null);
    try {
      await apiCall(`/api/v1/members/invitations/${invitationId}/revoke`, { method: 'POST' });
      setConfirming(false);
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(
        cause instanceof ApiClientError ? cause.message : 'The invitation could not be revoked.',
      );
    }
  }

  if (!confirming) {
    return (
      <div className="space-y-1">
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          <Ban aria-hidden="true" />
          Revoke
        </Button>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Revoke the invitation for {email}?</p>
      <div className="flex gap-1">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          onClick={() => {
            void revoke();
          }}
        >
          Yes, revoke
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
