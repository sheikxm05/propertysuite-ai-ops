/**
 * The tenancy register, as a table. Presentation only — it renders what it is given.
 *
 * It takes `Tenancy[]`, never a query. The decision about *which* leases a caller may
 * see belongs to `tenancyReadScope()` and to Row Level Security; a component that fetched
 * its own rows would be a third place that decision could be made differently.
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
      <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        No tenancies to show.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Contract</TableHead>
          <TableHead>Term</TableHead>
          <TableHead className="text-right">Rent</TableHead>
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
              <TableCell className="text-muted-foreground">
                {formatDate(tenancy.start_date)} – {formatDate(tenancy.end_date)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatMoney(tenancy.rent_amount, tenancy.currency)}
              </TableCell>
              <TableCell>
                <Badge variant={tenancyStatusTone(status)}>{tenancyStatusLabel(status)}</Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
