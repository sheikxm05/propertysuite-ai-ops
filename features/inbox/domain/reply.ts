/**
 * The reply contract, and the rules for reading what comes back from it.
 *
 * Two endpoints, frozen by the orchestrator while they were still being written:
 *
 *   POST /api/v1/inbox/messages/{id}/reply/draft  → 200 { draft: ReplyDraft }
 *   POST /api/v1/inbox/messages/{id}/reply        → 202 { outboundMessageId, status }
 *
 * Everything in this file is pure: no React, no Supabase, no `lib/env`. It is imported
 * directly by a client component rather than through `domain/index.ts`, for the reason
 * that barrel states — it pulls server configuration in behind it, and this module must
 * not. Nothing here reads or writes; it describes a shape and reads a response.
 *
 * THREE DECISIONS LIVE HERE RATHER THAN IN THE COMPONENT
 * -----------------------------------------------------
 * 1. **The shapes are read tolerantly, and the send is read optimistically.** The two
 *    routes are being written in another lane right now, and the frozen shapes are
 *    `{ draft }` / `{ outboundMessageId }` while every other route in this application
 *    answers `{ data: … }` in snake_case. Both readings are accepted (see
 *    `parseReplyDraft`), and — far more important — `parseReplyReceipt` never fails. A
 *    `202` means the message is gone. A component that treated an unrecognised field
 *    name as a failed send would re-arm the Send button over a message that had already
 *    left, and the operator would send it twice. Parsing is allowed to be unsure about
 *    an id; it is not allowed to be unsure about whether something was sent.
 *
 * 2. **A failure is classified, not printed.** WhatsApp refuses a free-form reply more
 *    than 24 hours after the tenant's last message. That is not a bug, a permission
 *    problem or an outage — it is the carrier's rule, and rendering it as a red
 *    "something went wrong" teaches the operator to distrust the screen. The 24-hour
 *    case, an unattributed sender and a genuine refusal are three different sentences.
 *
 * 3. **Confidence carries copy, not colour.** `components/ui/status.ts` is the single
 *    colour table for this application and it has no entry for a model's confidence —
 *    reported as a planning defect rather than worked around with a second, local
 *    colour map (CLAUDE.md rule 4). So this file supplies the label, a 1–3 level for a
 *    neutral meter, and the sentence a manager should read; the component renders the
 *    meter in `foreground`/`muted` and nothing else. The draft's amber comes from the
 *    one rule that *is* published: amber means a human has not committed yet.
 */

/* ------------------------------------------------------------------ shapes -- */

export type ReplyConfidence = 'low' | 'medium' | 'high';

const REPLY_CONFIDENCES = ['low', 'medium', 'high'] as const;

/**
 * What the model proposes saying. Frozen by the orchestrator.
 *
 * Declared here because the service that produces it does not exist on disk yet. When
 * `services/ai/reply/*` lands with its own Zod schema, this interface should become an
 * `import type` from it — the same move `components/api-client.ts` already makes for
 * `AgentRunData` — so that there is one definition and it cannot drift.
 */
export interface ReplyDraft {
  readonly body: string;
  /** Questions for the *operator*. Never appended to the reply. */
  readonly clarifyingQuestions: readonly string[];
  readonly confidence: ReplyConfidence;
}

/** The `202` body. Both fields are decoration: the acceptance is the HTTP status. */
export interface ReplyReceipt {
  readonly outboundMessageId: string | null;
  readonly status: string | null;
}

/**
 * Meta's customer-service window, as the draft route reports it alongside the draft.
 *
 * Knowing this *before* the operator writes is the point. WhatsApp carries a free-form
 * reply only within 24 hours of the tenant's last message, and discovering that after
 * composing one is a worse experience than being told while reading the draft. The
 * server is still the authority — it recomputes the window on the send and refuses
 * independently of anything this screen believes.
 */
export interface ReplyWindow {
  readonly open: boolean;
  readonly closesAt: string | null;
  readonly lastInboundAt: string | null;
  readonly windowHours: number | null;
}

export function isReplyConfidence(value: unknown): value is ReplyConfidence {
  return typeof value === 'string' && (REPLY_CONFIDENCES as readonly string[]).includes(value);
}

