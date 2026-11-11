/**
 * `/tenants` — the tenant directory. Staff only.
 *
 * There is no sidebar entry for this page, and that is not an omission: `FEATURE_KEYS`
 * in `config/types.ts` has six keys and `tenants` is not one of them, so a seventh nav
 * entry would mean editing `config/**`, which this lane does not own (§0 mechanism 3).
 * The directory is reached from a tenancy or by URL, and `listTenants` refuses every
 * non-staff caller before a query exists — a hidden link was never the control.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ShieldOff } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { ListTenantsQuerySchema } from '@shared/index';

import { AuthorizationDeniedError } from '@/lib/auth/authorize';

import { listTenants } from '@/features/tenants/server/tenant-service';
import { TenantTable } from '@/features/tenants/components/tenant-table';
import { resolveViewer } from '@/features/tenants/server/viewer';

export const metadata = { title: 'Tenants' };

const SIGN_IN = '/sign-in';

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TenantsPage({ searchParams }: PageProps) {
  const viewer = await resolveViewer('page:tenants');
  if (!viewer) redirect(SIGN_IN);

  const raw = (await searchParams) ?? {};
  const query = ListTenantsQuerySchema.parse({
    cursor: first(raw.cursor),
    limit: first(raw.limit),
    q: first(raw.q),
  });

  let tenants: Awaited<ReturnType<typeof listTenants>> | null = null;
  try {
    tenants = await listTenants(viewer, query);
  } catch (thrown) {
    // A non-staff caller who typed the URL gets the refusal rendered, not a stack trace.
    if (!(thrown instanceof AuthorizationDeniedError)) throw thrown;
  }

  if (!tenants) {
    return (
      <section className="space-y-6">
        <PageHeader title="Tenants" />
        <EmptyState
          icon={ShieldOff}
          title="Your role does not include the tenant directory"
          description="Personal contact details are restricted to organization administrators and property managers. The refusal happens in the service and again in Postgres — this page is only reporting it."
          action={
            <Button asChild variant="outline">
              <Link href="/dashboard">Back to the dashboard</Link>
            </Button>
          }
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <PageHeader
        eyebrow={viewer.membership.organization.name}
        title="Tenants"
        description="Personal contact details, restricted to organization administrators and property managers. A service provider reaching the same records sees names only."
      />

      {/* A plain GET form, so a search is a URL you can share, bookmark and go back to.
          The primitives are the shared ones rather than hand-rolled elements — they were
          hand-rolled here and carried their own border and height values. */}
      <form method="get" className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="tenant-search">
          Search by name
        </label>
        <Input
          id="tenant-search"
          name="q"
          defaultValue={query.q ?? ''}
          placeholder="Search by name"
          className="w-full max-w-xs"
        />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      <TenantTable tenants={tenants.items} filtered={Boolean(query.q)} />

      {tenants.hasMore && tenants.nextCursor ? (
        <div className="flex justify-end">
          <Button asChild variant="secondary">
            <Link href={`/tenants?cursor=${encodeURIComponent(tenants.nextCursor)}`}>
              Next page
            </Link>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
