'use client';

/**
 * The approval gate. This card is the product.
 *
 * Everything else on this screen is a conversation; this is the moment the application's
 * central claim either holds or does not. CLAUDE.md rule 7: *no model output reaches a
 * mutation without an authenticated human confirmation in between.* That is enforced in
 * three places a user cannot see —
 *
 *   `supabase/migrations/0004_agentic.sql` revokes UPDATE on `agent_proposals` and
 *   declares no UPDATE policy, so no client statement can move a row off `pending`;
 *   `approve_agent_proposal(p_id)` runs `security definer` and re-checks `is_org_staff()`
 *   against the proposal's own organization; and the route gates on `STAFF_ROLES` first
 *   so the 403 arrives early and for the right reason
 *
 * — and in exactly one place a user can: here.
 *
 * FIVE DESIGN DECISIONS, EACH OF WHICH COULD HAVE GONE WRONG
 * -----------------------------------------------------------
 * 1. **The action is stated in English before it is stated in JSON.** A manager approving
 *    `{"tool_name":"create_ticket","arguments":{…}}` is not giving informed consent. The
 *    headline is an imperative sentence; the raw arguments sit one click below it,
 *    complete and unedited, so the sentence can be checked rather than trusted.
 *
 * 2. **Pending is amber, and amber means one thing in this product.** The rule
 *    `components/ui/status.ts` encodes — "`warning`: a human decision is outstanding;
 *    nobody has committed to this yet" — is the same colour a tenant sees on an
 *    unverified document and a manager sees on a ticket awaiting approval.
 *
 * 3. **The card says "nothing has happened yet" in those words.** Not "draft", not
 *    "suggested", not an icon. The one thing a reviewer must leave this screen believing
 *    is that the model's intent and the system's state are different things.
 *
 * 4. **Approval is not execution, and this card refuses to imply it is.** The approval
 *    response carries `executed: false` as a schema literal. Approving records that a
 *    human agreed; carrying the action out is a separate step that re-derives every
 *    security-relevant value under that human's own credentials — "an approved row is a
 *    record of intent; it is never an authorisation token". So the success state says
 *    what was recorded, and does not invent a ticket to link to.
 *
 * 5. **A role that cannot approve is not offered a button.** Not a disabled one, not one
 *    that 403s — none, and a sentence naming who may. Offering the control anyway would
 *    misrepresent the authorization model on the one screen whose job is to represent it.
 *
 * Rejection is kept in the transcript rather than dismissed. "The agent proposed X and a
 * human said no" is the record, and a disappearing card erases exactly the evidence that
 * matters.
 */

