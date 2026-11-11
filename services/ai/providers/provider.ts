/**
 * The provider-neutral adapter. Both model-facing capabilities live here.
 *
 * Everything that is policy rather than plumbing is in this file, so that swapping
 * Anthropic for another vendor cannot change any of it:
 *
 *   1. The frozen system prompt comes from the registry. Never built from input.
 *   2. Untrusted content is fenced and placed in the user role, once, by `fenceUntrusted`.
 *   3. The reply is extracted, parsed and validated against a schema from
 *      `packages/shared` — `ClassificationSchema` or `DocumentExtractionSchema`.
 *   4. On rejection: exactly one retry, with the rejected reply fenced as untrusted data.
 *   5. On a second rejection: `AiOutputInvalidError`. Nothing is returned, nothing is
 *      half-applied — the result object is constructed only after a complete parse.
 *
 * Both methods return a validated object or throw. There is no third outcome and no "best
 * effort" variant: a partially-believed model reply is the failure mode this lane exists
 * to prevent.
 *
 * ONE EXTRA GUARANTEE ON DOCUMENT EXTRACTION
 * `requires_human_review` is **server-owned**. Whatever the model returns, the stored
 * value is `true`. The model's own claim is reported separately as
 * `modelRequiresHumanReview`, so the signal is not lost, and `reviewFlagOverridden` says
 * when the model tried to lower it — which is exactly what a successful injection inside a
 * PDF looks like. Lane w1-l6's verification gate refuses to act on a compromised reply
 * anyway; this makes sure the adapter does not produce one in the first place.
 *
 * No logging happens in this file. It handles message and document text, and CLAUDE.md
 * rule 8 forbids logging either; the routes and the job runner log the *metadata* these
 * functions return (token counts, latency, attempts, outcome) through the redaction
 * allowlist instead.
 */

import {
  ClassificationSchema,
  DocumentExtractionSchema,
  type Classification,
  type DocumentExtraction,
} from '@shared/index';

import { AiOutputInvalidError, AiUnsupportedError, type AiOutputRejection } from '../errors';
import {
  fenceUntrusted,
  newFenceNonce,
  type FencedSectionInfo,
  type UntrustedSection,
} from '../fence';
import {
  ACTIVE_DOCUMENT_EXTRACTION_PROMPT,
  ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT,
  type VersionedPrompt,
} from '../prompts/registry';
import type { ModelCallReply, ModelCallRequest, ModelTransport } from './transport';
import type {
  AiCallOptions,
  AiProvider,
  ClassificationResult,
  ClassifyInput,
  DocumentExtractionResult,
  DocumentTrustedContext,
  ExtractDocumentInput,
  TrustedContext,
} from './types';

/**
 * Longest reply text considered at all.
 *
 * A valid reply is under 1 kB. A reply an order of magnitude larger is not a
 * classification with extra whitespace, it is a different thing entirely, and parsing
 * megabytes to discover that is a denial-of-service the caller pays for.
 */
const MAX_REPLY_CHARS = 20_000;

/** One retry. Two total attempts. Not configurable: an unbounded retry loop is a bill. */
const MAX_ATTEMPTS = 2;

/**
 * The confidence note added when the model claims no human review is needed.
 *
 * Visible to the human verifier in w1-l6's review UI, which is the point: the override is
 * recorded where the person deciding can see it, not only in a log.
 */
export const REVIEW_FLAG_OVERRIDE_NOTE =
  'The document reply claimed no human review was needed. The application requires review regardless.';

export interface ModelProviderOptions {
  /** Where the bytes go. Supplied once, at construction. Never per request. */
  readonly transport: ModelTransport;
  /** Resolved model id. Comes from `AI_MODEL` via `services/ai/providers/index.ts`. */
  readonly model: string;
  /** Defaults to the active registered prompt. Overridden only to replay a version. */
  readonly classificationPrompt?: VersionedPrompt;
  /** Defaults to the active registered prompt. Overridden only to replay a version. */
  readonly documentExtractionPrompt?: VersionedPrompt;
}

/**
 * Builds the adapter.
 *
 * The returned object satisfies `AiProvider`, which has no system-prompt parameter on
 * either method — so once constructed there is no way for a caller to influence the
 * system role.
 */
