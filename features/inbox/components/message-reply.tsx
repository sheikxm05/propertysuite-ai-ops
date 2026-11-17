'use client';

/**
 * The reply surface — the screen this project is actually about.
 *
 * A tenant's message is on the page above. This component is the only thing on it that
 * can put words back on a tenant's phone, and the single claim it has to make, without
 * anybody narrating it, is:
 *
 *     the model wrote something, a person read it, and then a person sent it.
 *
 * So the gate is the layout, not a sentence under it:
 *
 *   • **Drafting and sending are two buttons, pressed in two separate acts.** `Draft a
 *     reply` is `outline`; `Send` is the primary. Completing a draft never triggers a
 *     send, never focuses the Send button and never pre-selects it. There is no code
 *     path in this file from a successful draft to a POST.
 *   • **A draft looks like a draft.** Amber chip, dashed amber frame, the word "Draft"
 *     on it, and an editable textarea rather than a rendered message. `components/ui/
 *     status.ts` publishes the rule this follows: amber means a human has not committed
 *     yet. The frame is the same amber as a pending proposal and an unverified document
 *     because it is the same claim on the same reader.
 *   • **Confidence is reported honestly.** A `low` draft carries a meter at one segment
 *     and an amber banner saying the model is guessing. A manager who learns the signal
 *     is decorative stops reading it, and then it is worse than absent.
 *   • **Clarifying questions sit beside the reply, never inside it.** They are prompts
 *     for the operator. Nothing in this component appends them to `body`.
 *   • **Once sent, it is sent.** The composer is replaced by a receipt naming who sent
 *     it and when. There is no armed Send button left on the screen, so the same words
 *     cannot go out twice by reflex.
 *
 * It decides nothing else. Whether this caller may reply, whether the sender resolved
 * to a tenant, and whether WhatsApp's 24-hour window is still open are all server
 * decisions, re-made on every request; this component renders the answers and never
 * second-guesses them. The only thing it is authoritative about is what the operator
 * typed — and that string is what `POST …/reply` receives, byte for byte.
 *
 * Authored as a client component in full, including the form fields. `FormControl`
 * clones the single child it wraps, and a child created in a Server Component arrives
 * as a lazy Flight wrapper with no `.props` — which 500'd a route in this repository
 * once already.
 */

import { useRouter } from 'next/navigation';
import * as React from 'react';
import {
  CheckCheck,
  CircleHelp,
  PencilLine,
  Send,
  Sparkles,
  TriangleAlert,
  UserX,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Form, FormControl, FormDescription, FormField, FormLabel } from '@/components/ui/form';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { cn } from '@/components/ui/utils';

import {
  REPLY_CONFIDENCE_COPY,
  REPLY_FAILURE_COPY,
  classifyReplyFailure,
  needsCloseReading,
  parseReplyDraft,
  parseReplyReceipt,
  parseReplyWindow,
  type ReplyConfidence,
  type ReplyDraft,
  type ReplyFailureKind,
  type ReplyReceipt,
  type ReplyWindow,
} from '../domain/reply';
import { formatReceivedAt } from '../domain/view';
import { describe, draftReply, failureSignal, sendReply } from './api-client';

export interface MessageReplyProps {
  readonly messageId: string;
  /**
   * Whether the inbox resolved this number to a tenant the caller may read.
   *
   * `null` means the surrounding page did not say. The control is then offered — the
   * server is the authority and refuses an unattributed reply on its own — and the
   * refusal, when it comes, is rendered as the deliberate rule it is rather than as a
   * generic failure. Passing the real value is a one-line change on the detail page and
   * is reported as a planning defect, because this component may not edit that page.
   */
  readonly senderMatched: boolean | null;
  readonly senderName: string | null;
  /** Whether this role may answer a tenant at all. The server re-checks. */
  readonly canReply: boolean;
  /** The signed-in operator, when the caller knows it. Falls back to "you". */
  readonly actorName?: string | null;
}

type Phase = 'idle' | 'drafting' | 'editing' | 'sending' | 'sent';

interface Failure {
  readonly kind: ReplyFailureKind;
  /** The server's own message plus its request id. Never paraphrased. */
  readonly detail: string;
}

