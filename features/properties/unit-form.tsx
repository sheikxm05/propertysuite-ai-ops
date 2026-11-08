'use client';

/**
 * The create form for a unit inside a property.
 *
 * `CreateUnitSchema` from `@shared/index` — the same object the route hands to
 * `withApiHandler`. One schema, both sides (CLAUDE.md rule 4).
 *
 * `property_id` is deliberately not a field. The unit's property comes from the URL the
 * form posts to, which is why `CreateUnitSchema` does not contain it: there is no body
 * that can disagree with the path, so there is exactly one thing for the server to
 * authorize. Likewise `organization_id`, which the server derives from the membership.
 *
 * The three measurements are optional and are **omitted** rather than sent as `null` on a
 * create: `BedroomsSchema` and friends are `.optional()` on `CreateUnitSchema` and
 * `.nullable().optional()` only on `UpdateUnitSchema`, where `null` is the documented way
 * to clear a value.
 */

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
  FormRootError,
  type FieldErrors,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/use-toast';
import { CreateUnitSchema, UNIT_STATUSES } from '@shared/index';

import * as api from './api-client';
import { UNIT_STATUS_LABELS } from './labels';
import { DEFAULT_UNIT_STATUS } from './unit-status';

export interface UnitFormProps {
  propertyId: string;
  /** Called after a successful create, so the panel can close its dialog. */
  onCreated?: () => void;
}

export function UnitForm({ propertyId, onCreated }: UnitFormProps) {
  const router = useRouter();

  const [unitNumber, setUnitNumber] = React.useState('');
  const [bedrooms, setBedrooms] = React.useState('');
  const [bathrooms, setBathrooms] = React.useState('');
  const [areaSqft, setAreaSqft] = React.useState('');
  const [status, setStatus] = React.useState<string>(DEFAULT_UNIT_STATUS);

  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formErrors, setFormErrors] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    setFormErrors([]);

    const candidate: Record<string, unknown> = { unit_number: unitNumber, status };
    // `numberOrUndefined` returns the raw string when it is not a number, so a typo lands
    // on the schema as a type error on that field rather than being silently dropped.
    if (bedrooms.trim() !== '') candidate.bedrooms = numberOrRaw(bedrooms);
    if (bathrooms.trim() !== '') candidate.bathrooms = numberOrRaw(bathrooms);
    if (areaSqft.trim() !== '') candidate.area_sqft = numberOrRaw(areaSqft);

    const parsed = CreateUnitSchema.safeParse(candidate);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      setFieldErrors(flat.fieldErrors);
      setFormErrors(flat.formErrors);
      return;
    }

    setSubmitting(true);
    try {
      await api.createUnit(propertyId, parsed.data);
      toast({ title: 'Unit created', variant: 'success' });
      setUnitNumber('');
      setBedrooms('');
      setBathrooms('');
      setAreaSqft('');
      onCreated?.();
      router.refresh();
    } catch (error) {
      // A duplicate unit number inside this property is `CONFLICT` 409, from
      // `unique (property_id, unit_number)` in `0001` via the wrapper's `23505` mapping.
      setFormErrors([
        error instanceof api.ApiClientError ? error.message : 'The request could not be completed.',
      ]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form onSubmit={onSubmit} errors={fieldErrors} aria-busy={submitting}>
      <FormRootError errors={formErrors} />

      <FormField name="unit_number">
        <FormLabel>Unit number</FormLabel>
        <FormControl>
          <Input
            value={unitNumber}
            onChange={(e) => setUnitNumber(e.target.value)}
            autoComplete="off"
          />
        </FormControl>
        <FormDescription>Must be unique within this property.</FormDescription>
        <FormMessage />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField name="bedrooms">
          <FormLabel>Bedrooms</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={0}
              step={1}
              value={bedrooms}
              onChange={(e) => setBedrooms(e.target.value)}
            />
          </FormControl>
          <FormDescription>0 for a studio.</FormDescription>
          <FormMessage />
        </FormField>

        <FormField name="bathrooms">
          <FormLabel>Bathrooms</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={0}
              step={0.5}
              value={bathrooms}
              onChange={(e) => setBathrooms(e.target.value)}
            />
          </FormControl>
          <FormMessage />
        </FormField>

        <FormField name="area_sqft">
          <FormLabel>Area (sqft)</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={0}
              step={0.01}
              value={areaSqft}
              onChange={(e) => setAreaSqft(e.target.value)}
            />
          </FormControl>
          <FormMessage />
        </FormField>
      </div>

      <FormField name="status">
        <FormLabel>Status</FormLabel>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Unit status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNIT_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {UNIT_STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FormMessage />
      </FormField>

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add unit'}
      </Button>
    </Form>
  );
}

/**
 * Parses a numeric input, returning the original string when it is not a finite number.
 *
 * Returning the string on purpose: Zod then reports "expected number, received string" on
 * that field, which the form shows next to the input. Coercing silently to `undefined`
 * would drop the value the user typed with no explanation.
 */
function numberOrRaw(raw: string): number | string {
  const value = Number(raw);
  return Number.isFinite(value) ? value : raw;
}
