'use client';

/**
 * The simulator.
 *
 * This is the control the demo opens on, so the copy on it is part of the engineering,
 * not decoration around it. It says what it is: there are no Meta credentials in this
 * build, so the message is injected into *our own webhook endpoint* in the exact shape
 * Meta posts. Signature handling, idempotency, sender resolution and the row write are
 * the production path. The carrier is simulated; the pipeline is not.
 *
 * Three affordances, in the order a demonstrator uses them:
 *
 *   1. **A scripted scenario, one click.** The recorded message is a constant in
 *      `domain/scenarios.ts` and is never retyped, so every take is the same input.
 *   2. **Who it is from.** A tenant from this organization, whose number the server
 *      reads off their record — or the deliberately unknown number, which is how the
 *      unmatched case is demonstrated on camera.
 *   3. **Send.** The response says which path the delivery actually took, and that
 *      answer is shown rather than logged.
 *
 * It decides nothing. The role gate, the sender resolution and the organization all
 * happen on the server; this component cannot send an `organization_id` because no field
 * in the request carries one.
 */

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { MessageSquarePlus, Radio, Repeat2, ShieldOff } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormLabel } from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';

import { INBOX_SCENARIOS, UNKNOWN_SENDER } from '../domain/scenarios';
import { IngestionBadge } from './badges';
import { describe, simulateMessage, type SimulateResponse } from './api-client';

/** A tenant the operator may send as. Phone numbers are never sent to the browser. */
export interface SimulatableTenant {
  readonly id: string;
  readonly label: string;
  /** False when the tenant has no number on record, so WhatsApp could not reach us. */
  readonly reachable: boolean;
}

export interface SimulateComposerProps {
  readonly tenants: readonly SimulatableTenant[];
  /**
   * Whether this caller may send from a number that is not their own. Staff may, which
   * is what makes the unmatched-sender demonstration possible; a tenant may not, and the
   * server refuses independently.
   */
  readonly canUseArbitrarySender: boolean;
}

const UNKNOWN_OPTION = '__unknown__';

