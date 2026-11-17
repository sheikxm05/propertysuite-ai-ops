'use client';

/**
 * The assistant surface: ask, watch what it did, decide what it may do.
 *
 * WHAT THIS COMPONENT IS RESPONSIBLE FOR
 * --------------------------------------
 * Ordering and state, and nothing else. It holds the transcript and one decision map,
 * and hands everything visual to `ToolTrace` and `ProposalCard`, which carry their own
 * reasoning. The security content of this file is what it *refuses* to do.
 *
 * EACH TURN IS INDEPENDENT, AND THAT IS THE SERVER'S CHOICE
 * ---------------------------------------------------------
 * `AgentRunRequestSchema` is `.strict()` with exactly one field: `message`. There is no
 * `conversation_id`, because "a client-supplied history would be a client-supplied
 * prompt" — a browser that could replay prior turns could also fabricate them, and the
 * model's context is not a thing the client is allowed to author. So this transcript is
 * a record of what happened on this screen, not a session the server is reading back.
 * Saying that out loud under the composer is better than letting a reader assume memory
 * that does not exist.
 *
 * THE STATE RULE: THE SERVER'S ANSWER WINS
 * ----------------------------------------
 * Clicking Approve does not set a status locally and then call the endpoint. It calls
 * the endpoint, and only the endpoint's own confirmation — `{ proposal_id, status,
 * executed }` — moves the card. On a screen whose entire job is to be an honest account
 * of what the system did, an optimistic "Approved" that the server had in fact refused
 * is the one bug that would discredit the whole surface.
 *
 * Decisions are tracked in a map keyed by proposal id, separate from the proposals
 * themselves, because the two have different authors: a proposal is what the model
 * produced (and the run schema types its status as the literal `'pending'`, since the
 * run endpoint cannot produce any other), while a decision is what a human did.
 *
 * WHAT IS NOT HERE
 * ----------------
 * No role check that decides anything. `canApprove` arrives as a prop resolved on the
 * server from trusted membership rows and controls only whether a button is drawn. Forced
 * true in a debugger it changes nothing: the route gates on `STAFF_ROLES` and the RPC
 * re-checks `is_org_staff()`. That is the property that makes it safe to branch on a role
 * in a browser at all.
 */

import * as React from 'react';
import { Bot, Loader2, MessageSquare, SendHorizontal, ShieldCheck, User } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { cn } from '@/components/ui/utils';
import { AiMessageContentSchema } from '@shared/index';

import { AgentRequestError, decideProposal, runAgent, type AgentDecision } from '../transport';
import { STOP_REASON_TEXT, type AgentRunData, type ProposalDecision } from '../wire';
import { ProposalCard } from './proposal-card';
import { ToolTrace } from './tool-trace';

/** The same bound the API applies, read off the shared schema rather than retyped. */
const MESSAGE_MAX_LENGTH = AiMessageContentSchema.maxLength ?? 4000;

export interface AssistantConsoleProps {
  /** Staff, resolved server-side. Presentation only — see the header. */
  readonly canApprove: boolean;
  /** The caller's role in words, e.g. "a property manager". */
  readonly roleLabel: string;
  /** The caller's own name, shown against decisions they take. */
  readonly displayName: string | null;
  /** One-click questions, so the first turn of a demo is not a typing exercise. */
  readonly starters: readonly string[];
}

interface Decision {
  readonly status: ProposalDecision;
  readonly at: string;
}

type Entry =
  | { readonly kind: 'ask'; readonly id: string; readonly text: string }
  | { readonly kind: 'answer'; readonly id: string; readonly run: AgentRunData }
  | {
      readonly kind: 'failure';
      readonly id: string;
      readonly text: string;
      readonly requestId: string | null;
    };

