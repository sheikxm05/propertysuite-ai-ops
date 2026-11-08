/**
 * `/maintenance/new` — report an issue.
 *
 * Reachable by the roles in `TICKET_CREATE_ROLES` (organization admin, property manager,
 * tenant). A `service_provider` or `property_owner` landing here is shown an explanation
 * rather than a form: the POST route gates on the same shared constant, so a form they
 * could fill in but never submit would be a worse answer than no form.
 *
 * The unit picker is built from `listReportableUnits()`, which is RLS-scoped — a tenant
 * is offered only units they lease. That is convenience, not authorization: the create
 * path re-derives the authorization from an ACTIVE TENANCY row, and
 * `maintenance_tickets_insert_tenant` checks `can_access_unit()` and
 * `unit_belongs_to_property()` independently. A tampered form field produces a 422, not a
 * ticket on somebody else's unit.
 */

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { TICKET_CREATE_ROLES, type MemberRole } from '@shared/index';
import { CreateTicketForm } from '@/features/maintenance/components/create-ticket-form';
import { listReportableUnits } from '@/features/maintenance/domain';
import { maintenancePageContext } from '@/features/maintenance/server-context';

export const metadata = { title: 'Report an issue' };

export default async function NewTicketPage() {
  const { supabase, membership, logger } = await maintenancePageContext();

  // Widened for the same reason as on the list page: the shared constant is a narrow
  // three-literal tuple, and `.includes()` must be asked about the full role union.
  if (!membership || !(TICKET_CREATE_ROLES as readonly MemberRole[]).includes(membership.role)) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Report an issue</h1>
        <p className="text-sm text-muted-foreground">
          Your role cannot raise maintenance tickets. A tenant reports an issue on a unit they
          lease, and a manager can raise one on a tenant&apos;s behalf.
        </p>
        <Button asChild variant="secondary">
          <Link href="/maintenance">Back to maintenance</Link>
        </Button>
      </div>
    );
  }

  const units = await listReportableUnits({ supabase, membership, logger });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Report an issue</h1>
        <p className="text-sm text-muted-foreground">
          The ticket is created in the <code>open</code> state. A manager triages it and assigns a
          provider.
        </p>
      </div>
      <CreateTicketForm units={units} />
    </div>
  );
}
