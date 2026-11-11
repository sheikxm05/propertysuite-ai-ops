'use client';

/**
 * Unit management for one property: the list, the status machine, and the add-unit dialog.
 *
 * The status control only ever offers edges `nextUnitStatuses` allows, so the UI cannot
 * invite a transition the server will refuse. That is a usability measure and nothing
 * more — `assertUnitTransition` runs again in the service on every `PATCH`, which is why
 * `occupied → inactive` is impossible whether the request came from this component, from
 * `curl`, or from anything else. A control that is the only thing preventing an illegal
 * state change is not a control.
 *
 * `canWrite` likewise hides, it does not protect. It is `membership.role` being staff, as
 * resolved on the server; a property owner reading their own property sees the table and
 * no controls, and would get a 403 from `authorize()` and a `42501` from
 * `property_units_update_staff` if they sent the request anyway.
 */

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { DoorOpen } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import type { PropertyUnitRow, UnitStatus } from '@shared/index';

import * as api from './api-client';
import { CursorNav } from './cursor-nav';
import {
  formatArea,
  formatBathrooms,
  formatBedrooms,
  unitStatusLabel,
  unitStatusVariant,
} from './labels';
import { UnitForm } from './unit-form';
import { nextUnitStatuses } from './unit-status';

export interface UnitsPanelProps {
  propertyId: string;
  units: readonly PropertyUnitRow[];
  nextCursor: string | null;
  /** The query parameter the unit list paginates on, kept distinct from the page's own. */
  cursorParam: string;
  /** Staff. Presentation only — see the file header. */
  canWrite: boolean;
  /** An archived property accepts no new units; the server answers 409. */
  propertyArchived: boolean;
}

export function UnitsPanel({
  propertyId,
  units,
  nextCursor,
  cursorParam,
  canWrite,
  propertyArchived,
}: UnitsPanelProps) {
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [pendingUnitId, setPendingUnitId] = React.useState<string | null>(null);

  async function changeStatus(unit: PropertyUnitRow, status: UnitStatus) {
    if (status === unit.status) return;
    setPendingUnitId(unit.id);
    try {
      await api.updateUnit(propertyId, unit.id, { status });
      toast({
        title: `Unit ${unit.unit_number} is now ${unitStatusLabel(status)}`,
        variant: 'success',
      });
      router.refresh();
    } catch (error) {
      toast({
        title: 'Status not changed',
        description:
          error instanceof api.ApiClientError
            ? error.message
            : 'The request could not be completed.',
        variant: 'destructive',
      });
    } finally {
      setPendingUnitId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Units</CardTitle>
          <CardDescription>
            Occupancy and configuration for every unit in this property.
          </CardDescription>
        </div>

        {canWrite && !propertyArchived ? (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm">Add unit</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add a unit</DialogTitle>
                <DialogDescription>
                  The unit number must be unique within this property.
                </DialogDescription>
              </DialogHeader>
              <UnitForm propertyId={propertyId} onCreated={() => setDialogOpen(false)} />
            </DialogContent>
          </Dialog>
        ) : null}
      </CardHeader>

      <CardContent>
        {propertyArchived ? (
          <Alert className="mb-4">
            <AlertDescription>
              This property is archived. Reactivate it before adding or changing units.
            </AlertDescription>
          </Alert>
        ) : null}

        {units.length === 0 ? (
          <EmptyState
            icon={DoorOpen}
            title="No units are visible to you"
            description={
              canWrite
                ? 'Add the first unit and tenancies, tickets and documents can all be recorded against it.'
                : 'Your role sees only the units it is connected to — the one you lease, or the one behind a job assigned to you.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Unit</TableHead>
                {/* Bedrooms, bathrooms and area are numeric columns, so they are right
                    aligned and tabular; the two narrowest fold away on a phone. */}
                <TableHead numeric className="hidden sm:table-cell">
                  Bedrooms
                </TableHead>
                <TableHead numeric className="hidden sm:table-cell">
                  Bathrooms
                </TableHead>
                <TableHead numeric className="hidden md:table-cell">
                  Area
                </TableHead>
                <TableHead>Status</TableHead>
                {canWrite ? <TableHead className="w-48">Change status</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {units.map((unit) => {
                const options = nextUnitStatuses(unit.status);
                return (
                  <TableRow key={unit.id}>
                    <TableCell className="font-medium">{unit.unit_number}</TableCell>
                    <TableCell numeric className="hidden sm:table-cell">
                      {formatBedrooms(unit.bedrooms)}
                    </TableCell>
                    <TableCell numeric className="hidden sm:table-cell">
                      {formatBathrooms(unit.bathrooms)}
                    </TableCell>
                    <TableCell numeric className="hidden whitespace-nowrap md:table-cell">
                      {formatArea(unit.area_sqft)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={unitStatusVariant(unit.status)} className="whitespace-nowrap">
                        {unitStatusLabel(unit.status)}
                      </Badge>
                    </TableCell>
                    {canWrite ? (
                      <TableCell>
                        {options.length === 0 ? (
                          <span className="text-sm text-muted-foreground">No transition</span>
                        ) : (
                          <Select
                            value={unit.status}
                            disabled={pendingUnitId === unit.id || propertyArchived}
                            onValueChange={(value) => void changeStatus(unit, value as UnitStatus)}
                          >
                            <SelectTrigger aria-label={`Status of unit ${unit.unit_number}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {/* The current status, so the control shows where it is… */}
                              <SelectItem value={unit.status}>
                                {unitStatusLabel(unit.status)}
                              </SelectItem>
                              {/* …and only the edges the state machine permits. */}
                              {options.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {unitStatusLabel(option)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        <CursorNav param={cursorParam} nextCursor={nextCursor} count={units.length} />
      </CardContent>
    </Card>
  );
}