export function MessageReply({
  messageId,
  senderMatched,
  senderName,
  canReply,
  actorName,
}: MessageReplyProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [phase, setPhase] = React.useState<Phase>('idle');
  const [draft, setDraft] = React.useState<ReplyDraft | null>(null);
  const [body, setBody] = React.useState('');
  const [failure, setFailure] = React.useState<Failure | null>(null);
  /**
   * `replyWindow`, not `window` — the global is a real identifier in a client component
   * and shadowing it inside a component that also calls `fetch` is a trap for whoever
   * edits this next.
   */
  const [replyWindow, setReplyWindow] = React.useState<ReplyWindow | null>(null);
  const [sent, setSent] = React.useState<{
    body: string;
    at: string;
    receipt: ReplyReceipt;
  } | null>(null);

  const drafting = phase === 'drafting';
  const sending = phase === 'sending';
  const edited = draft !== null && body !== draft.body;
  /**
   * The carrier's rule, as the draft route reported it. `null` means it did not say, and
   * that is not treated as closed: withholding a Send the server would have accepted is
   * the one error an operator has no way to work around.
   */
  const windowClosed = replyWindow !== null && !replyWindow.open;

  function recordFailure(error: unknown) {
    setFailure({ kind: classifyReplyFailure(failureSignal(error)), detail: describe(error) });
  }

  /** Asks the model for words. Creates nothing, sends nothing, arms nothing. */
  async function onDraft() {
    setPhase('drafting');
    setFailure(null);
    try {
      const payload = await draftReply(messageId);
      // The route reports the customer-service window alongside the draft, so the
      // deadline is known before the operator starts editing rather than after.
      setReplyWindow(parseReplyWindow(payload));
      const parsed = parseReplyDraft(payload);
      if (!parsed) {
        setFailure({
          kind: 'unknown',
          detail:
            'The assistant answered in a shape this screen does not recognise, so there is no draft to show. Nothing was sent.',
        });
        setPhase(draft ? 'editing' : 'idle');
        return;
      }
      setDraft(parsed);
      setBody(parsed.body);
      setPhase('editing');
    } catch (error) {
      recordFailure(error);
      setPhase(draft ? 'editing' : 'idle');
    }
  }

  /**
   * The commit. The only place in this file that posts to `…/reply`, reached only from
   * the submit button below — never from `onDraft`, and never from an effect.
   */
  async function onSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const outgoing = body.trim();
    if (outgoing === '' || sending || sent) return;

    setPhase('sending');
    setFailure(null);
    try {
      // A 2xx here means the message has left. `parseReplyReceipt` cannot fail, so an
      // unfamiliar field name can never put this screen back into a state where Send is
      // armed over something that was already sent.
      const receipt = parseReplyReceipt(await sendReply(messageId, outgoing));
      setSent({ body: outgoing, at: new Date().toISOString(), receipt });
      setPhase('sent');
      toast({
        title: 'Reply sent',
        description: 'Your words, sent by you. The assistant drafted them and committed nothing.',
        variant: 'success',
      });
      router.refresh();
    } catch (error) {
      recordFailure(error);
      setPhase('editing');
    }
  }

  function onDiscard() {
    setDraft(null);
    setBody('');
    setFailure(null);
    setPhase('idle');
  }

  const header = (
    <CardHeader>
      <div className="flex flex-wrap items-center gap-2">
        <CardTitle className="text-base">Reply to the tenant</CardTitle>
        {sent ? (
          <Badge variant="success">Sent by a human</Badge>
        ) : draft ? (
          <Badge variant="warning">Draft · nothing sent</Badge>
        ) : null}
      </div>
      <CardDescription>
        The assistant can propose the words. It cannot send them: the draft lands in the box below,
        you edit it, and the message leaves only when you press Send.
      </CardDescription>
    </CardHeader>
  );

  /* ----------------------------------------------------------- no control -- */

  if (!canReply) {
    return (
      <Card>
        {header}
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Your role can read this message but not answer it. Writing to a tenant on the
            organization&rsquo;s behalf is an operator action, and the server refuses it
            independently of this screen.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Either the page told us the sender is unattributed, or the server has since said so.
  // Both land here, and the control is gone rather than disabled-and-mysterious.
  const unattributed = senderMatched === false || failure?.kind === 'unattributed';

  if (unattributed && !sent) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-4">
          <Alert variant="warning">
            <UserX aria-hidden="true" />
            <AlertTitle>There is nobody here to reply to</AlertTitle>
            <AlertDescription>
              This number matched no tenant in your organization, so the reply has no verified
              recipient and the server will not accept one. That is the isolation boundary declining
              to guess who this is — not a fault, and not something to work around. Attribute the
              message to a tenant first, and the reply becomes possible.
            </AlertDescription>
          </Alert>
          {failure?.kind === 'unattributed' ? (
            <p className="text-xs text-muted-foreground">{failure.detail}</p>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  /* ----------------------------------------------------------------- sent -- */

  if (sent) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-4">
          <Alert variant="success">
            <CheckCheck aria-hidden="true" />
            <AlertTitle>
              Sent by {actorName ?? 'you'} at {formatReceivedAt(sent.at)}
            </AlertTitle>
            <AlertDescription>
              A person pressed Send, and these are the words that person approved
              {senderName ? `, on their way to ${senderName}` : ''}. The assistant drafted them and
              committed nothing.
            </AlertDescription>
          </Alert>

          <blockquote className="whitespace-pre-wrap rounded-md border-l-2 bg-muted/40 p-4 text-sm">
            {sent.body}
          </blockquote>

          <p className="text-xs text-muted-foreground">
            {sent.receipt.outboundMessageId
              ? `Outbound message ${sent.receipt.outboundMessageId}`
              : 'The server accepted the message without naming an id'}
            {sent.receipt.status ? ` · ${sent.receipt.status}` : ''} · there is no Send button on
            this screen any more, so the same words cannot go out twice.
          </p>
        </CardContent>
      </Card>
    );
  }

  /* ------------------------------------------------------------- composer -- */

  return (
    <Card>
      {header}
      <CardContent className="space-y-5">
        {failure ? <FailureNotice failure={failure} /> : null}

        {draft === null ? (
          <div className="space-y-3">
            <Button onClick={onDraft} disabled={drafting} variant="outline">
              <Sparkles aria-hidden="true" />
              {drafting ? 'Reading the message…' : 'Draft a reply'}
            </Button>
            <p className="text-sm text-muted-foreground">
              {senderMatched === null
                ? 'A reply is only possible to a sender the inbox could attribute to a tenant. If this message resolved to nobody, the server refuses it and nothing is sent.'
                : 'The draft arrives in an editable box. Nothing is queued, scheduled or held — until you send it, it exists only on this screen.'}
            </p>
            {drafting ? <DraftingSkeleton /> : null}
          </div>
        ) : (
          <>
            {/* Announced for anyone not watching the amber appear. */}
            <p className="sr-only" role="status">
              A draft is ready and nothing has been sent. Edit it, then press Send this reply.
            </p>

            <div
              className={cn(
                'space-y-5 rounded-lg border border-dashed border-warning/60 bg-warning/5 p-4',
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">Draft · not sent</Badge>
                {edited ? (
                  <Badge variant="outline">
                    <PencilLine className="mr-1 size-3" aria-hidden="true" />
                    Edited by you
                  </Badge>
                ) : null}
                <ConfidenceMeter confidence={draft.confidence} />
                <WindowChip replyWindow={replyWindow} />
              </div>

              {windowClosed ? <WindowClosedNotice replyWindow={replyWindow} /> : null}

              {needsCloseReading(draft.confidence) ? (
                <Alert variant="warning">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>The model is not confident in this draft</AlertTitle>
                  <AlertDescription>
                    {REPLY_CONFIDENCE_COPY[draft.confidence].meaning} Sending it unread would put
                    the organization&rsquo;s name behind a guess.
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-5 lg:grid-cols-5">
                <div className="lg:col-span-3">
                  <Form onSubmit={onSend}>
                    <FormField name="body">
                      <FormLabel required>Your reply</FormLabel>
                      <FormControl>
                        <Textarea
                          name="body"
                          required
                          rows={10}
                          maxLength={4000}
                          value={body}
                          onChange={(event) => setBody(event.target.value)}
                          disabled={sending}
                          className="bg-background"
                        />
                      </FormControl>
                      <FormDescription>
                        Pre-filled by the assistant and yours to change. What is in this box is
                        exactly what gets sent — the draft is not merged back in, and the clarifying
                        questions beside it are never appended.
                      </FormDescription>
                    </FormField>

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="submit"
                        disabled={sending || windowClosed || body.trim() === ''}
                      >
                        <Send aria-hidden="true" />
                        {sending ? 'Sending…' : 'Send this reply'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={onDraft}
                        disabled={drafting || sending}
                      >
                        <Sparkles aria-hidden="true" />
                        {drafting ? 'Drafting…' : 'Draft again'}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={onDiscard}
                        disabled={drafting || sending}
                      >
                        Discard this draft
                      </Button>
                    </div>

                    <p className="text-xs text-muted-foreground">
                      Send is the only control on this page that reaches the tenant, and it is
                      pressed by you. Drafting again replaces these words; discarding leaves the
                      message exactly as it was.
                    </p>
                  </Form>
                </div>

                <ClarifyingQuestions
                  questions={draft.clarifyingQuestions}
                  confidence={draft.confidence}
                />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------- confidence -- */

/**
 * The model's confidence, as a label and three neutral segments.
 *
 * Deliberately not coloured. `components/ui/status.ts` is the one colour table in this
 * application and it has no entry for confidence; inventing a local red-amber-green map
 * here would be the second copy of a rule that is supposed to have one (CLAUDE.md rule
 * 4), and a red chip would also read as "something is wrong" when the truthful reading
 * is "this needs you". Filled segments are `foreground`, empty ones `muted` — both
 * semantic tokens, so this renders correctly in either theme.
 */
function ConfidenceMeter({ confidence }: { confidence: ReplyConfidence }) {
  const copy = REPLY_CONFIDENCE_COPY[confidence];
  return (
    <span className="inline-flex items-center gap-2" title={copy.meaning}>
      <span className="text-xs font-medium text-muted-foreground">{copy.label}</span>
      <span className="flex gap-0.5" aria-hidden="true">
        {[1, 2, 3].map((segment) => (
          <span
            key={segment}
            className={cn(
              'h-1.5 w-4 rounded-full',
              segment <= copy.level ? 'bg-foreground/70' : 'bg-muted',
            )}
          />
        ))}
      </span>
    </span>
  );
}

/* ------------------------------------------------------- open questions -- */

/**
 * What the model could not work out from the message.
 *
 * Beside the reply rather than in it. These are questions for the operator — the model
 * asking a human to supply what it is missing, which is the opposite direction of travel
 * from a model deciding something on a human's behalf.
 */
function ClarifyingQuestions({
  questions,
  confidence,
}: {
  questions: readonly string[];
  confidence: ReplyConfidence;
}) {
  return (
    <aside className="space-y-3 rounded-md border bg-background p-4 lg:col-span-2">
      <div className="flex items-center gap-2">
        <CircleHelp className="size-4 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">Still open</p>
      </div>

      {questions.length > 0 ? (
        <>
          <p className="text-sm text-muted-foreground">
            The model could not answer these from the message. They are prompts for you — none of
            them is part of the reply.
          </p>
          <ul className="list-outside list-disc space-y-2 pl-4 text-sm">
            {questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          The model raised no outstanding questions. That is not the same as being right — the draft
          is still yours to check.
        </p>
      )}

      <Separator />

      <p className="text-xs text-muted-foreground">{REPLY_CONFIDENCE_COPY[confidence].meaning}</p>
    </aside>
  );
}

/* ---------------------------------------------------------------- failure -- */

/**
 * A refusal, explained.
 *
 * The 24-hour case is the one this exists for. WhatsApp will not carry a free-form reply
 * more than a day after the tenant last wrote; that is a rule, not an outage, and it
 * gets amber and a sentence rather than red and a stack of jargon. The server's own
 * message and request id follow underneath, every time, so the explanation never
 * replaces the evidence.
 */
function FailureNotice({ failure }: { failure: Failure }) {
  const copy = REPLY_FAILURE_COPY[failure.kind];
  return (
    <Alert variant={copy.tone}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{copy.description}</p>
        <p className="text-xs opacity-80">{failure.detail}</p>
        {copy.retryable ? null : (
          <p className="text-xs opacity-80">
            Trying again will be refused the same way, so the draft is left exactly as you have it.
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/* --------------------------------------------------------------- drafting -- */

/**
 * The wait. A model call takes seconds, and a button that goes quiet for seconds reads
 * as broken — so the shape of the thing being written appears immediately, in the amber
 * the draft itself will wear.
 */
function DraftingSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-warning/60 bg-warning/5 p-4">
      <Skeleton className="h-4 w-40" aria-label="Drafting a reply" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <p className="text-xs text-muted-foreground">
        The assistant is reading the message. Nothing is being sent while this runs — there is no
        code path from a finished draft to a message.
      </p>
    </div>
  );
}
