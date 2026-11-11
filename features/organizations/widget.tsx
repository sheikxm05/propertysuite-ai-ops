import { Building2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { DashboardWidget, DashboardWidgetProps } from '@/config/types';
import { MEMBER_ROLES, MEMBER_ROLE_LABELS, isMemberRole } from '@shared/index';

import { getOrganizationSummary } from './queries';
import { currentContext } from './server-context';

/**
 * Organization summary widget. Lane w1-l1 — this file replaces w0-l1's pre-stub.
 *
 * **Why every role gets this one.** The stub reserved it for `organization_admin`;
 * `key` and `order` are kept exactly as the registry expects, but `roles` is widened to
 * all five. Naming the organization and the role on every dashboard is what makes the
 * isolation story legible: a tenant in Organization A and a tenant in Organization B see
 * two different names in the same component, which is the demo beat that criterion 2
 * exists for. It discloses nothing — `organizations` is "R own" for every role in the §4
 * matrix, and the values come from the caller's own membership.
 *
 * The component is an async server component. It resolves its own context because the
 * widget contract (`config/types.ts`) passes only `role`, and that is the right shape:
 * a widget that received a client could be handed the wrong one. Resolution goes through
 * the same `currentContext()` every page uses, so membership still comes from trusted
 * rows and nothing is read from a cookie or a prop.
 *
 * `role` is still used, as a cross-check rather than as an input: if the role the shell
 * passed down disagrees with the role resolved from the database, the widget says so
 * instead of rendering either. That can only happen through a defect, and a visible
 * contradiction is better than a confident wrong answer.
 */
async function OrganizationWidget({ role }: DashboardWidgetProps) {
  const context = await currentContext();

  if (!context?.membership) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" aria-hidden="true" />
            Organization
          </CardTitle>
          <CardDescription>You do not belong to an organization yet.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { supabase, membership } = context;

  if (isMemberRole(role) && role !== membership.role) {
    // Never silently prefer one source over the other. The shell's role and the
    // database's role must agree; if they do not, the defect is the story.
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Organization</CardTitle>
          <CardDescription>
            Role mismatch between the shell and the database. Sign out and in again.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const summary = await getOrganizationSummary(supabase, membership);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="size-4" aria-hidden="true" />
          {summary.name}
        </CardTitle>
        <CardDescription>{summary.slug}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{MEMBER_ROLE_LABELS[summary.role]}</Badge>
          <Badge variant={summary.status === 'active' ? 'success' : 'destructive'}>
            {summary.status}
          </Badge>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Members</dt>
            {/* `null` means "this role cannot count that", which is not zero. */}
            <dd className="text-lg font-semibold">{summary.activeMembers ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">
              Pending invites
            </dt>
            <dd className="text-lg font-semibold">{summary.pendingInvitations ?? '—'}</dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">
          Everything on this dashboard is scoped to this organization by trusted database rows, not
          by anything your browser sent.
        </p>
      </CardContent>
    </Card>
  );
}

export const widget: DashboardWidget = {
  // This widget draws its own <Card>; the dashboard must not wrap it again.
  chrome: 'none',
  key: 'organizations',
  title: 'Organization',
  roles: MEMBER_ROLES,
  span: 1,
  order: 10,
  enabled: true,
  Component: OrganizationWidget,
};
