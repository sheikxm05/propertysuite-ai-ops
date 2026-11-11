/**
 * `/tenancies` — the register for staff and owners, the self-service view for a tenant.
 *
 * One route, two surfaces, chosen by the caller's resolved role rather than by a query
 * parameter. A tenant cannot reach the register by asking for it: the branch is on
 * `membership.role`, which came from `resolveMembership()`, and even if the branch were
 * wrong `listTenancies` would scope the rows to their own tenancy anyway.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
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
        <PageHeader
          eyebrow={viewer.membership.organization.name}
          title="My tenancy"
          description="Your lease, and nobody else's. The register other roles see is the same route — the rows are what differ."
        />
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
      <PageHeader
        eyebrow={viewer.membership.organization.name}
        title="Tenancies"
        description="Rent and contract details are visible to staff and to the tenant named on the lease — and to nobody else, enforced in Postgres rather than by this page."
      />

      <TenancyTable tenancies={page.items} />

      {page.hasMore && page.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="secondary">
            <Link href={`/tenancies?cursor=${encodeURIComponent(page.nextCursor)}`}>Next page</Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** A repeated query key arrives as an array; the schemas accept one value. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