export function createAiProvider(options: ModelProviderOptions): AiProvider {
  const classificationPrompt =
    options.classificationPrompt ?? ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT;
  const extractionPrompt = options.documentExtractionPrompt ?? ACTIVE_DOCUMENT_EXTRACTION_PROMPT;

  return {
    id: options.transport.id,

    async classify(
      input: ClassifyInput,
      callOptions: AiCallOptions = {},
    ): Promise<ClassificationResult> {
      const message = (input.untrusted.tenantMessage ?? '').trim();
      if (message.length === 0) throw new AiUnsupportedError('empty_message');

      const sections: UntrustedSection[] = [{ label: 'tenant_message', content: message }];
      const documentText = input.untrusted.documentText?.trim();
      if (documentText) sections.push({ label: 'document_text', content: documentText });

      const call = await runValidatedCall<Classification>({
        transport: options.transport,
        model: options.model,
        prompt: classificationPrompt,
        sections,
        trustedBlock: renderClassificationContext(input.trusted),
        validate: schemaValidator(ClassificationSchema),
        signal: callOptions.signal,
      });

      return {
        classification: call.value,
        promptVersion: classificationPrompt.version,
        model: call.reply.model || options.model,
        providerId: options.transport.id,
        attempts: call.attempts,
        latencyMs: call.latencyMs,
        tokensIn: call.reply.tokensIn,
        tokensOut: call.reply.tokensOut,
        fenced: call.fenced,
      };
    },

    async extractDocumentFields(
      input: ExtractDocumentInput,
      callOptions: AiCallOptions = {},
    ): Promise<DocumentExtractionResult> {
      const text = (input.untrusted.documentText ?? '').trim();
      if (text.length === 0) throw new AiUnsupportedError('empty_document_text');

      const call = await runValidatedCall<DocumentExtraction>({
        transport: options.transport,
        model: options.model,
        prompt: extractionPrompt,
        sections: [{ label: 'document_text', content: text }],
        trustedBlock: renderDocumentContext(input.trusted),
        validate: schemaValidator(DocumentExtractionSchema),
        signal: callOptions.signal,
      });

      const claimed = call.value.requires_human_review;
      const overridden = claimed !== true;

      /*
       * The server-owned field. Set unconditionally, not "corrected if wrong", because
       * `true` is the application's answer and the model's is advisory — and because an
       * `if` here would be one refactor away from being removed.
       *
       * Re-parsed through the schema so the note append cannot produce a value the rest of
       * the system would reject (a 21st note, or one over 300 characters).
       */
      const extraction = DocumentExtractionSchema.parse({
        ...call.value,
        requires_human_review: true,
        confidence_notes: overridden
          ? capNotes([...call.value.confidence_notes, REVIEW_FLAG_OVERRIDE_NOTE])
          : call.value.confidence_notes,
      });

      return {
        extraction,
        modelRequiresHumanReview: claimed,
        reviewFlagOverridden: overridden,
        promptVersion: extractionPrompt.version,
        model: call.reply.model || options.model,
        providerId: options.transport.id,
        attempts: call.attempts,
        latencyMs: call.latencyMs,
        tokensIn: call.reply.tokensIn,
        tokensOut: call.reply.tokensOut,
        fenced: call.fenced,
      };
    },
  };
}

/**
 * Historical name, kept because the barrel has exported it since the lane landed.
 *
 * It builds the whole provider, both methods — the name predates document extraction.
 */
export const createClassificationProvider = createAiProvider;

/** Historical option type name. Same shape. */
export type ClassificationProviderOptions = ModelProviderOptions;

/* ---------------------------------------------------------------- the call -- */

/** Turns an unknown value into `T`, or reports that it will not. */
type Validator<T> = (value: unknown) => { ok: true; value: T } | { ok: false; cause?: unknown };

interface ValidatedCallSpec<T> {
  readonly transport: ModelTransport;
  readonly model: string;
  readonly prompt: VersionedPrompt;
  readonly sections: readonly UntrustedSection[];
  readonly trustedBlock: string;
  readonly validate: Validator<T>;
  readonly signal?: AbortSignal;
}