export function SimulateComposer({ tenants, canUseArbitrarySender }: SimulateComposerProps) {
  const router = useRouter();
  const { toast } = useToast();

  const reachable = tenants.filter((tenant) => tenant.reachable);
  const [sender, setSender] = React.useState<string>(reachable[0]?.id ?? UNKNOWN_OPTION);
  const [body, setBody] = React.useState<string>(INBOX_SCENARIOS[0]?.body ?? '');
  const [scenario, setScenario] = React.useState<string>(INBOX_SCENARIOS[0]?.key ?? '');
  const [pending, setPending] = React.useState(false);
  const [last, setLast] = React.useState<SimulateResponse['data'] | null>(null);

  function applyScenario(key: string) {
    const chosen = INBOX_SCENARIOS.find((candidate) => candidate.key === key);
    if (!chosen) return;
    setScenario(chosen.key);
    setBody(chosen.body);
    if (chosen.unknownSender && canUseArbitrarySender) setSender(UNKNOWN_OPTION);
    if (!chosen.unknownSender && sender === UNKNOWN_OPTION && reachable[0]) {
      setSender(reachable[0].id);
    }
  }

  async function deliver(replayOf?: string) {
    setPending(true);
    try {
      const result = await simulateMessage({
        body,
        ...(sender === UNKNOWN_OPTION ? { from: UNKNOWN_SENDER } : { tenant_id: sender }),
        ...(scenario ? { scenario } : {}),
        ...(replayOf ? { replay_of: replayOf } : {}),
      });

      setLast(result.data);
      toast({
        title: result.data.duplicates > 0 ? 'Duplicate suppressed' : 'Delivered to the webhook',
        description:
          result.data.ingestion_path === 'direct'
            ? 'The webhook could not be reached, so the row was written directly. Signature verification and the idempotency gate did not run.'
            : result.data.duplicates > 0
              ? 'The endpoint answered 200 and reported the delivery as a duplicate. Postgres refused the second insert; no application code checked.'
              : 'Signed, verified and ingested by the production webhook handler.',
        variant:
          result.data.ingestion_path === 'direct'
            ? 'destructive'
            : result.data.duplicates > 0
              ? 'warning'
              : 'success',
      });

      // Re-runs the server render of the list, so the new row appears without a reload.
      router.refresh();
    } catch (error) {
      toast({
        title: 'The message could not be delivered',
        description: describe(error),
        variant: 'destructive',
      });
    } finally {
      setPending(false);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await deliver();
  }

  const canSend = body.trim().length > 0 && (sender !== UNKNOWN_OPTION || canUseArbitrarySender);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">Simulate an incoming WhatsApp message</CardTitle>
          <Badge variant="secondary">Simulator</Badge>
          {last ? <IngestionBadge path={last.ingestion_path} /> : null}
          {last?.webhook_mode ? (
            <Badge variant="outline" title="Which key verified the signature.">
              {last.webhook_mode} mode
            </Badge>
          ) : null}
        </div>
        <CardDescription>
          No Meta credentials are configured in this build, so no live message can arrive. This
          composer builds a WhatsApp Cloud API webhook payload and posts it to this
          application&rsquo;s own webhook endpoint — the one production traffic uses. Signature
          handling, idempotency on the message id, sender resolution and the row write are all the
          real code path. The only thing being simulated is the carrier.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium">Scripted scenarios</p>
          <div className="flex flex-wrap gap-2">
            {INBOX_SCENARIOS.map((candidate) => (
              <Button
                key={candidate.key}
                type="button"
                size="sm"
                variant={scenario === candidate.key ? 'secondary' : 'outline'}
                onClick={() => applyScenario(candidate.key)}
                title={candidate.intent}
              >
                {candidate.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {INBOX_SCENARIOS.find((candidate) => candidate.key === scenario)?.intent ??
              'Pick a scenario, or write your own message below.'}
          </p>
        </div>

        <Form onSubmit={onSubmit}>
          <FormField name="sender">
            <FormLabel required>Send as</FormLabel>
            <FormControl>
              <select
                name="sender"
                value={sender}
                onChange={(event) => setSender(event.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                {reachable.map((tenant) => (
                  <option key={tenant.id} value={tenant.id}>
                    {tenant.label}
                  </option>
                ))}
                {canUseArbitrarySender ? (
                  <option value={UNKNOWN_OPTION}>
                    An unknown number ({UNKNOWN_SENDER}) — nobody in this organization
                  </option>
                ) : null}
              </select>
            </FormControl>
            <FormDescription>
              A named tenant&rsquo;s number is read from their record on the server, never sent from
              here. The unknown number resolves to nobody, which is the point of offering it.
            </FormDescription>
          </FormField>

          <FormField name="body">
            <FormLabel required>Message</FormLabel>
            <FormControl>
              <Textarea
                name="body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                required
                minLength={1}
                maxLength={4000}
                rows={4}
              />
            </FormControl>
            <FormDescription>
              Whatever is typed here is untrusted text. It reaches the model fenced as data and
              cannot become an instruction — try the injection scenario and watch it do nothing.
            </FormDescription>
          </FormField>

          <Button type="submit" disabled={pending || !canSend}>
            <MessageSquarePlus aria-hidden="true" />
            {pending ? 'Delivering…' : 'Deliver to the webhook'}
          </Button>
        </Form>

        {last ? <DeliveryOutcome outcome={last} pending={pending} onReplay={deliver} /> : null}

        {reachable.length === 0 ? (
          <Alert variant="warning">
            <Radio aria-hidden="true" />
            <AlertTitle>No tenant in this organization has a phone number on record</AlertTitle>
            <AlertDescription>
              A simulated delivery needs a sender. Add a phone number to a tenant and they appear in
              this list; until then only the unknown-number scenario can be sent.
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- the result -- */

/**
 * What actually happened to the last delivery.
 *
 * Three facts, each of which is a claim the demo is making and none of which is visible
 * anywhere else:
 *
 *   **the counts** — `accepted` and `duplicates` come straight from the webhook's own
 *   response. A replay reports `duplicates: 1` because Postgres raised `23505` on
 *   `webhook_events`'s unique index, not because any code noticed a repeat. The replay
 *   button is here so that beat takes one click.
 *
 *   **the resolution** — `unmatched` means the sender resolved to no tenant.
 *
 *   **whether anyone can see it** — and this is the one worth reading twice. An
 *   unattributed row carries no `organization_id`, and the SELECT policy on
 *   `inbound_messages` requires one, so the message is visible to **no organization at
 *   all**, including the one whose operator just injected it. The inbox is not hiding
 *   it from you; there is nothing you are entitled to see. That is the isolation
 *   boundary at its most absolute, and it is why the message does not appear in the list
 *   below.
 */
function DeliveryOutcome({
  outcome,
  pending,
  onReplay,
}: {
  outcome: SimulateResponse['data'];
  pending: boolean;
  onReplay: (replayOf: string) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Last delivery</p>
        <Badge variant={outcome.accepted > 0 ? 'success' : 'outline'}>
          accepted {outcome.accepted}
        </Badge>
        <Badge variant={outcome.duplicates > 0 ? 'warning' : 'outline'}>
          duplicates {outcome.duplicates}
        </Badge>
        {outcome.resolution_status ? (
          <Badge variant="secondary">{outcome.resolution_status.replace(/_/g, ' ')}</Badge>
        ) : null}
      </div>

      <p className="break-all font-mono text-xs text-muted-foreground">
        {outcome.external_message_id}
      </p>

      {outcome.attributed ? (
        <p className="text-sm text-muted-foreground">
          The sender resolved to a tenant in this organization, so the message is attributed and
          appears in the queue below.
        </p>
      ) : (
        <Alert>
          <ShieldOff aria-hidden="true" />
          <AlertTitle>Unattributed — visible to no organization</AlertTitle>
          <AlertDescription>
            That number maps to no tenant anywhere we are allowed to look, so the row carries no
            organization. The read policy on inbound messages requires one, which means nobody can
            see it — not another organization, and not yours either. It is stored, it is
            deduplicated, and it is unreachable. That is the boundary refusing to guess rather than
            a message going missing.
          </AlertDescription>
        </Alert>
      )}

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => onReplay(outcome.external_message_id)}
      >
        <Repeat2 aria-hidden="true" />
        Send this exact delivery again
      </Button>
      <p className="text-xs text-muted-foreground">
        Same signed payload, same message id. The endpoint answers 200 and reports it as a duplicate
        — the unique index on <code>(provider, event_id)</code> is what makes Meta&rsquo;s
        at-least-once retries have exactly-once effects.
      </p>
    </div>
  );
}