export function AssistantConsole({
  canApprove,
  roleLabel,
  displayName,
  starters,
}: AssistantConsoleProps) {
  const [entries, setEntries] = React.useState<readonly Entry[]>([]);
  const [decisions, setDecisions] = React.useState<Readonly<Record<string, Decision>>>({});
  const [draft, setDraft] = React.useState('');
  const [thinking, setThinking] = React.useState(false);
  const [deciding, setDeciding] = React.useState<string | null>(null);
  const [decisionErrors, setDecisionErrors] = React.useState<Readonly<Record<string, string>>>({});

  const sequence = React.useRef(0);
  const bottom = React.useRef<HTMLDivElement | null>(null);
  const composerId = React.useId();

  const nextId = React.useCallback((prefix: string) => {
    sequence.current += 1;
    return `${prefix}-${sequence.current}`;
  }, []);

  React.useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries.length, thinking]);

  /** Every proposal this session has seen that no human has yet decided. */
  const pendingCount = React.useMemo(() => {
    let count = 0;
    for (const entry of entries) {
      if (entry.kind !== 'answer') continue;
      for (const proposal of entry.run.proposals) {
        if (proposal.id && !decisions[proposal.id]) count += 1;
      }
    }
    return count;
  }, [entries, decisions]);

  const canSend = AiMessageContentSchema.safeParse(draft.trim()).success && !thinking;

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!AiMessageContentSchema.safeParse(message).success) return;

      setDraft('');
      setThinking(true);
      setEntries((previous) => [...previous, { kind: 'ask', id: nextId('ask'), text: message }]);

      try {
        const run = await runAgent(message);
        setEntries((previous) => [...previous, { kind: 'answer', id: nextId('answer'), run }]);
      } catch (thrown) {
        setEntries((previous) => [
          ...previous,
          {
            kind: 'failure',
            id: nextId('failure'),
            text: readMessage(thrown),
            requestId: thrown instanceof AgentRequestError ? thrown.requestId : null,
          },
        ]);
      } finally {
        setThinking(false);
      }
    },
    [nextId],
  );

  const decide = React.useCallback(async (proposalId: string, decision: AgentDecision) => {
    setDeciding(proposalId);
    setDecisionErrors((previous) => {
      const next = { ...previous };
      delete next[proposalId];
      return next;
    });

    try {
      const outcome = await decideProposal(proposalId, decision);
      setDecisions((previous) => ({
        ...previous,
        [outcome.proposalId]: { status: outcome.status, at: new Date().toISOString() },
      }));
      toast(
        outcome.status === 'approved'
          ? {
              variant: 'success',
              title: 'Approved',
              description: 'Your decision is recorded and written to the audit trail.',
            }
          : {
              variant: 'default',
              title: 'Rejected',
              description: 'Nothing was created. The proposal stays in the transcript.',
            },
      );
    } catch (thrown) {
      setDecisionErrors((previous) => ({ ...previous, [proposalId]: readMessage(thrown) }));
    } finally {
      setDeciding(null);
    }
  }, []);

  function reset() {
    setEntries([]);
    setDecisions({});
    setDecisionErrors({});
    setDraft('');
  }

  return (
    <div className="space-y-4">
      {pendingCount > 0 ? (
        <Alert variant="warning">
          <ShieldCheck aria-hidden="true" />
          <AlertTitle>
            {pendingCount === 1
              ? 'One action is waiting for a human decision.'
              : `${pendingCount} actions are waiting for a human decision.`}
          </AlertTitle>
          <AlertDescription>
            Nothing has been created, assigned or changed. The assistant can read this
            organization&rsquo;s records and can draft an action, and that is where it stops.
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        className="space-y-6"
        role="log"
        aria-live="polite"
        aria-label="Conversation with the assistant"
      >
        {entries.length === 0 && !thinking ? (
          <EmptyState
            icon={Bot}
            title="Ask the assistant about this organization"
            description="It can look up units, tenancies, recent tickets, providers and documents on its own. Anything that would change a record stops and waits for you to approve it."
            action={
              starters.length > 0 ? (
                <div className="flex flex-col flex-wrap items-stretch gap-2 sm:flex-row sm:justify-center">
                  {starters.map((starter) => (
                    <Button
                      key={starter}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto whitespace-normal py-2 text-left"
                      onClick={() => void send(starter)}
                    >
                      {starter}
                    </Button>
                  ))}
                </div>
              ) : null
            }
          />
        ) : null}

        {entries.map((entry) => (
          <TranscriptEntry
            key={entry.id}
            entry={entry}
            decisions={decisions}
            canApprove={canApprove}
            roleLabel={roleLabel}
            displayName={displayName}
            deciding={deciding}
            decisionErrors={decisionErrors}
            onDecide={(id, decision) => void decide(id, decision)}
          />
        ))}

        {thinking ? (
          <Turn icon={Bot} who="Assistant" tone="assistant">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Reading the records…
            </p>
          </Turn>
        ) : null}

        <div ref={bottom} />
      </div>

      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor={composerId} className="sr-only">
          Message the assistant
        </label>
        <Textarea
          id={composerId}
          value={draft}
          rows={3}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder="What is going on with unit 1204?"
          disabled={thinking}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter writes a new line — the convention every chat
            // surface a property manager already uses. The button stays for touch and for
            // anyone who does not know the shortcut.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {draft.length}/{MESSAGE_MAX_LENGTH} · Each question is answered on its own — the server
            accepts no conversation history from the browser, because a client-supplied history is a
            client-supplied prompt.
          </p>
          <div className="flex items-center gap-2">
            {entries.length > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={thinking}>
                Clear the transcript
              </Button>
            ) : null}
            <Button type="submit" disabled={!canSend}>
              {thinking ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <SendHorizontal aria-hidden="true" />
              )}
              Send
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------- turns -- */

function TranscriptEntry({
  entry,
  decisions,
  canApprove,
  roleLabel,
  displayName,
  deciding,
  decisionErrors,
  onDecide,
}: {
  entry: Entry;
  decisions: Readonly<Record<string, Decision>>;
  canApprove: boolean;
  roleLabel: string;
  displayName: string | null;
  deciding: string | null;
  decisionErrors: Readonly<Record<string, string>>;
  onDecide: (proposalId: string, decision: AgentDecision) => void;
}) {
  if (entry.kind === 'ask') {
    return (
      <Turn icon={User} who="You" tone="user">
        <p className="whitespace-pre-wrap text-pretty text-sm">{entry.text}</p>
      </Turn>
    );
  }

  if (entry.kind === 'failure') {
    return (
      <Turn icon={Bot} who="Assistant" tone="assistant">
        <Alert variant="destructive">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>
            {entry.text}
            {entry.requestId ? (
              <span className="mt-1 block font-mono text-xs">reference {entry.requestId}</span>
            ) : null}
          </AlertDescription>
        </Alert>
      </Turn>
    );
  }

  const { run } = entry;

  return (
    <Turn icon={Bot} who="Assistant" tone="assistant">
      <div className="space-y-4">
        <ToolTrace steps={run.steps} />

        {run.summary && run.summary.trim().length > 0 ? (
          <p className="whitespace-pre-wrap text-pretty text-sm leading-relaxed">{run.summary}</p>
        ) : (
          <p className="text-sm text-muted-foreground">
            The assistant produced no summary for this question.
          </p>
        )}

        {run.stop_reason !== 'completed' ? (
          <Alert variant="warning">
            <AlertTitle>The run was cut short</AlertTitle>
            <AlertDescription>{STOP_REASON_TEXT[run.stop_reason]}</AlertDescription>
          </Alert>
        ) : null}

        {!run.persisted && run.proposals.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>This run was not stored</AlertTitle>
            <AlertDescription>
              The proposals below could not be written, so there is no row for a human decision to
              attach to and none of them can be approved.
            </AlertDescription>
          </Alert>
        ) : null}

        {run.proposals.map((proposal, index) => (
          <ProposalCard
            key={proposal.id ?? `${entry.id}-unstored-${index}`}
            proposal={proposal}
            decision={decisionFor(proposal, decisions)}
            decidedAt={proposal.id ? (decisions[proposal.id]?.at ?? null) : null}
            decidedBy={proposal.id && decisions[proposal.id] ? displayName : null}
            canApprove={canApprove}
            roleLabel={roleLabel}
            busy={deciding === proposal.id}
            error={proposal.id ? (decisionErrors[proposal.id] ?? null) : null}
            onDecide={onDecide}
          />
        ))}

        <RunFooter run={run} />
      </div>
    </Turn>
  );
}