interface ValidatedCall<T> {
  readonly value: T;
  readonly reply: ModelCallReply;
  readonly attempts: number;
  readonly latencyMs: number;
  readonly fenced: readonly FencedSectionInfo[];
}

/**
 * Fence, send, validate, retry once, or throw.
 *
 * Shared by both capabilities deliberately. The retry rule, the fence-the-rejected-reply
 * rule and the no-partial-apply rule are security properties, and two copies of a security
 * property is one that can be right in one place and wrong in the other.
 */
async function runValidatedCall<T>(spec: ValidatedCallSpec<T>): Promise<ValidatedCall<T>> {
  const nonce = newFenceNonce();
  const fenced = fenceUntrusted(spec.sections, nonce);
  const fencedInfo: FencedSectionInfo[] = [...fenced.sections];

  const userTurns: string[] = [
    [spec.prompt.userPreamble, '', spec.trustedBlock, '', fenced.text].join('\n'),
  ];

  const startedAt = Date.now();
  let lastRejection: AiOutputRejection = 'empty';
  let lastCause: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const request: ModelCallRequest = {
      model: spec.model,
      system: spec.prompt.system,
      userTurns,
      maxOutputTokens: spec.prompt.maxOutputTokens,
    };

    const reply = await spec.transport.send(request, spec.signal);
    const verdict = evaluateWith(reply.text, reply.stopReason, spec.validate);

    if (verdict.ok) {
      return {
        value: verdict.value,
        reply,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
        fenced: fencedInfo,
      };
    }

    lastRejection = verdict.rejection;
    lastCause = verdict.cause;

    if (attempt < MAX_ATTEMPTS) {
      // The rejected reply is model output: untrusted. It goes back through the same fence
      // as the tenant's message, under its own label, so a malformed reply cannot smuggle
      // instructions in through the error path.
      const retryFence = fenceUntrusted(
        [{ label: 'previous_invalid_model_output', content: truncate(reply.text) }],
        nonce,
      );
      fencedInfo.push(...retryFence.sections);
      userTurns.push([spec.prompt.retryInstruction, '', retryFence.text].join('\n'));
    }
  }

  throw new AiOutputInvalidError(lastRejection, MAX_ATTEMPTS, lastCause);
}

/* ------------------------------------------------------------ trusted framing -- */

/**
 * Renders the maintenance trusted context block.
 *
 * Three scalars, formatted here rather than interpolated by a caller. The type system does
 * the rest: `TrustedContext` admits an enum, a number and a boolean, so there is no string
 * field through which free text could arrive dressed as context.
 */
function renderClassificationContext(trusted: TrustedContext): string {
  return [
    '[APPLICATION-CONTEXT]',
    `unit_resolution: ${trusted.unitResolution}`,
    `candidate_unit_count: ${nonNegativeInteger(trusted.candidateUnitCount)}`,
    `has_active_tenancy: ${trusted.hasActiveTenancy ? 'true' : 'false'}`,
    '[/APPLICATION-CONTEXT]',
  ].join('\n');
}

/**
 * Renders the document trusted context block.
 *
 * `documentType` is a controlled value from `DOCUMENT_TYPES` (or `unknown`) and
 * `pageCount` is a count. Neither can carry document text, which is why the document's own
 * claim about what kind of document it is never reaches this block.
 */
