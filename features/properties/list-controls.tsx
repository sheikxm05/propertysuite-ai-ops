'use client';

/**
 * The search and status filter above the property list.
 *
 * Both controls write to the query string and let the server component re-read the list.
 * Nothing is filtered in the browser: a filter applied after the response has already
 * shipped the rows it was meant to exclude, and on an RLS-scoped list that is the
 * difference between "not shown" and "not sent".
 *
 * `q` is reduced to a conservative character allowlist **on the server**
 * (`features/properties/filters.ts`) before it reaches a PostgREST filter expression. This
 * component does not pre-sanitise it, on purpose: a client-side cleaner would hide from
 * the test suite whether the server-side one works.
 *
 * Changing either control clears `cursor`. A cursor is a position in a *particular*
 * ordering of a *particular* filtered set; carrying it across a filter change would page
 * from a position that no longer exists.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PROPERTY_STATUSES } from '@shared/index';

import { PROPERTY_STATUS_LABELS } from './labels';

/** Radix Select cannot hold an empty-string value, so "any status" needs a sentinel. */
const ANY_STATUS = '__any__';

export interface ListControlsProps {
  /** Query parameters to reset when a filter changes. The cursor, always. */
  resetParams?: readonly string[];
}

export function ListControls({ resetParams = ['cursor', 'unitCursor'] }: ListControlsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [term, setTerm] = React.useState(searchParams.get('q') ?? '');
  const status = searchParams.get('status') ?? ANY_STATUS;

  function apply(changes: Record<string, string | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const param of resetParams) next.delete(param);

    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }

    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        apply({ q: term.trim() || null });
      }}
    >
      <div className="min-w-56 flex-1 space-y-2">
        <Label htmlFor="property-search">Search</Label>
        <Input
          id="property-search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Name or address"
          autoComplete="off"
        />
      </div>

      <div className="w-48 space-y-2">
        <Label htmlFor="property-status">Status</Label>
        <Select
          value={status}
          onValueChange={(value) => apply({ status: value === ANY_STATUS ? null : value })}
        >
          <SelectTrigger id="property-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_STATUS}>Any status</SelectItem>
            {PROPERTY_STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {PROPERTY_STATUS_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" variant="outline">
        Apply
      </Button>

      {searchParams.get('q') || searchParams.get('status') ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setTerm('');
            apply({ q: null, status: null });
          }}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
}
