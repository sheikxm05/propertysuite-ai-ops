'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Form, FormControl, FormDescription, FormField, FormLabel } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  type MaintenanceCategory,
} from '@shared/index';
import type { UnitOption } from '@/features/maintenance/domain';

import { MaintenanceApiError, createTicketRequest } from './api-client';

/**
 * Report a maintenance issue.
 *
 * The honest label on the priority control matters. `priority` is a REQUEST, not a
 * decision: `resolvePriority()` on the server takes it as one bounded input and can cap
 * it, so a tenant marking everything urgent does not make anything urgent. The help text
 * says so, because a control that silently ignores its input is worse than no control.
 *
 * Validation is the server's. `CreateTicketSchema` is the only validator, and the only
 * client-side constraint is `required` on the three fields that have no sensible default
 * — enough to avoid a pointless round trip, not enough to be mistaken for the rule.
 *
 * `source` is fixed to `web`. The other sources (`whatsapp`, `email`, `admin`) describe
 * how a ticket actually arrived, and letting a browser form claim one would make the
 * column useless for provenance.
 */
export function CreateTicketForm({ units }: { units: readonly UnitOption[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);

  if (units.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        There are no units you can report maintenance for. A tenancy must be active on a unit before
        a ticket can be raised against it.
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);

    try {
      const priority = String(data.get('priority') ?? '');
      const created = await createTicketRequest({
        property_unit_id: String(data.get('property_unit_id') ?? ''),
        title: String(data.get('title') ?? ''),
        description: String(data.get('description') ?? ''),
        category: String(data.get('category') ?? 'unknown'),
        ...(priority === '' ? {} : { priority }),
        source: 'web',
      });

      toast({
        title: 'Ticket created',
        description: `Priority was set to ${created.data.priority} by the maintenance priority policy.`,
        variant: 'success',
      });
      router.push(`/maintenance/${created.data.id}`);
    } catch (error) {
      toast({
        title: 'Could not create the ticket',
        description: describe(error),
        variant: 'destructive',
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <Form onSubmit={onSubmit}>
      <FormField name="property_unit_id">
        <FormLabel required>Unit</FormLabel>
        <FormControl>
          <select
            name="property_unit_id"
            required
            defaultValue=""
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="" disabled>
              Select a unit
            </option>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.label}
              </option>
            ))}
          </select>
        </FormControl>
        <FormDescription>
          Only units you are authorized for are listed, and the server checks again.
        </FormDescription>
      </FormField>

      <FormField name="title">
        <FormLabel required>Summary</FormLabel>
        <FormControl>
          <Input name="title" required minLength={3} maxLength={200} />
        </FormControl>
      </FormField>

      <FormField name="description">
        <FormLabel required>What is happening?</FormLabel>
        <FormControl>
          <Textarea name="description" required minLength={10} maxLength={4000} rows={5} />
        </FormControl>
      </FormField>

      <FormField name="category">
        <FormLabel>Category</FormLabel>
        <FormControl>
          <select
            name="category"
            defaultValue="unknown"
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            {MAINTENANCE_CATEGORIES.map((category: MaintenanceCategory) => (
              <option key={category} value={category}>
                {MAINTENANCE_CATEGORY_LABELS[category]}
              </option>
            ))}
          </select>
        </FormControl>
        <FormDescription>Leave it unclassified if you are not sure.</FormDescription>
      </FormField>

      <FormField name="priority">
        <FormLabel>How urgent does this feel?</FormLabel>
        <FormControl>
          <select
            name="priority"
            defaultValue=""
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="">No preference</option>
            {TICKET_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </FormControl>
        <FormDescription>
          A suggestion, not a setting. The final priority is decided by policy from the category,
          whether the unit is occupied, repeat failures and the time of day.
        </FormDescription>
      </FormField>

      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create ticket'}
      </Button>
    </Form>
  );
}

/** Shows the server's own message plus the correlation id, never an invented one. */
export function describe(error: unknown): string {
  if (error instanceof MaintenanceApiError) {
    return error.requestId ? `${error.message} (reference ${error.requestId})` : error.message;
  }
  return 'The request could not be completed.';
}
