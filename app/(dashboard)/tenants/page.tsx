/**
 * `/tenants` — the tenant directory. Staff only.
 *
 * There is no sidebar entry for this page, and that is not an omission: `FEATURE_KEYS`
 * in `config/types.ts` has six keys and `tenants` is not one of them, so a seventh nav
 * entry would mean editing `config/**`, which this lane does not own (§0 mechanism 3).
 * The directory is reached from a tenancy or by URL, and `listTenants` refuses every
 * non-staff caller before a query exists — a hidden link was never the control.
 */

import { redirect } from 'next/navigation';

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
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
        <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          Your role does not include the tenant directory.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Tenants</h1>
        <p className="text-sm text-muted-foreground">
          Tenant records for {viewer.membership.organization.name}. This page shows personal contact
          details and is restricted to organization administrators and property managers.
        </p>
      </header>

      <form method="get" className="flex gap-2">
        <label className="sr-only" htmlFor="tenant-search">
          Search by name
        </label>
        <input
          id="tenant-search"
          name="q"
          defaultValue={query.q ?? ''}
          placeholder="Search by name"
          className="h-9 w-full max-w-xs rounded-md border border-input bg-background px-3 text-sm"
        />
        <button
          type="submit"
          className="h-9 rounded-md border border-input px-3 text-sm font-medium"
        >
          Search
        </button>
      </form>

      <TenantTable tenants={tenants.items} />

      {tenants.hasMore && tenants.nextCursor ? (
        <a
          className="inline-flex text-sm underline underline-offset-4"
          href={`/tenants?cursor=${encodeURIComponent(tenants.nextCursor)}`}
        >
          Next page
        </a>
      ) : null}
    </section>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