function renderDocumentContext(trusted: DocumentTrustedContext): string {
  return [
    '[APPLICATION-CONTEXT]',
    `document_type: ${trusted.documentType}`,
    `page_count: ${trusted.pageCount === null ? 'unknown' : nonNegativeInteger(trusted.pageCount)}`,
    '[/APPLICATION-CONTEXT]',
  ].join('\n');
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/* ------------------------------------------------------------------ validation -- */

type Verdict<T> =
  { ok: true; value: T } | { ok: false; rejection: AiOutputRejection; cause?: unknown };

/** Adapts a Zod schema to the `Validator` shape without leaking Zod into the spec type. */
function schemaValidator<T>(schema: {
  safeParse: (value: unknown) => SafeParseLike<T>;
}): Validator<T> {
  return (value: unknown) => {
    const result = schema.safeParse(value);
    return result.success ? { ok: true, value: result.data } : { ok: false, cause: result.error };
  };
}

type SafeParseLike<T> = { success: true; data: T } | { success: false; error: unknown };

/**
 * Decides whether a reply is believable, in the only order that is safe.
 *
 * `max_tokens` is checked before parsing. A truncated reply can still parse if the cut
 * happened to land after a closing brace, and believing it would mean accepting a reply
 * whose array fields were silently clipped.
 */
export function evaluateWith<T>(
  text: string,
  stopReason: string | null,
  validate: Validator<T>,
): Verdict<T> {
  if (stopReason === 'max_tokens') return { ok: false, rejection: 'stopped_early' };

  const raw = (text ?? '').trim();
  if (raw.length === 0) return { ok: false, rejection: 'empty' };
  if (raw.length > MAX_REPLY_CHARS) return { ok: false, rejection: 'too_large' };

  const parsed = parseJsonObject(raw);
  if (parsed.kind === 'not_json') return { ok: false, rejection: 'not_json', cause: parsed.cause };
  if (parsed.kind === 'not_object') return { ok: false, rejection: 'not_object' };

  const validated = validate(parsed.value);
  if (!validated.ok) {
    return { ok: false, rejection: 'schema_rejected', cause: validated.cause };
  }
  return { ok: true, value: validated.value };
}

/**
 * `evaluateWith`, bound to `ClassificationSchema`.
 *
 * Exported because the eval suite asserts each rejection path individually against the
 * maintenance contract.
 */
export function evaluateReply(text: string, stopReason: string | null): Verdict<Classification> {
  return evaluateWith(text, stopReason, schemaValidator(ClassificationSchema));
}

/** `evaluateWith`, bound to `DocumentExtractionSchema`. */
export function evaluateDocumentReply(
  text: string,
  stopReason: string | null,
): Verdict<DocumentExtraction> {
  return evaluateWith(text, stopReason, schemaValidator(DocumentExtractionSchema));
}

type ParseOutcome =
  | { kind: 'object'; value: Record<string, unknown> }
  | { kind: 'not_object' }
  | { kind: 'not_json'; cause?: unknown };

/**
 * Parses a reply into a plain object.
 *
 * Three candidate strings are tried, in order of how much benefit of the doubt they
 * require: the text as sent, the text with a markdown code fence removed, and the first
 * balanced `{...}` span. Both prompts say "no markdown fence and no prose", so a reply
 * needing candidate 2 or 3 is already off-contract — but a presentational wrapper is a
 * formatting slip, not a semantic one, and rejecting it would trade a usable draft for a
 * failed request. What is *not* given benefit of the doubt is the content: whichever
 * candidate parses still has to satisfy the schema in full.
 */
function parseJsonObject(raw: string): ParseOutcome {
  let lastCause: unknown;

  for (const candidate of [raw, stripCodeFence(raw), firstBalancedObject(raw)]) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { kind: 'not_object' };
      }
      return { kind: 'object', value: value as Record<string, unknown> };
    } catch (error) {
      lastCause = error;
    }
  }

  return { kind: 'not_json', cause: lastCause };
}

/** Removes a leading ```json / ``` fence and its closer, if both are present. */
function stripCodeFence(raw: string): string | null {
  const match = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(raw.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * The first brace-balanced span, ignoring braces inside JSON strings.
 *
 * A naive `indexOf('{')`/`lastIndexOf('}')` pair would swallow trailing prose that happened
 * to contain a brace, and a naive depth counter would miscount a `}` inside a string value.
 * This walks the string once, tracking string state and escapes.
 */
function firstBalancedObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return null;
}

/** Bounds the rejected reply before it is fenced back into the retry turn. */
function truncate(text: string): string {
  const raw = (text ?? '').trim();
  return raw.length > 2000 ? raw.slice(0, 2000) : raw;
}

/** Keeps `confidence_notes` inside the schema's 20-entry cap, newest note preserved. */
function capNotes(notes: readonly string[]): string[] {
  const unique = Array.from(new Set(notes.map((note) => note.trim()).filter(Boolean)));
  return unique.length <= 20 ? unique : [...unique.slice(0, 19), REVIEW_FLAG_OVERRIDE_NOTE];
}
