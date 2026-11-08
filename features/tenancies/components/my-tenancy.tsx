/**
 * Tenant self-service — "my tenancy".
 *
 * This is the acceptance criterion "a signed-in tenant sees their own tenancy and
 * provably cannot read another's" as a screen. It has no identifier parameter: the only
 * thing it can render is whatever `listOwnTenancies` returns, which filters
 * `tenant_id` to the membership's `tenants.id` — resolved from
 * `tenants.profile_id = <verified session's profile>` — and which `0002`'s
 * `tenancies_select_own` filters again inside Postgres.
 *
 * There is no way to make this component show somebody else's lease short of changing
 * its source, which is the property the demo relies on: sign in as the second tenant and
 * the figures change, with no request that could have been tampered with in between.
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { DataContext } from '@/features/tenants/server/context';

import { listOwnTenancies } from '@/features/tenancies/server/tenancy-service';
import { asTenancyStatus } from '@/features/tenancies/lifecycle';
import { todayIsoDate } from '@/features/tenancies/occupancy';
import {
  daysBetween,
  formatDate,
  formatMoney,
  tenancyStatusLabel,
  tenancyStatusTone,
} from '@/features/tenancies/format';

export async function MyTenancy({ viewer }: { viewer: DataContext }) {
  const tenancies = await listOwnTenancies(viewer);

  if (tenancies.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No tenancy on record</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Your organization has not linked a tenancy to your account yet. Your property manager can
          do this from the tenant record.
        </CardContent>
      </Card>
    );
  }

  const today = todayIsoDate();

  return (
    <div className="grid gap-4">
      {tenancies.map((tenancy) => {
        const status = asTenancyStatus(tenancy.status);
        const remaining = daysBetween(today, tenancy.end_date);

        return (
          <Card key={tenancy.id}>
            <CardHeader className="flex-row items-center justify-between gap-4">
              <CardTitle>
                {tenancy.unit ? `Unit ${tenancy.unit.unit_number}` : 'My tenancy'}
              </CardTitle>
              <Badge variant={tenancyStatusTone(status)}>{tenancyStatusLabel(status)}</Badge>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <Field label="Contract number" value={tenancy.contract_number ?? '—'} />
                <Field label="Rent" value={formatMoney(tenancy.rent_amount, tenancy.currency)} />
                <Field label="Starts" value={formatDate(tenancy.start_date)} />
                <Field
                  label="Ends"
                  value={`${formatDate(tenancy.end_date)}${
                    status === 'active' && remaining >= 0 ? ` · in ${remaining} days` : ''
                  }`}
                />
              </dl>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
