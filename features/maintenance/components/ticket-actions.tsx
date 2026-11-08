'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import type { ProviderOption } from '@/features/maintenance/domain';
import type { TicketStatus } from '@shared/index';

import {
  addActivityRequest,
  assignTicketRequest,
  completeTicketRequest,
  transitionTicket,
  uploadEvidence,
} from './api-client';
import { describe } from './create-ticket-form';

/**
 * The action panel on a ticket.
 *
 * `transitions` is `available_transitions` from the detail response, computed
 * server-side by `availableTransitions(ticket, membership)` — the shared rule set with
 * the row bound in. So this component renders buttons; it does not decide which ones
 * exist. If it rendered a button the server refuses, the server refuses it, and if it
 * omitted one the server permits, the only loss is a feature. Neither outcome is an
 * authorization decision taken in the browser.
 *
 * Two transitions are NOT plain buttons, because each needs more than a status:
 *
 *  - `assigned` needs a provider, so it renders the assign form. A bare
 *    `PATCH { status: 'assigned' }` would leave `assigned_provider_id` null and produce a
 *    ticket nobody can see, which is why `/assign` is a separate route.
 *  - `completed` needs a resolution summary, optional evidence and an explicit
 *    confirmation, so it renders the completion form.
 *
 * Everything else — `in_progress`, `awaiting_approval`, `cancelled` — is a status and
 * nothing more, and goes through PATCH.
 */
export interface TicketActionsProps {
  ticketId: string;
  transitions: readonly TicketStatus[];
  /** Active providers in the organization. Empty for anyone who may not assign. */
  providers: readonly ProviderOption[];
}

const PLAIN_TRANSITIONS: readonly TicketStatus[] = [
  'in_progress',
  'awaiting_approval',
  'cancelled',
];

const TRANSITION_LABELS: Readonly<Partial<Record<TicketStatus, string>>> = {
  in_progress: 'Start work',
  awaiting_approval: 'Submit for approval',
  cancelled: 'Cancel ticket',
};

export function TicketActions({ ticketId, transitions, providers }: TicketActionsProps) {
  const plain = PLAIN_TRANSITIONS.filter((status) => transitions.includes(status));
  const canAssign = transitions.includes('assigned');
  const canComplete = transitions.includes('completed');

  if (plain.length === 0 && !canAssign && !canComplete) {
    return (
      <p className="text-sm text-muted-foreground">
        There are no actions available to you on this ticket.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {plain.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {plain.map((status) => (
            <TransitionButton key={status} ticketId={ticketId} status={status} />
          ))}
        </div>
      )}
      {canAssign && <AssignForm ticketId={ticketId} providers={providers} />}
      {canComplete && <CompleteForm ticketId={ticketId} />}
    </div>
  );
}

/* ------------------------------------------------------------- transitions -- */

function TransitionButton({ ticketId, status }: { ticketId: string; status: TicketStatus }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);

  async function run() {
    setPending(true);
    try {
      await transitionTicket(ticketId, status);
      toast({ title: `Ticket moved to ${status.replace(/_/g, ' ')}.`, variant: 'success' });
      router.refresh();
    } catch (error) {
      // A 409 means the edge does not exist from the ticket's CURRENT status, which on
      // this screen almost always means somebody else moved it first. The server's own
      // message says which, so it is shown verbatim.
      toast({ title: 'Action refused', description: describe(error), variant: 'destructive' });
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      variant={status === 'cancelled' ? 'destructive' : 'default'}
      disabled={pending}
      onClick={run}
    >
      {TRANSITION_LABELS[status] ?? status}
    </Button>
  );
}

/* ----------------------------------------------------------------- assign -- */

