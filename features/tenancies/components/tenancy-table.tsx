/**
 * The tenancy register, as a table. Presentation only — it renders what it is given.
 *
 * It takes `Tenancy[]`, never a query. The decision about *which* leases a caller may
 * see belongs to `tenancyReadScope()` and to Row Level Security; a component that fetched
 * its own rows would be a third place that decision could be made differently.
 */

import Link from 'next/link';
import { FileSignature } from 'lucide-react';

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
import type { Tenancy } from '@shared/index';

import {
  formatDate,
  formatMoney,
  tenancyStatusLabel,
  tenancyStatusTone,
} from '@/features/tenancies/format';
import { asTenancyStatus } from '@/features/tenancies/lifecycle';

export function TenancyTable({ tenancies }: { tenancies: readonly Tenancy[] }) {
  if (tenancies.length === 0) {
    return (
      <EmptyState
        icon={FileSignature}
        title="No tenancies to show"
        description="A lease is created against a unit, so the portfolio comes first. Once a unit exists you can record the tenant on it."
        action={
          <Button asChild variant="outline">
            <Link href="/properties">Open the portfolio</Link>
          </Button>
        }
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Contract</TableHead>
          {/* The term folds away below `sm`; the contract number and the rent are what
              identify a lease at a glance. */}
          <TableHead numeric className="hidden sm:table-cell">
            Term
          </TableHead>
          <TableHead numeric>Rent</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tenancies.map((tenancy) => {
          const status = asTenancyStatus(tenancy.status);
          return (
            <TableRow key={tenancy.id}>
              <TableCell className="font-medium">
                <Link
                  href={`/tenancies/${tenancy.id}`}
                  className="underline-offset-4 hover:underline"
                >
                  {tenancy.contract_number ?? 'Untitled tenancy'}
                </Link>
              </TableCell>
              <TableCell
                numeric
                className="hidden whitespace-nowrap text-muted-foreground sm:table-cell"
              >
                {formatDate(tenancy.start_date)} – {formatDate(tenancy.end_date)}
              </TableCell>
              <TableCell numeric className="whitespace-nowrap">
                {formatMoney(tenancy.rent_amount, tenancy.currency)}
              </TableCell>
              <TableCell>
                <Badge variant={tenancyStatusTone(status)} className="whitespace-nowrap">
                  {tenancyStatusLabel(status)}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
