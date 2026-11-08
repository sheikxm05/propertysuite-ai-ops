'use client';

/**
 * Archive and reactivate a property.
 *
 * This is the application's *only* removal gesture for a property, and it is not a
 * deletion. CLAUDE.md rule 6 forbids a DELETE path on a tenant-scoped table, and the
 * database agrees below the policy layer: `0002` revokes the DELETE privilege from
 * `authenticated` on `properties`, so even a hand-written `DELETE` would come back as
 * `42501` rather than removing a row. The button therefore says "Archive", the route it
 * calls is `POST /{propertyId}/archive`, and the row keeps existing with
 * `status = 'archived'`.
 *
 * The confirmation dialog is UX, not a security control; the server authorizes the action
 * on its own. It is here because archiving hides a property from every default list, and
 * a destructive-looking irreversible-looking action deserves a sentence of explanation.
 *
 * Reactivation is a `PATCH` with `{ status: 'active' }` — the same
 * `UpdatePropertySchema` the edit form uses, because `PROPERTY_STATUSES` contains no
 * destructive value and so the update schema can safely carry the status.
 */

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/use-toast';

import * as api from './api-client';

export interface ArchiveButtonProps {
  propertyId: string;
  /** The property's current status, as read from the row by the server component. */
  status: string;
}

export function ArchiveButton({ propertyId, status }: ArchiveButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const archived = status === 'archived';

  async function run() {
    setBusy(true);
    try {
      if (archived) await api.updateProperty(propertyId, { status: 'active' });
      else await api.archiveProperty(propertyId);

      toast({
        title: archived ? 'Property reactivated' : 'Property archived',
        variant: 'success',
      });
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast({
        title: archived ? 'Could not reactivate' : 'Could not archive',
        description:
          error instanceof api.ApiClientError
            ? error.message
            : 'The request could not be completed.',
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  }

  // Reactivation is not destructive, so it does not need a confirmation step.
  if (archived) {
    return (
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
        {busy ? 'Reactivating…' : 'Reactivate'}
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Archive
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive this property?</DialogTitle>
          <DialogDescription>
            Archiving hides the property from the default list and blocks new units and edits.
            Nothing is deleted — the property, its units, its tenancies and its maintenance history
            all remain, and it can be reactivated at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy ? 'Archiving…' : 'Archive property'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
