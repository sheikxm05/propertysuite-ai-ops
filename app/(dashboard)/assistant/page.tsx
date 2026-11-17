/**
 * `/assistant` — the conversational surface, and the human approval gate.
 *
 * This is the screen the whole security argument points at. Everywhere else the product
 * states "AI drafts, humans commit" in documentation; here it is on screen, with a button
 * that is the only way a model-authored action can ever become a database row.
 *
 * THE SERVER'S THREE JOBS, AND THEY ARE ALL IT DOES
 * -------------------------------------------------
 *  1. Resolve the membership from trusted rows. The role is never read from a cookie, a
 *     header or a query string (CLAUDE.md rule 5).
 *  2. Decide what to *draw* — `isStaffRole()`, the application-space twin of the
 *     `is_org_staff()` predicate that `approve_agent_proposal(p_id)` checks. Two
 *     implementations of one rule, deliberately: the UI one can be wrong without being
 *     dangerous, because the SQL one runs regardless.
 *  3. Hand both facts to a client component and get out of the way.
 *
 * Note what is NOT here: no agent call, no proposal query, no Supabase read at all beyond
 * membership. Every turn is a POST from the browser to `/api/v1/ai/agent/run`, which
 * re-authorizes on its own. A page that pre-fetched agent output would be a page that
 * could leak it into a shared render cache.
 *
 * WHY A TENANT DOES NOT GET A COMPOSER
 * ------------------------------------
 * Both agent routes gate on `STAFF_ROLES`, and the run route says why: the agent reasons
 * about assignments and priorities, which are staff decisions, and the approval RPC checks
 * the same predicate — so a tenant typing here would get a 403 from the first keystroke
 * that mattered. The same principle that removes the Approve button from a non-staff
 * proposal card removes the composer from a non-staff visit: do not offer a control that
 * the server will refuse. A tenant's AI surface is `/maintenance/report`, which is built
 * for exactly their authority, and this page sends them there.
 *
 * Rendered dynamically — `assistantPageContext()` reads cookies, so Next treats this
 * segment as dynamic and no tenant-scoped markup is served from a shared cache.
 */

import Link from 'next/link';
import { Bot, Eye, Lock, ShieldCheck, Sparkles } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MEMBER_ROLE_LABELS, isStaffRole, type MemberRole } from '@shared/index';
import { AssistantConsole } from '@/features/ai-agent';
import { assistantPageContext } from '@/features/ai-agent/server-context';

export const metadata = { title: 'Assistant' };

export default async function AssistantPage() {
  const { membership } = await assistantPageContext();

  if (!membership) {
    return (
      <div className="space-y-6">
        <PageHeader title="Assistant" />
        <EmptyState
          icon={Bot}
          title="No organization yet"
          description="The assistant answers questions about one organization's records, so it needs you to be a member of one. Redeem an invitation and it appears here."
          action={
            <Button asChild variant="outline">
              <Link href="/organization/accept">Redeem an invitation</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const role = membership.role;
  const staff = isStaffRole(role);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={membership.organization.name}
        title="Assistant"
        description="Ask about units, tenancies, recent tickets, providers and documents. The assistant reads your organization's records on its own. Anything that would change a record stops and waits for a human."
        actions={
          staff ? (
            <Badge variant="success" className="gap-1.5 px-3 py-1">
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              You can approve actions
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1.5 px-3 py-1">
              <Lock className="size-3.5" aria-hidden="true" />
              Staff only
            </Badge>
          )
        }
      />

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-base">How this works</CardTitle>
          <CardDescription>
            The two-class split the server enforces, stated before you use it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Rule
            icon={Eye}
            badge={<Badge variant="secondary">Runs immediately</Badge>}
            title="Reading is free"
            body="Looking up a unit, a tenancy, recent tickets, providers or documents changes nothing, so the assistant does it without asking. Every lookup it makes is listed in the transcript."
          />
          <Rule
            icon={Sparkles}
            badge={<Badge variant="warning">Waits for a human</Badge>}
            title="Acting is only proposed"
            body="Creating a ticket, assigning a provider or changing a priority is never carried out by the assistant. It writes a proposal and stops, and the proposal stays amber until a person decides."
          />
          <Rule
            icon={ShieldCheck}
            badge={<Badge variant="outline">Enforced in Postgres</Badge>}
            title="And not just on this screen"
            body="UPDATE on the proposals table is revoked from every browser session and there is no update policy, so the only route from pending to approved is a security-definer function that re-checks your role."
          />
        </CardContent>
      </Card>

      {staff ? (
        <AssistantConsole
          canApprove
          roleLabel={articleFor(role)}
          displayName={membership.profile.fullName}
          starters={STAFF_STARTERS}
        />
      ) : (
        <EmptyState
          icon={Lock}
          title="The assistant is available to organization staff"
          description={
            <>
              You are signed in as {articleFor(role)}. Both agent endpoints admit organization
              administrators and property managers only — the agent reasons about assignments and
              priorities, which are staff decisions, and the function that approves its proposals
              checks the same roles. There is no composer here because the server would refuse the
              request, and showing you one would misrepresent that.
              {role === 'tenant' ? (
                <> Reporting a problem is yours to do, and it has its own AI-assisted screen.</>
              ) : null}
            </>
          }
          action={
            role === 'tenant' ? (
              <Button asChild>
                <Link href="/maintenance/report">Report an issue instead</Link>
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link href="/maintenance">Go to maintenance</Link>
              </Button>
            )
          }
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers -- */

function Rule({
  icon: Icon,
  badge,
  title,
  body,
}: {
  icon: typeof Eye;
  badge: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        {badge}
      </div>
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="text-pretty text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * One-click openers that exercise both halves of the split: the first two should answer
 * from read tools alone, the third should end in a proposal with an Approve button under
 * it. That ordering is what makes the boundary legible in a two-minute demonstration.
 */
const STAFF_STARTERS: readonly string[] = [
  'What is going on with unit 1204?',
  'Which service providers do we work with?',
  'Unit 1204 reports the AC is running but not cooling. Raise a ticket for it.',
];

/**
 * "a property manager" / "an organization administrator".
 *
 * Built from `MEMBER_ROLE_LABELS` rather than a second table of role names, so a label
 * change in `packages/shared` reaches these sentences too.
 */
function articleFor(role: MemberRole): string {
  const label = MEMBER_ROLE_LABELS[role];
  const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
  return `${article} ${label.toLowerCase()}`;
}
