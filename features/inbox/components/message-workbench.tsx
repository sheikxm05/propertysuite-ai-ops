'use client';

/**
 * What a human does with an inbound message.
 *
 * Two capabilities, kept visibly separate because they make different claims:
 *
 *   **Classify** reads the message and drafts a category, a summary and a priority. It
 *   creates nothing. The draft lands in an editable form, and the ticket exists only
 *   after somebody presses the confirm button — which posts `confirmed: true`, a literal
 *   the server requires. That gap is the product's central claim and this component is
 *   built around it rather than around the happy path.
 *
 *   **Run the agent** lets the agent answer with its read-only tool calls shown as
 *   inspectable steps, and surfaces any consequential action it wants taken as a
 *   proposal with Approve and Reject. A proposal is amber until a person decides, which
 *   is the colour rule applied to the exact case it was written for.
 *
 * Everything amber in here means the same thing: nobody has committed to this yet.
 *
 * The component decides nothing. It renders what the server returned and posts what the
 * operator typed; the role gate, the unit re-authorization and the priority policy all
 * run server-side and run again on submit.
 */

import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Bot, Check, ListChecks, Sparkles, X } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormLabel } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { TICKET_PRIORITY_STYLE, styleFor } from '@/components/ui/status';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { MAINTENANCE_CATEGORY_LABELS, type MaintenanceCategory } from '@shared/index';

import { STEP_OUTCOME_LABEL, STOP_REASON_LABEL } from '../domain/agent';
import type { SenderMatch } from '../domain/view';
import { MessageReply } from './message-reply';
import {
  classifyMessage,
  commitTicket,
  decideProposal,
  describe,
  runAgent,
  type AgentProposal,
  type AgentRunData,
  type AgentRunResponse,
  type ClassifyResponse,
} from './api-client';

export interface UnitOption {
  readonly id: string;
  readonly label: string;
}

export interface MessageWorkbenchProps {
  readonly messageId: string;
  /** Already committed. The workbench then shows the outcome instead of the controls. */
  readonly ticketId: string | null;
  readonly canClassify: boolean;
  readonly canCommit: boolean;
  /** Units in the caller's organization. The server re-authorizes whichever is chosen. */
  readonly units: readonly UnitOption[];
  /** The unit resolved from the sender's active tenancy, when there was exactly one. */
  readonly suggestedUnitId: string | null;
  /**
   * What the inbox resolved about the sender, for the reply surface below.
   *
   * Optional, and the detail page does not pass it yet — that is a one-line change on a
   * file this lane does not own, reported as a planning defect. Without it the reply
   * control is still offered and the server still refuses an unattributed reply; with
   * it, the control is never offered in a case that cannot succeed.
   */
  readonly sender?: SenderMatch | null;
  /** Whether this role may answer a tenant. Defaults to the ticket-commit gate. */
  readonly canReply?: boolean;
  /** The signed-in operator's name, shown on the sent receipt. Falls back to "you". */
  readonly actorName?: string | null;
}

type AgentState = AgentRunResponse['data'] | null;

