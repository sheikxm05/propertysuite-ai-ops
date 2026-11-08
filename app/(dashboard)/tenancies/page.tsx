/**
 * `/tenancies` — the register for staff and owners, the self-service view for a tenant.
 *
 * One route, two surfaces, chosen by the caller's resolved role rather than by a query
 * parameter. A tenant cannot reach the register by asking for it: the branch is on
 * `membership.role`, which came from `resolveMembership()`, and even if the branch were
 * wrong `listTenancies` would scope the rows to their own tenancy anyway.
 */

import { redirect } from 'next/navigation';

import { ListTenanciesQuerySchema } from '@shared/index';

import { listTenancies } from '@/features/tenancies/server/tenancy-service';
import { MyTenancy } from '@/features/tenancies/components/my-tenancy';
import { TenancyTable } from '@/features/tenancies/components/tenancy-table';
import { resolveViewer } from '@/features/tenants/server/viewer';

export const metadata = { title: 'Tenancies' };

/** `/sign-in` is frozen by amendment A17; `middleware.ts` matches it literally. */
const SIGN_IN = '/sign-in';

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TenanciesPage({ searchParams }: PageProps) {
  const viewer = await resolveViewer('page:tenancies');
  if (!viewer) redirect(SIGN_IN);

  if (viewer.membership.role === 'tenant') {
    return (
      <section className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">My tenancy</h1>
          <p className="text-sm text-muted-foreground">
            Your lease with {viewer.membership.organization.name}.
          </p>
        </header>
        <MyTenancy viewer={viewer} />
      </section>
    );
  }

  // The query string is validated by the same schema the API route uses, so an
  // unparseable `?limit=` fails here the same way it fails there instead of silently
  // becoming a default.
  const raw = (await searchParams) ?? {};
  const query = ListTenanciesQuerySchema.parse({
    cursor: first(raw.cursor),
    limit: first(raw.limit),
    status: first(raw.status),
    tenant_id: first(raw.tenant_id),
    property_unit_id: first(raw.property_unit_id),
  });

  const page = await listTenancies(viewer, query);

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tenancies</h1>
        <p className="text-sm text-muted-foreground">
          Leases in {viewer.membership.organization.name}. Rent and contract details are visible to
          staff and to the tenant named on the lease.
        </p>
      </header>

      <TenancyTable tenancies={page.items} />

      {page.hasMore && page.nextCursor ? (
        <a
          className="inline-flex text-sm underline underline-offset-4"
          href={`/tenancies?cursor=${encodeURIComponent(page.nextCursor)}`}
        >
          Next page
        </a>
      ) : null}
    </section>
  );
}

/** A repeated query key arrives as an array; the schemas accept one value. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
