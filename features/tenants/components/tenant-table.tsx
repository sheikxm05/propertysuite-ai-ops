/**
 * The tenant directory, as a table. Staff surface only.
 *
 * It takes `Tenant[]` — the full record — because the only callers that can obtain one
 * are the two staff roles and the tenant themselves. A service provider's name-only view
 * is a different shape (`TenantName`) and therefore cannot be passed to this component
 * by accident: the type system refuses it rather than the component having to remember
 * to omit two columns.
 */

import Link from 'next/link';
import { SearchX, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Tenant } from '@shared/index';

export function TenantTable({
  tenants,
  filtered = false,
}: {
  tenants: readonly Tenant[];
  /** Whether a search term is applied, which changes what "empty" means and what to offer. */
  filtered?: boolean;
}) {
  if (tenants.length === 0) {
    return filtered ? (
      <EmptyState
        icon={SearchX}
        title="No tenant records match"
        description="Search matches the recorded full name. Clear the box to see the whole directory."
        action={
          <Button asChild variant="outline">
            <Link href="/tenants">Clear the search</Link>
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={Users}
        title="No tenant records yet"
        description="A tenant record is created alongside the tenancy that names it, so start from the lease."
        action={
          <Button asChild variant="outline">
            <Link href="/tenancies">Open the tenancy register</Link>
          </Button>
        }
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead className="hidden sm:table-cell">Email</TableHead>
          <TableHead numeric className="hidden md:table-cell">
            Phone
          </TableHead>
          <TableHead>Account</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tenants.map((tenant) => (
          <TableRow key={tenant.id}>
            <TableCell className="font-medium">
              <Link href={`/tenants/${tenant.id}`} className="underline-offset-4 hover:underline">
                {tenant.full_name}
              </Link>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {tenant.email ?? '—'}
            </TableCell>
            <TableCell numeric className="hidden text-muted-foreground md:table-cell">
              {tenant.phone ?? '—'}
            </TableCell>
            <TableCell>
              {/*
                `success` for a linked account and `secondary` for one that does not exist
                yet, which is the same rule `components/ui/status.ts` applies to every
                other status in the product: green is a settled good state, grey is
                "not started". There is no shared table for this one because it is not a
                column — it is whether `tenants.profile_id` is populated.
              */}
              {tenant.profile_id ? (
                <Badge variant="success" className="whitespace-nowrap">
                  Linked
                </Badge>
              ) : (
                <Badge variant="secondary" className="whitespace-nowrap">
                  No account
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
