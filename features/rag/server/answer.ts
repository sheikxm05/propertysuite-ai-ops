/**
 * Answer composition — fence, send, validate, map indices back to rows.
 *
 * THE SHAPE OF THE USER TURN, AND WHY IT IS BUILT HERE AND NOT CONCATENATED
 * ------------------------------------------------------------------------
 * One user-role message, assembled in a single pass:
 *
 *     <trusted preamble>
 *     [APPLICATION-CONTEXT] … [/APPLICATION-CONTEXT]      ← counts and enums only
 *     [SOURCE 1]
 *     [UNTRUSTED-DATA-BEGIN <nonce>] … [UNTRUSTED-DATA-END <nonce>]
 *     [SOURCE 2]
 *     [UNTRUSTED-DATA-BEGIN <nonce>] … [UNTRUSTED-DATA-END <nonce>]
 *     [QUESTION]
 *     [UNTRUSTED-DATA-BEGIN <nonce>] … [UNTRUSTED-DATA-END <nonce>]
 *
 * Retrieved text never touches the system role. The system role is
 * `RAG_ANSWER_SYSTEM`, a frozen constant with no template parameter — the same property
 * `tests/ai/prompt-isolation.test.ts` pins for the classification path.
 *
 * The `[SOURCE n]` labels sit outside the fences, which is the only place they can be
 * trusted, and they are the application's own counter rather than anything derived from
 * a document. A chunk cannot forge one: `fenceUntrusted` neutralises the begin marker,
 * the end marker and the nonce inside the content it wraps, so hostile text cannot close
 * its own fence to emit a `[SOURCE 3]` line that the model would read as framing. It can
 * of course contain the literal characters `[SOURCE 3]` *inside* its fence, which is why
 * the system prompt says in as many words that a source line inside a fence is document
 * text. The blast radius if a model believes it anyway is one wrong number pointing at
 * another chunk from the same result set — every one of which the caller was already
 * authorized to read.
 *
 * The question is fenced too, under `tenant_message`. It is typed by a human, so it is
 * exactly as untrusted as a maintenance message, and it goes through the same fence
 * rather than being appended as framing.
 *
 * WHY THE MODEL REPLY SCHEMA IS NOT `.strict()`
 * ---------------------------------------------
 * Every response schema in `packages/shared` is strict, and `DocumentExtractionSchema`
 * being strict is load-bearing: its fields are stored and later acted on, so an
 * unexpected key is a reason to disbelieve the whole reply.
 *
 * This object is different in kind. Nothing in it is stored, nothing in it is acted on,
 * and `sources` is thrown away and rebuilt from server-side rows. `answer` is prose that
 * a person reads with the evidence beside it. An extra key is therefore inert, and
 * rejecting the reply over one would convert a cosmetic slip by a small, fast model into
 * "no answer at all" — trading the feature's usefulness for a guarantee it does not need.
 * Unknown keys are dropped. What is *not* relaxed is the content: `answer` must be
 * non-empty prose within bounds, and an unparseable reply is still refused after one
 * retry.
 *
 * No chunk text, no question text and no model prose is logged here (CLAUDE.md rule 8).
 */

import { z } from 'zod';

import { ApiRouteError } from '@/lib/api/errors';
import { evaluateWith, fenceUntrusted, newFenceNonce, type FencedSectionInfo } from '@/services/ai';
import type { ModelCallReply, ModelCallRequest } from '@/services/ai/providers/transport';

import { RAG_NO_ANSWER_TEXT, type RagCitation } from '../contract';
import { RAG_ANSWER_PROMPT } from '../prompt';
import { toExcerpt, type RetrievedChunk } from './retrieval';
import type { ModelTransport } from './ports';

/** One retry, two attempts. Same rule and same reason as `services/ai`: a loop is a bill. */
const MAX_ATTEMPTS = 2;

/** Bounds the rejected reply before it is fenced back into the retry turn. */
const MAX_REJECTED_REPLY_CHARS = 2000;

/* ------------------------------------------------------------ model reply -- */

/**
 * What the model is allowed to say.
 *
 * `sources` is `unknown[]` on purpose rather than `number[]`. Small models return
 * `["1","3"]` about as often as `[1,3]`, and a schema that rejected the string form
 * would discard a perfectly good answer over a JSON type. Coercion happens in
 * `readOrdinals`, which also drops anything that is not a source that was actually
 * supplied — so permissiveness here costs nothing: an unusable entry becomes no citation
 * rather than a wrong one.
 */
const ModelAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(4000),
  /** Optional: absence is read as "cited nothing", which is handled identically. */
  answered: z.boolean().optional(),
  sources: z.array(z.unknown()).max(32).optional(),
});

type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

/** Reads the model's source numbers, keeping only ones that name a supplied source. */
function readOrdinals(raw: readonly unknown[] | undefined, available: number): number[] {
  if (!raw) return [];
  const seen = new Set<number>();
  const ordinals: number[] = [];

  for (const entry of raw) {
    const value =
      typeof entry === 'number'
        ? entry
        : typeof entry === 'string'
          ? Number.parseInt(entry.trim(), 10)
          : Number.NaN;

    if (!Number.isFinite(value)) continue;
    const ordinal = Math.trunc(value);
    // Out of range means the model named a source that was never supplied. Dropped
    // silently: there is no row to point at, so there is no citation to make.
    if (ordinal < 1 || ordinal > available) continue;
    if (seen.has(ordinal)) continue;
    seen.add(ordinal);
    ordinals.push(ordinal);
  }

  return ordinals;
}

/* ---------------------------------------------------------------- request -- */

/** Scope framing. Enums and counts only — nothing here can carry document text. */
function renderContext(sourceCount: number, scopedToOneDocument: boolean): string {
  return [
    '[APPLICATION-CONTEXT]',
    `source_count: ${sourceCount}`,
    `question_scope: ${scopedToOneDocument ? 'single_document' : 'all_documents'}`,
    '[/APPLICATION-CONTEXT]',
  ].join('\n');
}

interface BuiltTurn {
  readonly text: string;
  readonly nonce: string;
  readonly fenced: readonly FencedSectionInfo[];
}

function buildUserTurn(
  question: string,
  chunks: readonly RetrievedChunk[],
  scopedToOneDocument: boolean,
): BuiltTurn {
  const nonce = newFenceNonce();
  const fenced: FencedSectionInfo[] = [];
  const parts: string[] = [
    RAG_ANSWER_PROMPT.userPreamble,
    '',
    renderContext(chunks.length, scopedToOneDocument),
  ];

  for (const chunk of chunks) {
    const block = fenceUntrusted([{ label: 'document_text', content: chunk.content }], nonce);
    fenced.push(...block.sections);
    parts.push('', `[SOURCE ${chunk.ordinal}]`, block.text);
  }

  const askBlock = fenceUntrusted([{ label: 'tenant_message', content: question }], nonce);
  fenced.push(...askBlock.sections);
  parts.push('', '[QUESTION]', askBlock.text);

  return { text: parts.join('\n'), nonce, fenced };
}

/* ----------------------------------------------------------------- output -- */

export interface ComposedAnswer {
  /** Prose for the reader, or `RAG_NO_ANSWER_TEXT` when nothing could be cited. */
  readonly answer: string;
  /** Server-built, one per source the model used. Empty implies the refusal text. */
  readonly citations: readonly RagCitation[];
  /** False when the model declined or cited nothing. Drives the log line, not the body. */
  readonly answered: boolean;
  readonly promptVersion: string;
  readonly model: string;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** Lengths and flags for the fenced sections. Safe to log; carries no content. */
  readonly fenced: readonly FencedSectionInfo[];
  /** How many marker-shaped substrings the fence neutralised across all sections. */
  readonly neutralisedMarkers: number;
}

export interface ComposeAnswerInput {
  readonly question: string;
  readonly chunks: readonly RetrievedChunk[];
  readonly scopedToOneDocument: boolean;
}

