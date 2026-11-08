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

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { Tenant } from '@shared/index';

export function TenantTable({ tenants }: { tenants: readonly Tenant[] }) {
  if (tenants.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        No tenant records match.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Phone</TableHead>
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
            <TableCell className="text-muted-foreground">{tenant.email ?? '—'}</TableCell>
            <TableCell className="text-muted-foreground">{tenant.phone ?? '—'}</TableCell>
            <TableCell>
              {tenant.profile_id ? (
                <Badge variant="success">Linked</Badge>
              ) : (
                <Badge variant="secondary">No account</Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
