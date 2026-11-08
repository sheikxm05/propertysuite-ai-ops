'use client';

/**
 * Change a member's role, or disable them. Lane w1-l1.
 *
 * Rendered only for an `organization_admin`, and that is the *third* place the rule is
 * enforced rather than the first: `PATCH /api/v1/members/{memberId}` gates on the role
 * before it parses the body, and `0002`'s `organization_members_update_admin` policy
 * denies the statement in Postgres. Hiding the control is presentation — a hidden button
 * must never be the only thing standing between a user and a privileged write.
 *
 * `status` offers `active` and `disabled` only. `invited` belongs to the invitation flow
 * and `UpdateMemberSchema` does not accept it; there is no "remove" option at all,
 * because disabling is the removal mechanism (CLAUDE.md rule 6).
 *
 * A refusal is rendered verbatim from the frozen error envelope. The most interesting one
 * is the 409 an administrator gets for demoting the organization's last active admin —
 * see `features/organizations/members.ts` for why that is an application-layer invariant
 * the database cannot express.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import {
  MEMBER_ROLES,
  MEMBER_ROLE_LABELS,
  type Member,
  type MemberRole,
  type MemberStatus,
} from '@shared/index';

import { ApiClientError, apiCall } from '../api-client';

export interface MemberRoleControlProps {
  memberId: string;
  role: MemberRole;
  status: MemberStatus;
  /** True when this row is the signed-in administrator's own membership. */
  isSelf: boolean;
}

/** The two statuses an administrator may set. Mirrors `UpdateMemberSchema`. */
const SETTABLE_STATUSES = ['active', 'disabled'] as const;

export function MemberRoleControl({ memberId, role, status, isSelf }: MemberRoleControlProps) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [draftRole, setDraftRole] = useState<string>(role);
  const [draftStatus, setDraftStatus] = useState<string>(status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = draftRole !== role || draftStatus !== status;

  async function save() {
    setError(null);
    setBusy(true);

    // Only changed fields are sent. `UpdateMemberSchema` is `.strict()` and requires at
    // least one field, so an unchanged submission would be a 400 — which is correct, and
    // is why the button is disabled until something changes.
    const body: { role?: string; status?: string } = {};
    if (draftRole !== role) body.role = draftRole;
    if (draftStatus !== status) body.status = draftStatus;

    try {
      await apiCall<Member>(`/api/v1/members/${memberId}`, { method: 'PATCH', body });
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof ApiClientError ? cause.message : 'The change could not be saved.');
      // Put the controls back to the server's truth rather than leaving a rejected draft
      // on screen looking applied.
      setDraftRole(role);
      setDraftStatus(status);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`role-${memberId}`}>
          Role
        </label>
        <select
          id={`role-${memberId}`}
          value={draftRole}
          onChange={(event) => setDraftRole(event.target.value)}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
        >
          {MEMBER_ROLES.map((option) => (
            <option key={option} value={option}>
              {MEMBER_ROLE_LABELS[option]}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={`status-${memberId}`}>
          Status
        </label>
        <select
          id={`status-${memberId}`}
          value={draftStatus}
          onChange={(event) => setDraftStatus(event.target.value)}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
        >
          {SETTABLE_STATUSES.map((option) => (
            <option key={option} value={option}>
              {option === 'active' ? 'Active' : 'Disabled'}
            </option>
          ))}
          {/* An `invited` row is shown but cannot be selected: the invitation flow owns
              that state and `UpdateMemberSchema` does not accept it. */}
          {status === 'invited' ? (
            <option value="invited" disabled>
              Invited
            </option>
          ) : null}
        </select>

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!dirty || busy || refreshing}
          onClick={() => {
            void save();
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {isSelf ? (
        <p className="text-xs text-muted-foreground">
          This is you. An organization must keep at least one active administrator, so the last one
          cannot be demoted.
        </p>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
