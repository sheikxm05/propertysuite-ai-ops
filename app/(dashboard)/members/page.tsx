/**
 * `/members` — the member roster. Lane w1-l1.
 *
 * **This page is a demonstration surface as much as a management screen.** It is
 * deliberately not gated to administrators. Every role may open it, and what comes back
 * is decided by the two SELECT policies in `0002`:
 *
 *   organization_members_select_staff   admin, manager and owner see the whole roster
 *   organization_members_select_self    everyone else sees exactly one row — their own
 *
 * So a tenant who navigates here sees themselves and nobody else, with no code on this
 * page making that happen. That is acceptance criterion 2 visible on screen rather than
 * only asserted in a test — and it is why hiding the page would be the wrong choice.
 *
 * Personal columns are a second decision on top of the row decision.
 * `features/organizations/queries.ts` runs every embedded profile through
 * `authorize(…, 'read', { type: 'profile', … })` and drops `email` and `phone` when the
 * matrix withholds them, because row-level security is row-level and cannot hide a
 * column.
 *
 * Role controls render only for an `organization_admin`, which is the third and least
 * important layer: `PATCH /api/v1/members/{memberId}` gates on the role before parsing
 * the body, and `organization_members_update_admin` denies the statement in Postgres.
 */

import Link from 'next/link';
import { Users } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MEMBER_STATUS_STYLE } from '@/components/ui/status';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MemberRoleControl } from '@/features/organizations/components/member-role-control';
import { OnboardingPanel } from '@/features/organizations/components/onboarding-panel';
import { listMembers } from '@/features/organizations/queries';
import { requireContext } from '@/features/organizations/server-context';
import { MEMBER_ROLE_LABELS } from '@shared/index';

export const metadata = { title: 'Members' };

export default async function MembersPage() {
  const { supabase, membership } = await requireContext();

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Members"
          description="You do not belong to an organization yet. Create one and become its administrator, or redeem an invitation to join an existing one."
        />
        <OnboardingPanel />
      </div>
    );
  }

  const page = await listMembers(supabase, membership, { limit: 50 });
  const isAdmin = membership.role === 'organization_admin';
  const seesOnlySelf =
    page.items.length === 1 && page.items[0]?.profile_id === membership.profile.id;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={membership.organization.name}
        title="Members"
        description="Who belongs to this organization, and with what role. What you can see of this roster is decided by two policies in Postgres, not by this page."
        actions={
          isAdmin ? (
            <Button asChild variant="outline">
              <Link href="/organization">Invite somebody</Link>
            </Button>
          ) : null
        }
      />

      {seesOnlySelf && !isAdmin ? (
        <Alert>
          <AlertDescription>
            Your role can see its own membership and no other. The roster below is the whole of what
            the database will return to you — nothing is being hidden by this page.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Roster</CardTitle>
          <CardDescription>
            Removing somebody means disabling them. The row, its history and its audit trail stay.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {page.items.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No members are visible to you"
              description="An empty roster is not a missing record: it is what the select policies return to a role that may not read the organization's membership."
              action={
                isAdmin ? (
                  <Button asChild variant="outline">
                    <Link href="/organization">Invite somebody</Link>
                  </Button>
                ) : null
              }
            />
          ) : (
            <Table>
              {page.hasMore ? (
                <TableCaption>
                  Showing the first {page.limit}. More exist — pagination continues through the API
                  with the cursor it returned.
                </TableCaption>
              ) : null}
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  {/* Contact folds away below `sm`; the name, role and status are what a
                      roster is read for. */}
                  <TableHead className="hidden sm:table-cell">Contact</TableHead>
                  <TableHead className="hidden md:table-cell">Role</TableHead>
                  <TableHead>Status</TableHead>
                  {isAdmin ? <TableHead numeric>Change</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.map((member) => {
                  const isSelf = member.profile_id === membership.profile.id;
                  return (
                    <TableRow key={member.id}>
                      <TableCell className="font-medium">
                        {member.profile?.full_name ?? 'Not visible to you'}
                        {isSelf ? (
                          <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                        {/*
                          Withheld by the matrix rather than missing from the database.
                          An em dash is the honest rendering of "you may not read this".
                        */}
                        {member.profile?.email ?? '—'}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {MEMBER_ROLE_LABELS[member.role]}
                      </TableCell>
                      <TableCell>
                        {/* One table decides what every status colour means; see
                            `components/ui/status.ts`. Invited is amber because somebody
                            still has to act on it. */}
                        <Badge
                          variant={MEMBER_STATUS_STYLE[member.status].variant}
                          className="whitespace-nowrap"
                        >
                          {MEMBER_STATUS_STYLE[member.status].label}
                        </Badge>
                      </TableCell>
                      {isAdmin ? (
                        <TableCell numeric>
                          <MemberRoleControl
                            memberId={member.id}
                            role={member.role}
                            status={member.status}
                            isSelf={isSelf}
                          />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