function AssignForm({
  ticketId,
  providers,
}: {
  ticketId: string;
  providers: readonly ProviderOption[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);

  if (providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No active service provider is available in this organization.
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const note = String(data.get('note') ?? '').trim();
    setPending(true);

    try {
      await assignTicketRequest(ticketId, {
        provider_id: String(data.get('provider_id') ?? ''),
        ...(note === '' ? {} : { note }),
      });
      toast({ title: 'Provider assigned.', variant: 'success' });
      router.refresh();
    } catch (error) {
      toast({ title: 'Could not assign', description: describe(error), variant: 'destructive' });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Assign a provider</h3>
      <div className="space-y-1">
        <Label htmlFor="provider_id">Provider</Label>
        <select
          id="provider_id"
          name="provider_id"
          required
          defaultValue=""
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
        >
          <option value="" disabled>
            Select a provider
          </option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Only providers in your own organization are listed, and the server, RLS, a trigger and a
          composite foreign key each check it again.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="note">Note for the timeline (optional)</Label>
        <Input id="note" name="note" maxLength={2000} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Assigning…' : 'Assign'}
      </Button>
    </form>
  );
}

/* --------------------------------------------------------------- complete -- */

/**
 * Completion confirmation.
 *
 * Reachable only when the server put `completed` in `available_transitions`, which for
 * `awaiting_approval -> completed` means an organization admin, a property manager or the
 * reporting tenant. A service provider never sees this form, and would be refused by the
 * route, by RLS and by the trigger if they constructed the request by hand.
 *
 * The confirmation checkbox is the `confirmed: true` literal in `CompleteTicketSchema`.
 * `completed` is terminal with no reopen edge, so the close is deliberately not a
 * one-click action.
 *
 * Evidence is uploaded through lane w1-l6's documents endpoint BEFORE the close, and the
 * completion cites the resulting document ids. The server verifies every id is already
 * attached to this ticket, so a half-finished upload fails the completion rather than
 * closing a ticket with no evidence behind its claim.
 */
function CompleteForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [documentIds, setDocumentIds] = React.useState<string[]>([]);

  async function onUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const documentId = await uploadEvidence(ticketId, file);
      setDocumentIds((current) => [...current, documentId]);
      toast({ title: 'Evidence uploaded.', variant: 'success' });
    } catch (error) {
      toast({ title: 'Upload failed', description: describe(error), variant: 'destructive' });
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);

    try {
      await completeTicketRequest(ticketId, {
        resolution_summary: String(data.get('resolution_summary') ?? ''),
        ...(documentIds.length === 0 ? {} : { evidence_document_ids: documentIds }),
      });
      toast({ title: 'Ticket completed.', variant: 'success' });
      router.refresh();
    } catch (error) {
      toast({ title: 'Could not complete', description: describe(error), variant: 'destructive' });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-semibold">Confirm completion</h3>
      <div className="space-y-1">
        <Label htmlFor="resolution_summary">What was done?</Label>
        <Textarea
          id="resolution_summary"
          name="resolution_summary"
          required
          minLength={10}
          maxLength={1000}
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          Recorded permanently on the timeline. It cannot be edited afterwards.
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="evidence">Evidence (PDF, optional)</Label>
        <Input
          id="evidence"
          type="file"
          accept="application/pdf"
          disabled={uploading}
          onChange={onUpload}
        />
        <p className="text-xs text-muted-foreground">
          {documentIds.length === 0
            ? 'No evidence attached yet.'
            : `${documentIds.length} document${documentIds.length === 1 ? '' : 's'} attached.`}
        </p>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" required className="mt-1" name="confirm" />
        <span>I confirm this work is complete. This closes the ticket and cannot be undone.</span>
      </label>

      <Button type="submit" disabled={pending}>
        {pending ? 'Completing…' : 'Complete ticket'}
      </Button>
    </form>
  );
}

/* --------------------------------------------------------------- comments -- */

/**
 * Adds a `comment_added` row to the timeline.
 *
 * `activity_type` is fixed. The server refuses the transition types outright
 * (`isClientPostableActivityType`), because a client that could post `status_changed`
 * could manufacture a second transition row in a table that can never be corrected.
 */
export function AddCommentForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);

    try {
      await addActivityRequest(ticketId, {
        activity_type: 'comment_added',
        description: String(data.get('description') ?? ''),
      });
      form.reset();
      toast({ title: 'Comment added.', variant: 'success' });
      router.refresh();
    } catch (error) {
      toast({
        title: 'Could not add comment',
        description: describe(error),
        variant: 'destructive',
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <Label htmlFor="description">Add a note</Label>
      <Textarea
        id="description"
        name="description"
        required
        minLength={1}
        maxLength={1000}
        rows={3}
      />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Adding…' : 'Add note'}
      </Button>
    </form>
  );
}