/* ----------------------------------------------------------------- parsing -- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Non-empty strings only. A blank clarifying question is a prompt for nobody. */
function asQuestions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Every object the draft could plausibly be, in the order it is most likely to be it:
 * `{ draft }` (frozen), `{ data: { draft } }` (this application's house envelope),
 * `{ data }` and the body itself.
 */
function draftCandidates(payload: unknown): readonly Record<string, unknown>[] {
  const top = asRecord(payload);
  if (!top) return [];

  const data = asRecord(top.data);
  const found: Record<string, unknown>[] = [];

  const topDraft = asRecord(top.draft);
  if (topDraft) found.push(topDraft);
  if (data) {
    const nestedDraft = asRecord(data.draft);
    if (nestedDraft) found.push(nestedDraft);
    found.push(data);
  }
  found.push(top);
  return found;
}

/**
 * Reads a draft, or `null` when the body does not contain one.
 *
 * An unknown or missing `confidence` becomes `low`. That is the conservative direction:
 * a draft whose confidence could not be read is one nobody has vouched for, and the UI
 * should push the operator to read it closely rather than quietly imply it is fine.
 */
export function parseReplyDraft(payload: unknown): ReplyDraft | null {
  for (const candidate of draftCandidates(payload)) {
    const body = typeof candidate.body === 'string' ? candidate.body : null;
    if (body === null) continue;

    const questions = candidate.clarifyingQuestions ?? candidate.clarifying_questions;
    return {
      body,
      clarifyingQuestions: asQuestions(questions),
      confidence: isReplyConfidence(candidate.confidence) ? candidate.confidence : 'low',
    };
  }
  return null;
}

/**
 * Reads the receipt. Never fails — see the note at the top of this file.
 *
 * `null` in either field means "the server did not tell us", which the screen says in
 * those words. It never means "this may not have been sent".
 */
export function parseReplyReceipt(payload: unknown): ReplyReceipt {
  const top = asRecord(payload);
  const source = (top ? (asRecord(top.data) ?? top) : null) ?? {};

  return {
    outboundMessageId:
      asText(source.outboundMessageId) ??
      asText(source.outbound_message_id) ??
      asText(source.id) ??
      null,
    status: asText(source.status) ?? null,
  };
}

/**
 * Reads the window the draft route reported, or `null` when it reported none.
 *
 * `null` is not "closed". A screen that inferred a closed window from a missing field
 * would withhold a Send the server would have accepted, which is the one direction of
 * error an operator cannot work around.
 */
export function parseReplyWindow(payload: unknown): ReplyWindow | null {
  const top = asRecord(payload);
  if (!top) return null;

  const window = asRecord(top.window) ?? asRecord(asRecord(top.data)?.window);
  if (!window || typeof window.open !== 'boolean') return null;

  return {
    open: window.open,
    closesAt: asText(window.closesAt) ?? asText(window.closes_at),
    lastInboundAt: asText(window.lastInboundAt) ?? asText(window.last_inbound_at),
    windowHours:
      typeof window.windowHours === 'number'
        ? window.windowHours
        : typeof window.window_hours === 'number'
          ? window.window_hours
          : null,
  };
}

/* ---------------------------------------------------------------- failures -- */

/**
 * Why a draft or a send did not happen, in the vocabulary the operator needs — not the
 * vocabulary of the transport.
 */
export type ReplyFailureKind =
  'route_absent' | 'outside_window' | 'unattributed' | 'rate_limited' | 'refused' | 'unknown';

/** What the browser knows about a failed call: the frozen envelope plus the status. */
export interface ReplyFailureSignal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/**
 * WhatsApp's customer-service window, however the lane that writes the route phrases it.
 * Matched on the server's own message rather than on a code, because the frozen eight
 * codes (§5.2) have no member that means "the carrier's rule says no" — `UNPROCESSABLE`
 * and `CONFLICT` are both defensible and the route may use either.
 */
const OUTSIDE_WINDOW =
  /24[\s-]?hour|\b24h\b|customer[\s-]service window|messaging window|service window|window (has )?(closed|expired|elapsed)|outside the (reply |messaging )?window|session (has )?(closed|expired)/i;

/**
 * An unattributed sender, however the route phrases it.
 *
 * `reply-guards.ts` currently raises two of these — "not attributed to a tenant" and
 * "does not match exactly one tenant" — and both are `UNPROCESSABLE`, the same code the
 * closed window uses. The code alone therefore cannot tell them apart, which is why
 * these patterns exist at all. A phrasing nobody anticipated falls through to `refused`
 * and the server's own sentence is shown verbatim, so an unmatched pattern degrades to
 * "less explanation", never to a wrong explanation.
 */
const UNATTRIBUTED =
  /unmatched|unattributed|not attributed|cannot be attributed|no tenant|match the sender|does not match exactly one tenant|unknown sender|no recipient/i;

export function classifyReplyFailure(signal: ReplyFailureSignal | null): ReplyFailureKind {
  if (!signal) return 'unknown';

  // `INBOX_API_ERROR`'s default code when there was no frozen envelope at all: Next's
  // own 404/405 for a route this build does not have. A real `NOT_FOUND` carries the
  // envelope and the code, so the two do not collide.
  if ((signal.status === 404 || signal.status === 405) && signal.code === 'INTERNAL_ERROR') {
    return 'route_absent';
  }

  if (OUTSIDE_WINDOW.test(signal.message)) return 'outside_window';
  if (UNATTRIBUTED.test(signal.message)) return 'unattributed';
  if (signal.code === 'RATE_LIMITED') return 'rate_limited';
  if (signal.code === 'FORBIDDEN' || signal.code === 'UNAUTHENTICATED') return 'refused';
  if (signal.code === 'UNPROCESSABLE' || signal.code === 'CONFLICT') return 'refused';
  return 'unknown';
}

export interface ReplyFailureCopy {
  readonly title: string;
  readonly description: string;
  /**
   * `warning` and `destructive` as `components/ui/status.ts` defines them: amber is an
   * outstanding human decision — nothing broke, somebody has to choose what to do next
   * — and red is something demanding attention now. The carrier's window closing is
   * amber. A refusal is red because a boundary said no and that is worth looking at.
   */
  readonly tone: 'warning' | 'destructive';
  /** Whether trying the same call again could plausibly succeed. */
  readonly retryable: boolean;
}

export const REPLY_FAILURE_COPY: Readonly<Record<ReplyFailureKind, ReplyFailureCopy>> =
  Object.freeze({
    route_absent: {
      title: 'The reply endpoint is not deployed in this build',
      description:
        'The route answered with the framework’s own 404 rather than this application’s error envelope, which means it does not exist here yet. Nothing was drafted, nothing was sent, and nothing about this message changed.',
      tone: 'warning',
      retryable: true,
    },
    outside_window: {
      title: 'WhatsApp’s 24-hour window has closed',
      description:
        'WhatsApp only carries a free-form reply within 24 hours of the tenant’s last message. That window has passed, so the send was refused before anything left this system. Your draft is still here: the tenant writing again reopens the window, and until then this has to go out another way.',
      tone: 'warning',
      retryable: false,
    },
    unattributed: {
      title: 'There is no verified recipient for this message',
      description:
        'The sender’s number matched no tenant in your organization, so there is no one this reply could be addressed to. The server refuses rather than guessing a recipient — which is the isolation boundary doing its job, not a fault.',
      tone: 'warning',
      retryable: false,
    },
    rate_limited: {
      title: 'Too many requests, too quickly',
      description:
        'The rate limiter turned this one away. Nothing was sent. Wait a moment and ask again.',
      tone: 'warning',
      retryable: true,
    },
    refused: {
      title: 'The server refused this reply',
      description:
        'The request reached the server and the server declined it. Nothing was sent. The server’s own words are below — this screen does not paraphrase them.',
      tone: 'destructive',
      retryable: false,
    },
    unknown: {
      title: 'The reply was not sent',
      description:
        'The request did not complete. Nothing left this system, and your draft is untouched.',
      tone: 'destructive',
      retryable: true,
    },
  });

/* -------------------------------------------------------------- confidence -- */

export interface ReplyConfidenceCopy {
  readonly label: string;
  /** 1–3, rendered as a neutral meter. Deliberately not a colour — see the file note. */
  readonly level: 1 | 2 | 3;
  /** What the signal should make the reader *do*. A decorative signal gets ignored. */
  readonly meaning: string;
}

export const REPLY_CONFIDENCE_COPY: Readonly<Record<ReplyConfidence, ReplyConfidenceCopy>> =
  Object.freeze({
    low: {
      label: 'Low confidence',
      level: 1,
      meaning:
        'The model is guessing. It could not find enough in the message to answer safely, so treat this as a starting point and expect to rewrite most of it.',
    },
    medium: {
      label: 'Medium confidence',
      level: 2,
      meaning:
        'The model had most of what it needed. Check the specifics — names, dates, amounts, anything you would be held to — before this goes out.',
    },
    high: {
      label: 'High confidence',
      level: 3,
      meaning:
        'The model had what it needed to answer. It still has not sent anything and cannot: the words below only leave this screen when you press Send.',
    },
  });

/** Whether the draft should carry a visible "read this closely" warning. */
export function needsCloseReading(confidence: ReplyConfidence): boolean {
  return confidence === 'low';
}
