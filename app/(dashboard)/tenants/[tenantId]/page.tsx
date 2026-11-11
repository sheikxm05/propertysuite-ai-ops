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

import Link from 'next/link';
import { ShieldOff } from 'lucide-react';

import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
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
        <PageHeader
          eyebrow="Tenant"
          title={view.tenant.full_name}
          description="You are seeing this tenant because a job is assigned to you."
        />
        <EmptyState
          icon={ShieldOff}
          title="Contact details are not shared with service providers"
          description="The name is all this projection returns — the columns are not withheld by this page, they are never selected. Coordinate access through the property manager who assigned the job."
          action={
            <Button asChild variant="outline">
              <Link href="/maintenance">Back to my jobs</Link>
            </Button>
          }
        />
      </section>
    );
  }

  const tenant = view.tenant;

  return (
    <section className="space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/tenants" className="underline-offset-4 hover:underline">
            Tenants
          </Link>
        }
        title={tenant.full_name}
        description="Personal contact details. Visible to organization administrators and property managers, and to this tenant themselves."
        actions={
          tenant.profile_id ? (
            <Badge variant="success" className="whitespace-nowrap">
              Account linked
            </Badge>
          ) : (
            <Badge variant="secondary" className="whitespace-nowrap">
              No account yet
            </Badge>
          )
        }
      />

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
