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

import * as React from 'react';
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
  /**
   * Shown when the caller's visible set is empty. The *reason* it is empty differs by
   * role and by whether a filter is applied, and so does the action that resolves it, so
   * the page composes the whole state rather than handing down a sentence.
   */
  empty: React.ReactNode;
}

export function PropertyTable({ properties, empty }: PropertyTableProps) {
  if (properties.length === 0) return <>{empty}</>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Property</TableHead>
          {/* Type and location fold away below `md`: the property cell already carries
              the address, so the row still reads on a phone without scrolling. */}
          <TableHead className="hidden md:table-cell">Type</TableHead>
          <TableHead className="hidden lg:table-cell">Location</TableHead>
          <TableHead>Status</TableHead>
          <TableHead numeric className="hidden sm:table-cell">
            Added
          </TableHead>
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
            <TableCell className="hidden md:table-cell">
              {propertyTypeLabel(property.property_type)}
            </TableCell>
            <TableCell className="hidden lg:table-cell">
              {property.city}
              <span className="block text-xs text-muted-foreground">{property.emirate}</span>
            </TableCell>
            <TableCell>
              <Badge variant={propertyStatusVariant(property.status)} className="whitespace-nowrap">
                {propertyStatusLabel(property.status)}
              </Badge>
            </TableCell>
            <TableCell numeric className="hidden text-muted-foreground sm:table-cell">
              {formatDate(property.created_at)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