export interface ComposeAnswerDeps {
  readonly transport: ModelTransport;
  /** Resolved chat model id. Comes from `AI_MODEL`; never named at a call site. */
  readonly model: string;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Asks the model to answer from the retrieved chunks, then rebuilds the citations.
 *
 * Caller contract: `chunks` must be non-empty. The zero-result case never reaches a
 * model — `askDocuments` returns the refusal without spending a call, because there is
 * nothing a model could add to "no document in your organization mentions this".
 */
export async function composeAnswer(
  input: ComposeAnswerInput,
  deps: ComposeAnswerDeps,
): Promise<ComposedAnswer> {
  const turn = buildUserTurn(input.question, input.chunks, input.scopedToOneDocument);
  const userTurns: string[] = [turn.text];
  const fenced: FencedSectionInfo[] = [...turn.fenced];

  const startedAt = Date.now();
  let lastRejection = 'empty';
  let lastReply: ModelCallReply | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const request: ModelCallRequest = {
      model: deps.model,
      system: RAG_ANSWER_PROMPT.system,
      userTurns,
      maxOutputTokens: RAG_ANSWER_PROMPT.maxOutputTokens,
    };

    const reply = await deps.transport.send(request, deps.signal);
    lastReply = reply;

    // `evaluateWith` is `services/ai`'s own reply reader: it refuses a `max_tokens`
    // truncation before parsing, bounds the reply, strips a stray markdown fence and
    // then applies the schema. Reused rather than reimplemented so this lane cannot
    // drift from the rules the classification path is tested against.
    const verdict = evaluateWith<ModelAnswer>(reply.text, reply.stopReason, (value) => {
      const result = ModelAnswerSchema.safeParse(value);
      return result.success ? { ok: true, value: result.data } : { ok: false, cause: result.error };
    });

    if (verdict.ok) {
      return finalise(verdict.value, input.chunks, {
        reply,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
        fenced,
      });
    }

    lastRejection = verdict.rejection;

    if (attempt < MAX_ATTEMPTS) {
      // The rejected reply is model output, so it is untrusted and goes back through the
      // same fence under its own label — the error path is not a hole in the fence.
      const retry = fenceUntrusted(
        [
          {
            label: 'previous_invalid_model_output',
            content: (reply.text ?? '').trim().slice(0, MAX_REJECTED_REPLY_CHARS),
          },
        ],
        turn.nonce,
      );
      fenced.push(...retry.sections);
      userTurns.push([RAG_ANSWER_PROMPT.retryInstruction, '', retry.text].join('\n'));
    }
  }

  throw new ApiRouteError('UNPROCESSABLE', {
    message:
      'The assistant could not produce a usable answer for that question. ' +
      'Try asking it in a more specific way.',
    logFields: {
      reason: `rag_answer_${lastRejection}`,
      attempt: MAX_ATTEMPTS,
      outcome: 'rejected',
      model: lastReply?.model ?? deps.model,
    },
  });
}

interface FinaliseMeta {
  readonly reply: ModelCallReply;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly fenced: readonly FencedSectionInfo[];
}

/**
 * Turns a believed reply into the response payload.
 *
 * This is where the lane's headline rule is enforced, in one branch rather than in a
 * comment: **no citations, no answer.** A reply that cited nothing — whether because the
 * model set `answered: false`, or because it wrote a confident paragraph and forgot to
 * say where it came from, or because every number it gave was out of range — produces
 * the frozen "could not find it" text and an empty citation list.
 *
 * Dropping a correct-but-uncited answer is a real cost and it is accepted deliberately.
 * The alternative is shipping a claim about someone's tenancy with nothing a reader can
 * check it against, and on this screen an unverifiable answer is worse than no answer:
 * the reader has no way to tell it apart from a confident invention.
 */
function finalise(
  value: ModelAnswer,
  chunks: readonly RetrievedChunk[],
  meta: FinaliseMeta,
): ComposedAnswer {
  const ordinals = readOrdinals(value.sources, chunks.length);
  const byOrdinal = new Map(chunks.map((chunk) => [chunk.ordinal, chunk]));

  const citations: RagCitation[] = [];
  for (const ordinal of ordinals) {
    const chunk = byOrdinal.get(ordinal);
    if (!chunk) continue;
    citations.push({
      document_id: chunk.documentId,
      document_type: chunk.documentType,
      chunk_index: chunk.chunkIndex,
      excerpt: toExcerpt(chunk.content),
    });
  }

  const answered = value.answered !== false && citations.length > 0;
  const neutralisedMarkers = meta.fenced.reduce(
    (total, section) => total + section.neutralisedMarkers,
    0,
  );

  return {
    answer: answered ? value.answer : RAG_NO_ANSWER_TEXT,
    citations: answered ? citations : [],
    answered,
    promptVersion: RAG_ANSWER_PROMPT.version,
    model: meta.reply.model || '',
    attempts: meta.attempts,
    latencyMs: meta.latencyMs,
    tokensIn: meta.reply.tokensIn,
    tokensOut: meta.reply.tokensOut,
    fenced: meta.fenced,
    neutralisedMarkers,
  };
}
