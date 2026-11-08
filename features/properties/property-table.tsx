/**
 * The property list table.
 *
 * A plain server component: it receives rows and renders them, with no state, no effects
 * and no data access of its own. That keeps the page's data path in one place — the
 * server component that resolved the membership and called the service — rather than
 * spread across a client component that fetches for itself.
 *
 * Every row shown here has already been through `authorize()` in
 * `features/properties/service.ts`, so this component never decides what to display on
 * the basis of a role. It is told.
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
import type { PropertyRow } from '@shared/index';

import {
  formatDate,
  propertyStatusLabel,
  propertyStatusVariant,
  propertyTypeLabel,
} from './labels';

export interface PropertyTableProps {
  properties: readonly PropertyRow[];
  /** Shown when the caller's visible set is empty. Differs by role, so the page supplies it. */
  emptyMessage: string;
}

export function PropertyTable({ properties, emptyMessage }: PropertyTableProps) {
  if (properties.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Property</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Location</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Added</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {properties.map((property) => (
          <TableRow key={property.id}>
            <TableCell className="font-medium">
              <Link
                href={`/properties/${property.id}`}
                className="underline-offset-4 hover:underline"
              >
                {property.name}
              </Link>
              <span className="block text-xs text-muted-foreground">{property.address_line}</span>
            </TableCell>
            <TableCell>{propertyTypeLabel(property.property_type)}</TableCell>
            <TableCell>
              {property.city}
              <span className="block text-xs text-muted-foreground">{property.emirate}</span>
            </TableCell>
            <TableCell>
              <Badge variant={propertyStatusVariant(property.status)}>
                {propertyStatusLabel(property.status)}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatDate(property.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
