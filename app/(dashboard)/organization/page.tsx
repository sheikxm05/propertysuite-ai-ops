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
import { MailPlus, Ticket } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { type StatusVariant } from '@/components/ui/status';
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

/**
 * Visual weight per invitation state.
 *
 * `components/ui/status.ts` holds the mapping for every status that is a column on a
 * tenant-scoped table; `organization_invitations.status` is not one of its seven, so the
 * table lives here — but it follows the same rule rather than inventing one: amber while
 * a human still has to act, green once they have, and inert grey once it is spent.
 */
const STATUS_VARIANT: Record<InvitationStatus, StatusVariant> = {
  pending: 'warning',
  accepted: 'success',
  revoked: 'outline',
};

export default async function OrganizationPage() {
  const { supabase, membership } = await requireContext();

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Organization"
          description="You do not belong to an organization yet. Create one and become its administrator, or redeem the invitation an administrator sent you."
        />
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
      <PageHeader
        eyebrow="Organization"
        title={summary.name}
        description={`${summary.slug} · you are ${MEMBER_ROLE_LABELS[summary.role].toLowerCase()}`}
        actions={
          <>
            <Badge
              variant={summary.status === 'active' ? 'success' : 'destructive'}
              className="whitespace-nowrap"
            >
              {summary.status}
            </Badge>
            <Button asChild variant="outline" size="sm">
              <Link href="/organization/accept">
                <Ticket aria-hidden="true" />
                Redeem an invitation
              </Link>
            </Button>
          </>
        }
      />

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
                <EmptyState
                  icon={MailPlus}
                  title="No invitations yet"
                  description="Invite somebody with the form above. The token appears once, you hand it over yourself, and only its hash is stored."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead className="hidden md:table-cell">Role</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead numeric className="hidden sm:table-cell">
                        Expires
                      </TableHead>
                      <TableHead numeric>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invitations.map((invitation) => (
                      <TableRow key={invitation.id}>
                        <TableCell className="font-medium">{invitation.email}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          {MEMBER_ROLE_LABELS[invitation.role]}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={STATUS_VARIANT[invitation.status]}
                            className="whitespace-nowrap"
                          >
                            {invitation.status}
                          </Badge>
                        </TableCell>
                        <TableCell
                          numeric
                          className="hidden text-sm text-muted-foreground sm:table-cell"
                        >
                          {new Date(invitation.expires_at).toLocaleDateString('en-AE')}
                        </TableCell>
                        <TableCell numeric>
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
        <p className="numeric text-2xl font-semibold">
          {text ?? (value === null || value === undefined ? '—' : value)}
        </p>
      </CardContent>
    </Card>
  );
}
