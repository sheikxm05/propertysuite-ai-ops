/**
 * `/tenants/{tenantId}` — one tenant record, in whichever shape the caller's role allows.
 *
 * THE PAGE THAT DEMONSTRATES COLUMN PROJECTION.
 * `getTenantById` returns a tagged `TenantView`, so this page renders either the full
 * record or the name alone, and the branch is on the tag rather than on a role string.
 * A service provider holding an assigned ticket legitimately reaches this page — RLS
 * grants them the row — and sees a name and nothing else, because the email and phone
 * columns were never selected. Row Level Security cannot express that; `projectionFor()`
 * can, and this is where the result is rendered.
 */

import { notFound, redirect } from 'next/navigation';

import { TenantPathParamsSchema } from '@shared/index';

import { isApiRouteError } from '@/lib/api/errors';
import { AuthorizationDeniedError } from '@/lib/auth/authorize';

import { getTenantById } from '@/features/tenants/server/tenant-service';
import { resolveViewer } from '@/features/tenants/server/viewer';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: 'Tenant' };

const SIGN_IN = '/sign-in';

export default async function TenantDetailPage({
  params,
}: {
  params: Promise<Record<string, string>>;
}) {
  const viewer = await resolveViewer('page:tenants/[tenantId]');
  if (!viewer) redirect(SIGN_IN);

  const parsed = TenantPathParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  let view: Awaited<ReturnType<typeof getTenantById>>;
  try {
    view = await getTenantById(viewer, parsed.data.tenantId);
  } catch (thrown) {
    if (thrown instanceof AuthorizationDeniedError) notFound();
    if (isApiRouteError(thrown) && (thrown.status === 404 || thrown.status === 403)) notFound();
    throw thrown;
  }

  if (view.kind === 'name_only') {
    return (
      <section className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{view.tenant.full_name}</h1>
          <p className="text-sm text-muted-foreground">
            You are seeing this tenant because a job is assigned to you.
          </p>
        </header>
        <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          Contact details are not shared with service providers. Coordinate access through the
          property manager who assigned the job.
        </p>
      </section>
    );
  }

  const tenant = view.tenant;

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{tenant.full_name}</h1>
        {tenant.profile_id ? (
          <Badge variant="success">Account linked</Badge>
        ) : (
          <Badge variant="secondary">No account yet</Badge>
        )}
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Contact</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Field label="Email" value={tenant.email ?? '—'} />
            <Field label="Phone" value={tenant.phone ?? '—'} />
          </dl>
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Linking an account is what gives this person their self-service view: the tenancy read
        resolves through <code>tenants.profile_id</code>, so until a profile is linked they can sign
        in and see nothing.
      </p>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
