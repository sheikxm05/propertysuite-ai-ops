/**
 * `/tenancies/{tenancyId}` — one lease.
 *
 * The tenant panel on this page is present only when `getTenancyById` attached one, and
 * it attaches one only when the §4 matrix grants the caller access to `tenants`. So a
 * `property_owner` viewing a lease on their own building sees the term and the rent and
 * **no contact details** — not because this page hides them, but because they were never
 * fetched. A missing panel here is the matrix being enforced.
 */

import { notFound, redirect } from 'next/navigation';

import { TenancyPathParamsSchema } from '@shared/index';

import { isApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';

import { getTenancyById } from '@/features/tenancies/server/tenancy-service';
import { nextTenancyStatuses, asTenancyStatus } from '@/features/tenancies/lifecycle';
import {
  formatDate,
  formatMoney,
  tenancyStatusLabel,
  tenancyStatusTone,
} from '@/features/tenancies/format';
import { resolveViewer } from '@/features/tenants/server/viewer';

import Link from 'next/link';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Tenancy' };

const SIGN_IN = '/sign-in';

export default async function TenancyDetailPage({
  params,
}: {
  params: Promise<Record<string, string>>;
}) {
  const viewer = await resolveViewer('page:tenancies/[tenancyId]');
  if (!viewer) redirect(SIGN_IN);

  const parsed = TenancyPathParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const tenancy = await loadOrNotFound(() => getTenancyById(viewer, parsed.data.tenancyId));
  const status = asTenancyStatus(tenancy.status);
  const permitted = nextTenancyStatuses(status);

  return (
    <section className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tenancies" className="underline-offset-4 hover:underline">
            Tenancies
          </Link>
        }
        title={tenancy.contract_number ?? 'Tenancy'}
        description={tenancy.unit ? `Unit ${tenancy.unit.unit_number}` : 'Unit not visible to you'}
        actions={
          <Badge variant={tenancyStatusTone(status)} className="whitespace-nowrap">
            {tenancyStatusLabel(status)}
          </Badge>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Lease</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Field label="Starts" value={formatDate(tenancy.start_date)} />
            <Field label="Ends" value={formatDate(tenancy.end_date)} />
            <Field label="Rent" value={formatMoney(tenancy.rent_amount, tenancy.currency)} />
            <Field
              label="Permitted next states"
              value={permitted.length > 0 ? permitted.join(', ') : 'None — terminal'}
            />
          </dl>
        </CardContent>
      </Card>

      {tenancy.tenant ? (
        <Card>
          <CardHeader>
            <CardTitle>Tenant</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <Field label="Name" value={tenancy.tenant.full_name} />
              <Field label="Email" value={tenancy.tenant.email ?? '—'} />
              <Field label="Phone" value={tenancy.tenant.phone ?? '—'} />
              <Field label="Account linked" value={tenancy.tenant.profile_id ? 'Yes' : 'Not yet'} />
            </dl>
          </CardContent>
        </Card>
      ) : (
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Tenant details are not available to your role.
        </p>
      )}
    </section>
  );
}

/**
 * Turns a refusal into a 404 page.
 *
 * `NOT_FOUND` and a `FORBIDDEN` alike render as "not found", so a page cannot be used to
 * confirm that an identifier names a real tenancy in some other organization — the same
 * reasoning the API layer applies.
 */
async function loadOrNotFound<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (thrown) {
    if (thrown instanceof AuthorizationDeniedError) notFound();
    if (isApiRouteError(thrown) && (thrown.status === 404 || thrown.status === 403)) notFound();
    throw thrown;
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