export function MessageWorkbench({
  messageId,
  ticketId,
  canClassify,
  canCommit,
  units,
  suggestedUnitId,
  sender,
  canReply,
  actorName,
}: MessageWorkbenchProps) {
  const router = useRouter();
  const { toast } = useToast();

  /**
   * The reply surface, rendered in both branches below — a message that has already
   * become a ticket still has a tenant waiting on an answer. Answering is a staff
   * action, so it follows the same role gate as committing a ticket unless the caller
   * says otherwise, and the server re-checks whichever this screen decided.
   */
  const reply = (
    <MessageReply
      messageId={messageId}
      senderMatched={sender ? sender.matched : null}
      senderName={sender?.tenantName ?? null}
      canReply={canReply ?? canCommit}
      actorName={actorName ?? null}
    />
  );

  const [draft, setDraft] = React.useState<ClassifyResponse['data'] | null>(null);
  const [classifying, setClassifying] = React.useState(false);
  const [committing, setCommitting] = React.useState(false);
  const [agent, setAgent] = React.useState<AgentState>(null);
  const [agentRunning, setAgentRunning] = React.useState(false);
  const [decided, setDecided] = React.useState<Record<string, 'approve' | 'reject'>>({});

  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [unitId, setUnitId] = React.useState(suggestedUnitId ?? '');

  async function onClassify() {
    setClassifying(true);
    try {
      const result = await classifyMessage(messageId);
      setDraft(result.data);
      setTitle(result.data.suggested_title ?? '');
      setDescription(result.data.suggested_description ?? '');
      if (result.data.property_unit_id) setUnitId(result.data.property_unit_id);
      router.refresh();
    } catch (error) {
      toast({
        title: 'The assistant could not read this message',
        description: describe(error),
        variant: 'destructive',
      });
    } finally {
      setClassifying(false);
    }
  }

  async function onCommit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setCommitting(true);
    try {
      const created = await commitTicket(messageId, {
        property_unit_id: unitId,
        title,
        description,
        category: draft.draft.category,
        ...(draft.resolved_priority ? { priority: draft.resolved_priority } : {}),
      });
      toast({
        title: 'Ticket created',
        description: `Priority ${created.data.priority}, decided by policy rather than by the model.`,
        variant: 'success',
      });
      router.push(`/maintenance/${created.data.id}`);
    } catch (error) {
      toast({
        title: 'The ticket was not created',
        description: describe(error),
        variant: 'destructive',
      });
    } finally {
      setCommitting(false);
    }
  }

  async function onRunAgent() {
    setAgentRunning(true);
    try {
      const result = await runAgent(messageId);
      setAgent(result.data);
    } catch (error) {
      toast({
        title: 'The agent could not be run',
        description: describe(error),
        variant: 'destructive',
      });
    } finally {
      setAgentRunning(false);
    }
  }

  async function onDecide(proposal: AgentProposal, decision: 'approve' | 'reject') {
    if (!proposal.id) return;
    try {
      await decideProposal(proposal.id, decision);
      setDecided((previous) => ({ ...previous, [proposal.id as string]: decision }));
      toast({
        title: decision === 'approve' ? 'Proposal approved' : 'Proposal rejected',
        description:
          decision === 'approve'
            ? 'Your decision is recorded. Approving does not carry the action out — whatever acts on it re-derives its facts under your credentials.'
            : 'Nothing was changed. The proposal is closed.',
        variant: decision === 'approve' ? 'success' : 'default',
      });
      router.refresh();
    } catch (error) {
      toast({
        title: 'The decision was refused',
        description: describe(error),
        variant: 'destructive',
      });
    }
  }

  /* ------------------------------------------------------------ committed -- */

  if (ticketId) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">This message is now a ticket</CardTitle>
            <CardDescription>
              A person confirmed it. Everything after this point is the ordinary maintenance
              workflow — the same state machine, the same activity trail, the same audit row a
              manually reported issue produces.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <a href={`/maintenance/${ticketId}`}>Open the ticket</a>
            </Button>
          </CardContent>
        </Card>

        {reply}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* --------------------------------------------------------- classify -- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">Assistant</CardTitle>
            {draft ? <Badge variant="warning">Drafted · awaiting a human</Badge> : null}
          </div>
          <CardDescription>
            The assistant reads the message and proposes a classification. It creates nothing: the
            response says so, and there is no ticket write on that code path at all.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          {canClassify ? (
            <Button
              onClick={onClassify}
              disabled={classifying}
              variant={draft ? 'outline' : 'default'}
            >
              <Sparkles aria-hidden="true" />
              {classifying
                ? 'Reading the message…'
                : draft
                  ? 'Classify again'
                  : 'Classify this message'}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              Your role can read this message but not classify it.
            </p>
          )}

          {draft ? (
            <>
              <Separator />
              <DraftSummary draft={draft} />

              {canCommit ? (
                <>
                  <Separator />
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Confirm and create the ticket</p>
                    <p className="text-sm text-muted-foreground">
                      Edit anything below before committing. The priority is re-decided by policy on
                      the server whatever this form says, and the unit is re-authorized against your
                      organization.
                    </p>
                  </div>

                  <Form onSubmit={onCommit}>
                    <FormField name="property_unit_id">
                      <FormLabel required>Unit</FormLabel>
                      <FormControl>
                        <select
                          name="property_unit_id"
                          required
                          value={unitId}
                          onChange={(event) => setUnitId(event.target.value)}
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
                        {draft.unit_label
                          ? `Pre-selected from the sender's active tenancy: ${draft.unit_label}.`
                          : 'The sender resolved to no single tenancy, so nothing is pre-selected. Choosing is a human decision, not a guess.'}
                      </FormDescription>
                    </FormField>

                    <FormField name="title">
                      <FormLabel required>Summary</FormLabel>
                      <FormControl>
                        <Input
                          name="title"
                          required
                          minLength={3}
                          maxLength={200}
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                        />
                      </FormControl>
                    </FormField>

                    <FormField name="description">
                      <FormLabel required>Description</FormLabel>
                      <FormControl>
                        <Textarea
                          name="description"
                          required
                          minLength={10}
                          maxLength={4000}
                          rows={4}
                          value={description}
                          onChange={(event) => setDescription(event.target.value)}
                        />
                      </FormControl>
                      <FormDescription>
                        Your words, pre-filled from the draft. Editing them is the point of the
                        gate.
                      </FormDescription>
                    </FormField>

                    <Button type="submit" disabled={committing || unitId === ''}>
                      <Check aria-hidden="true" />
                      {committing ? 'Creating…' : 'Confirm and create the ticket'}
                    </Button>
                  </Form>
                </>
              ) : (
                <Alert>
                  <ListChecks aria-hidden="true" />
                  <AlertTitle>A draft, and nothing more</AlertTitle>
                  <AlertDescription>
                    Turning an inbound message into a ticket on somebody else&rsquo;s behalf is an
                    operator action. Your role can see the draft but not commit it.
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------ reply -- */}
      {reply}

      {/* ------------------------------------------------------------ agent -- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agent</CardTitle>
          <CardDescription>
            The agent may read. It may not act. Anything consequential comes back as a proposal that
            a staff member approves or rejects, and the approval is carried out by a database
            function that checks who is asking — not by anything the model said.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <Button onClick={onRunAgent} disabled={agentRunning} variant="outline">
            <Bot aria-hidden="true" />
            {agentRunning ? 'Running…' : 'Run the agent over this message'}
          </Button>

          {agent && !agent.available ? (
            <Alert variant="warning">
              <Bot aria-hidden="true" />
              <AlertTitle>The agent is not available in this build</AlertTitle>
              <AlertDescription>
                {agent.reason === 'agent_absent'
                  ? 'POST /api/v1/ai/agent/run is not deployed here. The classification path above is unaffected and is the one this demo relies on.'
                  : `The agent service answered ${agent.upstream_status ?? 'nothing at all'}. Nothing was changed.`}
              </AlertDescription>
            </Alert>
          ) : null}

          {agent?.run ? (
            <AgentRunPanel
              run={agent.run}
              decided={decided}
              canDecide={canCommit}
              onDecide={onDecide}
            />
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ draft -- */

function DraftSummary({ draft }: { draft: ClassifyResponse['data'] }) {
  const resolved = styleFor(TICKET_PRIORITY_STYLE, draft.resolved_priority);
  const suggested = draft.suggested_priority
    ? styleFor(TICKET_PRIORITY_STYLE, draft.suggested_priority)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {MAINTENANCE_CATEGORY_LABELS[draft.draft.category as MaintenanceCategory] ??
            draft.draft.category}
        </Badge>
        <Badge variant={resolved.variant}>Priority: {resolved.label}</Badge>
        {suggested && draft.suggestion_capped ? (
          <Badge variant="outline">Model suggested {suggested.label} — capped by policy</Badge>
        ) : null}
      </div>

      <p className="text-sm">{draft.draft.summary}</p>

      {draft.draft.reported_symptoms.length > 0 ? (
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          {draft.draft.reported_symptoms.map((symptom) => (
            <li key={symptom}>{symptom}</li>
          ))}
        </ul>
      ) : null}

      {draft.draft.requires_clarification && draft.draft.clarification_question ? (
        <Alert variant="warning">
          <ListChecks aria-hidden="true" />
          <AlertTitle>The assistant needs an answer first</AlertTitle>
          <AlertDescription>{draft.draft.clarification_question}</AlertDescription>
        </Alert>
      ) : null}

      {draft.priority_reasons.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Priority decided by policy: {draft.priority_reasons.join(', ')}.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {draft.provider} · {draft.model} · prompt {draft.prompt_version} · created nothing
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ agent -- */

function AgentRunPanel({
  run,
  decided,
  canDecide,
  onDecide,
}: {
  run: AgentRunData;
  decided: Record<string, 'approve' | 'reject'>;
  canDecide: boolean;
  onDecide: (proposal: AgentProposal, decision: 'approve' | 'reject') => void;
}) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline">{STOP_REASON_LABEL[run.stop_reason]}</Badge>
        <span>
          {run.rounds} {run.rounds === 1 ? 'round' : 'rounds'} · {run.model} · prompt{' '}
          {run.prompt_version}
        </span>
        {/* `executed` is a literal `false` in the schema. Saying so on screen is the
            cheapest possible restatement of the product's central claim. */}
        <Badge variant="secondary">Executed nothing</Badge>
        {run.persisted ? null : <Badge variant="warning">Not stored</Badge>}
      </div>

      {run.summary ? (
        <div className="rounded-md border bg-muted/40 p-4">
          <p className="whitespace-pre-wrap text-sm">{run.summary}</p>
        </div>
      ) : null}

      {run.steps.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            Steps{' '}
            <span className="font-normal text-muted-foreground">
              ({run.steps.length}) — the fact of each call, not its result
            </span>
          </p>
          <ol className="space-y-2">
            {run.steps.map((step, index) => (
              <li
                key={`${step.tool}-${step.round}-${index}`}
                className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
              >
                <span className="text-muted-foreground">{index + 1}.</span>
                <span className="font-mono text-xs">{step.tool}</span>
                <Badge variant={step.kind === 'read' ? 'secondary' : 'warning'}>
                  {step.kind === 'read'
                    ? 'read-only'
                    : step.kind === 'propose'
                      ? 'proposal'
                      : 'unknown'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {STEP_OUTCOME_LABEL[step.outcome]}
                </span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                  {step.duration_ms} ms
                </span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            A step reports the tool, whether it read or proposed, and how it ended — never what it
            returned. A read tool returns rows from your organization, and putting them back on the
            wire would widen a projection the database had already narrowed correctly.
          </p>
        </div>
      ) : null}

      {run.proposals.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">Proposed actions</p>
          {run.proposals.map((proposal, index) => {
            const outcome = proposal.id ? decided[proposal.id] : undefined;
            return (
              <div
                key={proposal.id ?? `${proposal.tool_name}-${index}`}
                className="space-y-3 rounded-md border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{proposal.tool_name}</span>
                  {outcome === 'approve' ? (
                    <Badge variant="success">Approved by you</Badge>
                  ) : outcome === 'reject' ? (
                    <Badge variant="outline">Rejected by you</Badge>
                  ) : (
                    <Badge variant="warning">Awaiting your decision</Badge>
                  )}
                </div>

                <p className="text-sm">{proposal.rationale}</p>

                {proposal.adjustments.length > 0 ? (
                  <Alert variant="warning">
                    <ListChecks aria-hidden="true" />
                    <AlertTitle>The server adjusted what the model asked for</AlertTitle>
                    <AlertDescription>
                      <ul className="list-inside list-disc">
                        {proposal.adjustments.map((adjustment) => (
                          <li key={adjustment}>{adjustment}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                ) : null}

                <CodeBlock label="Arguments, verbatim" value={stringify(proposal.arguments)} />

                {outcome ? null : !proposal.id ? (
                  <p className="text-xs text-muted-foreground">
                    This proposal could not be stored, so there is no row to approve. It is shown so
                    you can see what was asked for — the failure points in the safe direction.
                  </p>
                ) : canDecide ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => onDecide(proposal, 'approve')}>
                      <Check aria-hidden="true" />
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onDecide(proposal, 'reject')}
                    >
                      <X aria-hidden="true" />
                      Reject
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Only staff can decide a proposal. The database function refuses anyone else
                    independently of this screen.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Pretty-prints tool arguments, bounded so one proposal cannot push the buttons away. */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 2000);
  } catch {
    return '{}';
  }
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
        <code>{value}</code>
      </pre>
    </div>
  );
}