/**
 * The provenance line: which model, which prompt version, how many rounds.
 *
 * Small and grey on purpose — it is not the story, but a reviewer asking "which model
 * said that, and under which prompt" should not have to open a log to find out.
 */
function RunFooter({ run }: { run: AgentRunData }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>
        {run.rounds} {run.rounds === 1 ? 'round' : 'rounds'}
      </span>
      <span aria-hidden="true">·</span>
      <code className="rounded bg-muted px-1 py-0.5">{run.model}</code>
      <span aria-hidden="true">·</span>
      <span>prompt {run.prompt_version}</span>
      <span aria-hidden="true">·</span>
      <Badge variant="secondary" className="font-normal">
        executed: false
      </Badge>
    </p>
  );
}

/**
 * One turn: an avatar, a speaker label and a body.
 *
 * The avatar column disappears below `sm` rather than squeezing the body, which is what
 * keeps an approval card readable on a phone — and a reviewer may well open this on one.
 */
function Turn({
  icon: Icon,
  who,
  tone,
  children,
}: {
  icon: typeof Bot;
  who: string;
  tone: 'user' | 'assistant';
  children: React.ReactNode;
}) {
  return (
    <article className="flex gap-3">
      <span
        aria-hidden="true"
        className={cn(
          'hidden size-8 shrink-0 items-center justify-center rounded-full border sm:flex',
          tone === 'assistant' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {who}
          </h2>
          {tone === 'assistant' ? (
            <Badge variant="outline" className="gap-1 font-normal">
              <MessageSquare className="size-3" aria-hidden="true" />
              AI
            </Badge>
          ) : null}
        </div>
        {children}
      </div>
    </article>
  );
}

function decisionFor(
  proposal: { id: string | null },
  decisions: Readonly<Record<string, Decision>>,
): ProposalDecision {
  if (!proposal.id) return 'pending';
  return decisions[proposal.id]?.status ?? 'pending';
}

function readMessage(thrown: unknown): string {
  return thrown instanceof Error && thrown.message
    ? thrown.message
    : 'Something went wrong. Nothing was changed.';
}
