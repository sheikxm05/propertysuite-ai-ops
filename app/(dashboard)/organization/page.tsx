/**
 * `/organization` — the organization summary and the invitation desk. Lane w1-l1.
 *
 * Two audiences on one page, separated by policy rather than by route:
 *
 *  - **Every role** sees the summary. The §4 matrix gives `organizations` "R own" to all
 *    five roles, and the values come from the membership this request already resolved,
 *    so no extra query is made to display a name the caller is entitled to.
 *  - **Only an `organization_admin`** sees the invitation desk. Gated here for clarity,
 *    by the route's `roles` option for enforcement, and by `0003`'s single SELECT policy
 *    on `organization_invitations` for the layer that holds when the other two are
 *    wrong.
 *
 * There is deliberately **no rename control**. `organizations` is read-only for every
 * role including `organization_admin`: `0002` revokes writes outright and §5.9 records
 * the decision as a deliberate non-change. A disabled input would imply the capability
 * exists; there is none.
 *
 * `select *` is never used against `organization_invitations` — see
 * `features/organizations/queries.ts`.
 */

import Link from 'next/link';
import { Ticket } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { InviteMemberForm } from '@/features/organizations/components/invite-member-form';
import { OnboardingPanel } from '@/features/organizations/components/onboarding-panel';
import { RevokeInvitationButton } from '@/features/organizations/components/revoke-invitation-button';
import { getOrganizationSummary, listInvitations } from '@/features/organizations/queries';
import { requireContext } from '@/features/organizations/server-context';
import { MEMBER_ROLE_LABELS, type Invitation, type InvitationStatus } from '@shared/index';

export const metadata = { title: 'Organization' };

/** Visual weight per invitation state. Presentation only. */
const STATUS_VARIANT: Record<InvitationStatus, 'warning' | 'success' | 'secondary'> = {
  pending: 'warning',
  accepted: 'success',
  revoked: 'secondary',
};

export default async function OrganizationPage() {
  const { supabase, membership } = await requireContext();

  if (!membership) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
          <p className="text-sm text-muted-foreground">You do not belong to an organization yet.</p>
        </header>
        <OnboardingPanel />
      </div>
    );
  }

  const summary = await getOrganizationSummary(supabase, membership);
  const isAdmin = membership.role === 'organization_admin';

  // Only fetched for an admin. A non-admin would receive an empty page from RLS anyway,
  // and not asking is cheaper than being refused.
  const invitations: Invitation[] = isAdmin
    ? (await listInvitations(supabase, membership, { limit: 50 })).items
    : [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{summary.name}</h1>
          <p className="text-sm text-muted-foreground">
            {summary.slug} · you are {MEMBER_ROLE_LABELS[summary.role].toLowerCase()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={summary.status === 'active' ? 'success' : 'destructive'}>
            {summary.status}
          </Badge>
          <Button asChild variant="outline" size="sm">
            <Link href="/organization/accept">
              <Ticket aria-hidden="true" />
              Redeem an invitation
            </Link>
          </Button>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Active members" value={summary.activeMembers} />
        <Stat label="Pending invitations" value={summary.pendingInvitations} />
        <Stat label="Your role" text={MEMBER_ROLE_LABELS[summary.role]} />
      </div>

      {!isAdmin ? (
        <Alert>
          <AlertDescription>
            Member management is restricted to organization administrators. You can see your
            organization and your own membership; the roster and the invitation list are not
            readable by this role, in the API or in the database.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Invite a member</CardTitle>
              <CardDescription>
                The invitation token is shown once and cannot be recovered. Hand it to the invitee
                yourself — only its SHA-256 hash is stored.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <InviteMemberForm />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Invitations</CardTitle>
              <CardDescription>
                Revoked and accepted invitations stay on the record. There is no delete path for any
                tenant-scoped row in this application.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {invitations.length === 0 ? (
                <p className="text-sm text-muted-foreground">No invitations yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.map((invitation) => (
                      <TableRow key={invitation.id}>
                        <TableCell className="font-medium">{invitation.email}</TableCell>
                        <TableCell>{MEMBER_ROLE_LABELS[invitation.role]}</TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[invitation.status]}>
                            {invitation.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {new Date(invitation.expires_at).toLocaleDateString('en-AE')}
                        </TableCell>
                        <TableCell className="text-right">
                          {invitation.status === 'pending' ? (
                            <RevokeInvitationButton
                              invitationId={invitation.id}
                              email={invitation.email}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * One summary figure. `null` renders as an em dash rather than zero: "this role cannot
 * count that" and "the count is nought" are different statements and the UI should not
 * conflate them.
 */
function Stat({ label, value, text }: { label: string; value?: number | null; text?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold">
          {text ?? (value === null || value === undefined ? '—' : value)}
        </p>
      </CardContent>
    </Card>
  );
}
