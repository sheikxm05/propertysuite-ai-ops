/**
 * `/maintenance/report` — the AI-assisted intake surface.
 *
 * This page exists only to mount lane w1-l5's panel. The slot `features/ai-intake/nav.ts`
 * reserved points here, but the route lives under `app/(dashboard)/maintenance/**`, which
 * is this lane's glob — so w1-l5 exported `ReportIssuePanel` ready to mount and reported
 * the gap rather than reaching across. Without this file the sidebar link 404s for every
 * tenant, which is the A17 failure mode exactly: a link that looks right and goes nowhere.
 *
 * TWO THINGS THIS PAGE MUST NOT DO, both of them the point of the lane it is hosting:
 *
 *  1. **It adds no shortcut to ticket creation.** The panel produces a DRAFT and owns its
 *     own confirm step; the confirmation POSTs to `/api/v1/ai/maintenance/confirm`, which
 *     re-derives unit authorization from the session. There is deliberately no `<form>`,
 *     no action and no fetch in this file — nothing here can reach
 *     `POST /api/v1/maintenance/tickets` on the model's behalf. "AI drafts, humans
 *     commit" is only true if no surface offers a way around the commit.
 *  2. **It reimplements none of the panel's behaviour.** `features/ai-intake/**` is
 *     read-only to this lane. The panel is mounted with its own props and nothing else.
 *
 * ACCESS: tenants only, matching `navEntry.roles` in `features/ai-intake/nav.ts`. §4
 * grants `ai_conversations` / `ai_messages` create to `tenant` alone — a manager would
 * authenticate, render the panel, and then be refused by a Postgres policy on the first
 * conversation insert. So staff are sent to the deterministic create flow at
 * `/maintenance/new` instead of being shown a panel that cannot work for them. This gate
 * is a courtesy, not a security boundary: the AI routes re-authorize, and RLS denies
 * independently.
 *
 * The unit picker is populated from this lane's `listReportableUnits()`, which is
 * RLS-scoped, because w1-l5 owns no units endpoint. `ReportableUnit` is structurally
 * `UnitOption` — `{ id, label }` — so the list is passed straight through. A tenant with a
 * single tenancy gets no picker at all: the panel omits it and the server resolves the
 * unit from the session.
 */

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { ReportIssuePanel } from '@/features/ai-intake';
import { listReportableUnits } from '@/features/maintenance/domain';
import { maintenancePageContext } from '@/features/maintenance/server-context';

export const metadata = { title: 'Report an issue' };

export default async function ReportIssuePage() {
  const { supabase, membership, logger } = await maintenancePageContext();

  if (!membership) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          You are not an active member of an organization yet, so there is nothing to report
          against.
        </p>
      </Shell>
    );
  }

  if (membership.role !== 'tenant') {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">
          Assisted intake is for tenants describing a problem in their own home. Staff raise a
          ticket directly, which records who it was raised on behalf of.
        </p>
        <Button asChild>
          <Link href="/maintenance/new">Raise a ticket</Link>
        </Button>
      </Shell>
    );
  }

  const units = await listReportableUnits({ supabase, membership, logger });

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Report an issue</h1>
        <p className="text-sm text-muted-foreground">
          Describe the problem in your own words. Nothing is filed until you review the draft and
          confirm it.
        </p>
      </div>

      <ReportIssuePanel units={units} />

      <p className="text-sm text-muted-foreground">
        Prefer to fill in the details yourself?{' '}
        <Link href="/maintenance/new" className="underline underline-offset-4">
          Use the plain form
        </Link>
        .
      </p>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Report an issue</h1>
      {children}
    </div>
  );
}
