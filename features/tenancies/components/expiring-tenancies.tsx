/**
 * The expiring-tenancies panel, rendered on the server.
 *
 * It queries through the same `listExpiringTenancies` the API route layer uses, so the
 * widget is scoped by the same role rules: a manager sees the organization's renewals, a
 * tenant sees their own, a service provider sees nothing. No data reaches a client
 * bundle — a rent figure and a contract number are personal financial data and have no
 * business being serialised into a page's RSC payload any wider than it is rendered.
 *
 * Contract-expiry *reminders* are later-phase scope (`docs/requirements.md` §4). This is
 * the read-only view that makes the window visible now.
 */

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { expiryVariant } from '@/components/ui/status';

import { resolveViewer } from '@/features/tenants/server/viewer';
import { listExpiringTenancies } from '@/features/tenancies/server/tenancy-service';
import { todayIsoDate } from '@/features/tenancies/occupancy';
import { daysBetween, formatDate, formatMoney } from '@/features/tenancies/format';

/** Renewal window. Sixty days is the usual notice period for a Dubai tenancy contract. */
const WINDOW_DAYS = 60;

export async function ExpiringTenanciesPanel() {
  const viewer = await resolveViewer('widget:tenancies');
  if (!viewer) return <EmptyState message="Sign in to see upcoming renewals." />;

  const tenancies = await listExpiringTenancies(viewer, { withinDays: WINDOW_DAYS, limit: 8 });
  if (tenancies.length === 0) {
    return <EmptyState message={`No tenancies end in the next ${WINDOW_DAYS} days.`} />;
  }

  const today = todayIsoDate();

  return (
    <ul className="divide-y divide-border">
      {tenancies.map((tenancy) => {
        const remaining = daysBetween(today, tenancy.end_date);
        return (
          <li key={tenancy.id} className="flex items-center justify-between gap-4 py-2 text-sm">
            <div className="min-w-0">
              <Link
                href={`/tenancies/${tenancy.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {tenancy.contract_number ?? 'Tenancy'}
              </Link>
              <p className="text-muted-foreground">
                Ends {formatDate(tenancy.end_date)} ·{' '}
                {formatMoney(tenancy.rent_amount, tenancy.currency)}
              </p>
            </div>
            {/* `expiryVariant` is the shared rule: inside the notice window a renewal is
                an outstanding human decision (amber), at or past due it is urgent (red). */}
            <Badge variant={expiryVariant(remaining)} className="shrink-0 tabular-nums">
              {remaining <= 0 ? 'Ends today' : `${remaining} days`}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="py-2 text-sm text-muted-foreground">{message}</p>;
}