import {
  AlertTriangle,
  Check,
  CircleSlash,
  Loader2,
  Lock,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/components/ui/utils';
import { DEFAULT_LOCALE } from '@shared/index';

import { describeAdjustment, describeProposal } from '../describe';
import { AGENT_DECISION_STYLE, type AgentProposal, type ProposalDecision } from '../wire';
import type { AgentDecision } from '../transport';
import { Disclosure, RawJson } from './disclosure';

export interface ProposalCardProps {
  readonly proposal: AgentProposal;
  /** Where this proposal stands with a human, as far as this session knows. */
  readonly decision: ProposalDecision;
  /** When the decision was taken, ISO. `null` while pending. */
  readonly decidedAt: string | null;
  /** Who took it — the signed-in member's own name. `null` while pending. */
  readonly decidedBy: string | null;
  /**
   * Whether the signed-in member holds a staff role. Resolved on the server from trusted
   * `organization_members` rows and passed down — never read from a cookie or inferred in
   * the browser. Presentation only: the database refuses regardless of what this says.
   */
  readonly canApprove: boolean;
  /** The caller's role in words, for the sentence shown when they may not approve. */
  readonly roleLabel: string;
  /** `true` while this card's decision is in flight. */
  readonly busy: boolean;
  /** Set when the last decision on this card was refused. */
  readonly error: string | null;
  readonly onDecide: (proposalId: string, decision: AgentDecision) => void;
}

export function ProposalCard({
  proposal,
  decision,
  decidedAt,
  decidedBy,
  canApprove,
  roleLabel,
  busy,
  error,
  onDecide,
}: ProposalCardProps) {
  const description = describeProposal(proposal);
  const style = AGENT_DECISION_STYLE[decision];
  const pending = decision === 'pending';

  // `id` is nullable by contract: a proposal the server could not store is reported
  // honestly rather than dropped, and since approval takes a row id, an unstored proposal
  // is an unapprovable one. That is the safe direction for the failure to point in, and
  // the card has to show it rather than render a button that cannot work.
  const approvable = proposal.id !== null;

  return (
    <Card
      className={cn(
        'border-l-4',
        pending && approvable && 'border-l-warning bg-warning/5',
        pending && !approvable && 'border-l-destructive',
        (decision === 'approved' || decision === 'executed') && 'border-l-success',
        decision === 'rejected' && 'border-l-destructive',
      )}
    >
      <CardHeader className="gap-3 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={style.variant}>{style.label}</Badge>
          <Badge variant="outline" className="gap-1 font-normal">
            <Sparkles className="size-3" aria-hidden="true" />
            Proposed by the assistant
          </Badge>
          <code className="ml-auto truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {proposal.tool_name}
          </code>
        </div>

        <CardTitle className="text-balance text-lg leading-snug">{description.headline}</CardTitle>
        <p className="text-pretty text-sm text-muted-foreground">{description.sentence}</p>
      </CardHeader>

      <CardContent className="space-y-4">
        {pending ? (
          <Alert variant="warning">
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>Nothing has happened yet.</AlertTitle>
            <AlertDescription>
              The assistant stopped here on purpose. No ticket exists, nobody has been assigned and
              no priority has moved. This becomes real only when a human approves it, and there is
              no path by which the model can commit it on its own.
            </AlertDescription>
          </Alert>
        ) : null}

        {description.facts.length > 0 ? (
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]">
            {description.facts.map((fact) => (
              <div key={fact.key} className="contents">
                <dt className="text-sm text-muted-foreground">{fact.label}</dt>
                <dd
                  className={cn(
                    'min-w-0 break-words text-sm',
                    fact.mono && 'font-mono text-xs text-muted-foreground',
                  )}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        {proposal.adjustments.length > 0 ? (
          <Alert>
            <SlidersHorizontal aria-hidden="true" />
            <AlertTitle>The server changed what the model asked for</AlertTitle>
            <AlertDescription>
              <ul className="list-inside list-disc space-y-1">
                {proposal.adjustments.map((adjustment) => (
                  <li key={adjustment}>{describeAdjustment(adjustment)}</li>
                ))}
              </ul>
              <p className="pt-2">
                You are approving the adjusted arguments above, not the model&rsquo;s original
                request.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {proposal.rationale.trim().length > 0 ? (
          <div className="space-y-1">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Why the assistant suggests this
            </h4>
            <blockquote className="text-pretty border-l-2 pl-3 text-sm text-muted-foreground">
              {proposal.rationale}
            </blockquote>
          </div>
        ) : null}

        <Disclosure
          label={
            description.truncated
              ? 'Show the raw arguments (some values are only shown here)'
              : 'Show the raw arguments'
          }
        >
          <RawJson value={proposal.arguments} label={`Raw arguments for ${proposal.tool_name}`} />
        </Disclosure>

        {pending && !approvable ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>This proposal was not stored, so it cannot be approved.</AlertTitle>
            <AlertDescription>
              Approval takes a row id and this proposal has none. It is shown rather than hidden so
              the record is honest about what the assistant suggested — but nothing can act on it.
            </AlertDescription>
          </Alert>
        ) : null}

        {decision === 'approved' || decision === 'executed' ? (
          <Alert variant="success">
            <Check aria-hidden="true" />
            <AlertTitle>Approved by a human.</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{decidedLine('Approved', decidedBy, decidedAt)}</p>
              <p>
                Recorded against your account and written to the audit trail. Approval is the
                decision, not the execution: carrying it out re-derives the unit, the property and
                the priority under your own credentials rather than trusting the arguments above. An
                approved proposal is a record of intent, never an authorisation token.
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {decision === 'rejected' ? (
          <Alert variant="destructive">
            <CircleSlash aria-hidden="true" />
            <AlertTitle>Rejected. Nothing was created.</AlertTitle>
            <AlertDescription>
              {decidedLine('Rejected', decidedBy, decidedAt)} It stays in the transcript on purpose:
              a refusal is part of the record.
            </AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>That decision was not recorded</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      {pending && approvable ? (
        <CardFooter className="flex-col items-stretch gap-3 border-t pt-4">
          {canApprove ? (
            <>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  onClick={() => proposal.id && onDecide(proposal.id, 'approve')}
                  disabled={busy}
                  className="sm:min-w-44"
                >
                  {busy ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Check aria-hidden="true" />
                  )}
                  Approve this action
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => proposal.id && onDecide(proposal.id, 'reject')}
                  disabled={busy}
                >
                  <X aria-hidden="true" />
                  Reject
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                You are deciding this as {roleLabel}. Postgres checks that again before it accepts
                the decision, and records who made it.
              </p>
            </>
          ) : (
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p className="text-pretty">
                Only an organization administrator or a property manager can approve this. You are
                signed in as {roleLabel}, so there is no button here — and there would be nothing
                behind one: the database function that performs the approval checks the role itself
                and would refuse.
              </p>
            </div>
          )}
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** "Approved by Layla Hassan on 12 Nov 2026, 14:03." Degrades to the verb alone. */
function decidedLine(verb: string, who: string | null, at: string | null): string {
  const byWhom = who ? ` by ${who}` : '';
  const when = formatTimestamp(at);
  return `${verb}${byWhom}${when ? ` on ${when}` : ''}.`;
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}
