'use client';

/**
 * The create and edit form for a property.
 *
 * ONE schema, both sides. `CreatePropertySchema` and `UpdatePropertySchema` come from
 * `@shared/index` and are the *same objects* the route handlers hand to `withApiHandler`
 * as `bodySchema`. There is no second definition and no client-only mirror of one
 * (CLAUDE.md rule 4): if the server tightens `name` to 3 characters, this form tightens
 * with it in the same commit, because there is only one place it is written.
 *
 * Client-side validation here is a courtesy to the person typing — it avoids a round trip
 * for an obvious mistake. The server validates the identical schema again and is the only
 * authority, exactly as `components/ui/form.tsx` documents. Deleting this component would
 * not make a single invalid write possible.
 *
 * `organization_id` appears nowhere in this file. It is not a form field, not a hidden
 * input and not a query parameter: the server derives it from the resolved membership
 * (CLAUDE.md rule 5). The schemas are `.strict()`, so a client that tried to post one
 * would get a 400 rather than having it quietly ignored.
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
import {
  CreatePropertySchema,
  DEFAULT_CITY,
  DEFAULT_EMIRATE,
  EMIRATES,
  MEMBER_ROLE_LABELS,
  PROPERTY_TYPES,
  UpdatePropertySchema,
  isMemberRole,
  type PropertyRow,
} from '@shared/index';

import * as api from './api-client';
import { PROPERTY_TYPE_LABELS } from './labels';

/**
 * One membership that may be recorded as `properties.owner_member_id`.
 *
 * `label` is built by the server page from the member's **role and membership id**, not
 * from their name. `profiles` is reachable only through `lib/auth/roles.ts`
 * (`resolveMembership`) — `eslint.config.mjs` restricts it by name, and the owner picker
 * has no lane-legal source of display names. Reported as a planning defect with this lane.
 */
export interface OwnerOption {
  memberId: string;
  role: string;
}

export interface PropertyFormProps {
  /** `create` posts to `/api/v1/properties`; `edit` patches the existing row. */
  mode: 'create' | 'edit';
  property?: PropertyRow;
  owners: readonly OwnerOption[];
}

/** Sentinel for "no owner". Radix Select cannot hold an empty-string value. */
const NO_OWNER = '__none__';

export function PropertyForm({ mode, property, owners }: PropertyFormProps) {
  const router = useRouter();

  const [name, setName] = React.useState(property?.name ?? '');
  const [propertyType, setPropertyType] = React.useState(property?.property_type ?? 'apartment');
  const [addressLine, setAddressLine] = React.useState(property?.address_line ?? '');
  const [city, setCity] = React.useState(property?.city ?? DEFAULT_CITY);
  const [emirate, setEmirate] = React.useState(property?.emirate ?? DEFAULT_EMIRATE);
  const [ownerMemberId, setOwnerMemberId] = React.useState(property?.owner_member_id ?? NO_OWNER);

  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formErrors, setFormErrors] = React.useState<string[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFieldErrors({});
    setFormErrors([]);

    // Assembled key by key. `owner_member_id` is omitted rather than sent as `''` on a
    // create, because `UuidSchema.optional()` rejects an empty string — and on an edit it
    // is sent as `null`, which is how `UpdatePropertySchema` documents clearing it.
    const candidate: Record<string, unknown> = {
      name,
      property_type: propertyType,
      address_line: addressLine,
      city,
      emirate,
    };
    if (ownerMemberId !== NO_OWNER) candidate.owner_member_id = ownerMemberId;
    else if (mode === 'edit') candidate.owner_member_id = null;

    const schema = mode === 'create' ? CreatePropertySchema : UpdatePropertySchema;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      setFieldErrors(flat.fieldErrors);
      setFormErrors(flat.formErrors);
      return;
    }

    setSubmitting(true);
    try {
      const saved =
        mode === 'create'
          ? await api.createProperty(parsed.data)
          : await api.updateProperty(property?.id ?? '', parsed.data);

      toast({
        title: mode === 'create' ? 'Property created' : 'Property updated',
        variant: 'success',
      });
      router.push(`/properties/${saved.id}`);
      router.refresh();
    } catch (error) {
      // The server's message comes from the frozen envelope and is already client-safe;
      // `api-client.ts` refuses to read a message out of a body that is not that shape.
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

      <FormField name="name">
        <FormLabel>Property name</FormLabel>
        <FormControl>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </FormControl>
        <FormMessage />
      </FormField>

      <FormField name="property_type">
        <FormLabel>Property type</FormLabel>
        <Select value={propertyType} onValueChange={setPropertyType}>
          <SelectTrigger aria-label="Property type">
            <SelectValue placeholder="Select a type" />
          </SelectTrigger>
          <SelectContent>
            {PROPERTY_TYPES.map((value) => (
              <SelectItem key={value} value={value}>
                {PROPERTY_TYPE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FormMessage />
      </FormField>

      <FormField name="address_line">
        <FormLabel>Address</FormLabel>
        <FormControl>
          <Input
            value={addressLine}
            onChange={(e) => setAddressLine(e.target.value)}
            autoComplete="off"
          />
        </FormControl>
        <FormMessage />
      </FormField>

      <div className="grid gap-6 sm:grid-cols-2">
        <FormField name="city">
          <FormLabel>City</FormLabel>
          <FormControl>
            <Input value={city} onChange={(e) => setCity(e.target.value)} autoComplete="off" />
          </FormControl>
          <FormMessage />
        </FormField>

        <FormField name="emirate">
          <FormLabel>Emirate</FormLabel>
          <Select value={emirate} onValueChange={setEmirate}>
            <SelectTrigger aria-label="Emirate">
              <SelectValue placeholder="Select an emirate" />
            </SelectTrigger>
            <SelectContent>
              {EMIRATES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormField>
      </div>

      <FormField name="owner_member_id">
        <FormLabel>Owner</FormLabel>
        <Select value={ownerMemberId} onValueChange={setOwnerMemberId}>
          <SelectTrigger aria-label="Owner">
            <SelectValue placeholder="No owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_OWNER}>No owner</SelectItem>
            {owners.map((owner) => (
              <SelectItem key={owner.memberId} value={owner.memberId}>
                {ownerLabel(owner)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FormDescription>
          Only administrators, managers and owners can be associated. A tenant or a service provider
          named here would inherit owner-scoped visibility of the whole property.
        </FormDescription>
        <FormMessage />
      </FormField>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : mode === 'create' ? 'Create property' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </Form>
  );
}

/** Role plus a short membership id. See `OwnerOption` for why there is no name here. */
function ownerLabel(owner: OwnerOption): string {
  const role = isMemberRole(owner.role) ? MEMBER_ROLE_LABELS[owner.role] : owner.role;
  return `${role} · ${owner.memberId.slice(0, 8)}`;
}
