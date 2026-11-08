/**
 * The provider-neutral classification adapter.
 *
 * Everything that is policy rather than plumbing lives here, so that swapping Anthropic
 * for another vendor cannot change any of it:
 *
 *   1. The frozen system prompt is taken from the registry. Never built from input.
 *   2. Untrusted content is fenced and placed in the user role, once, by `fenceUntrusted`.
 *   3. The reply is extracted, parsed and validated against `ClassificationSchema`.
 *   4. On rejection: exactly one retry, with the rejected reply fenced as untrusted data.
 *   5. On a second rejection: `AiOutputInvalidError`. Nothing is returned, nothing is
 *      half-applied — the result object is constructed only after a complete parse.
 *
 * `classify` returns a validated object or throws. There is no third outcome, and no
 * "best effort" variant: a partially-believed model reply is the failure mode this whole
 * lane exists to prevent.
 *
 * No logging happens in this file. It handles message text, and CLAUDE.md rule 8 forbids
 * logging it; the route logs the *metadata* this function returns (token counts, latency,
 * attempts, outcome) through the redaction allowlist instead.
 */

import { ClassificationSchema, type Classification } from '@shared/index';

import { AiOutputInvalidError, AiUnsupportedError, type AiOutputRejection } from '../errors';
import {
  fenceUntrusted,
  newFenceNonce,
  type FencedSectionInfo,
  type UntrustedSection,
} from '../fence';
import {
  ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT,
  type VersionedPrompt,
} from '../prompts/registry';
import type { ModelCallRequest, ModelTransport } from './transport';
import type {
  AiProvider,
  ClassificationResult,
  ClassifyInput,
  ClassifyOptions,
  TrustedContext,
} from './types';

/**
 * Longest reply text considered at all.
 *
 * A valid classification is under 1 kB. A reply an order of magnitude larger is not a
 * classification with extra whitespace, it is a different thing entirely, and parsing
 * megabytes to discover that is a denial-of-service the caller pays for.
 */
const MAX_REPLY_CHARS = 20_000;

/** One retry. Two total attempts. Not configurable: an unbounded retry loop is a bill. */
const MAX_ATTEMPTS = 2;

export interface ClassificationProviderOptions {
  /** Where the bytes go. Supplied once, at construction. Never per request. */
  readonly transport: ModelTransport;
  /** Resolved model id. Comes from `AI_MODEL` via `services/ai/providers/index.ts`. */
  readonly model: string;
  /** Defaults to the active registered prompt. Overridden only to replay a version. */
  readonly prompt?: VersionedPrompt;
}

/**
 * Builds the adapter.
 *
 * The returned object satisfies `AiProvider`, which has no system-prompt parameter — so
 * once constructed there is no way for a caller to influence the system role.
 */
export function createClassificationProvider(options: ClassificationProviderOptions): AiProvider {
  const prompt = options.prompt ?? ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT;

  return {
    id: options.transport.id,

    async classify(
      input: ClassifyInput,
      callOptions: ClassifyOptions = {},
    ): Promise<ClassificationResult> {
      const message = (input.untrusted.tenantMessage ?? '').trim();
      if (message.length === 0) throw new AiUnsupportedError('empty_message');

      const nonce = newFenceNonce();
      const sections: UntrustedSection[] = [{ label: 'tenant_message', content: message }];
      const documentText = input.untrusted.documentText?.trim();
      if (documentText) sections.push({ label: 'document_text', content: documentText });

      const fenced = fenceUntrusted(sections, nonce);
      const fencedInfo: FencedSectionInfo[] = [...fenced.sections];

      const firstTurn = [
        prompt.userPreamble,
        '',
        renderTrustedContext(input.trusted),
        '',
        fenced.text,
      ].join('\n');

      const userTurns: string[] = [firstTurn];
      const startedAt = Date.now();
      let lastRejection: AiOutputRejection = 'empty';
      let lastCause: unknown;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const request: ModelCallRequest = {
          model: options.model,
          system: prompt.system,
          userTurns,
          maxOutputTokens: prompt.maxOutputTokens,
        };

        const reply = await options.transport.send(request, callOptions.signal);
        const verdict = evaluateReply(reply.text, reply.stopReason);

        if (verdict.ok) {
          return {
            classification: verdict.classification,
            promptVersion: prompt.version,
            model: reply.model || options.model,
            providerId: options.transport.id,
            attempts: attempt,
            latencyMs: Date.now() - startedAt,
            tokensIn: reply.tokensIn,
            tokensOut: reply.tokensOut,
            fenced: fencedInfo,
          };
        }

        lastRejection = verdict.rejection;
        lastCause = verdict.cause;

        if (attempt < MAX_ATTEMPTS) {
          // The rejected reply is model output: untrusted. It goes back through the same
          // fence as the tenant's message, under its own label, so a malformed reply
          // cannot smuggle instructions in through the error path.
          const retryFence = fenceUntrusted(
            [{ label: 'previous_invalid_model_output', content: truncate(reply.text) }],
            nonce,
          );
          fencedInfo.push(...retryFence.sections);
          userTurns.push([prompt.retryInstruction, '', retryFence.text].join('\n'));
        }
      }

      throw new AiOutputInvalidError(lastRejection, MAX_ATTEMPTS, lastCause);
    },
  };
}

/* ------------------------------------------------------------ trusted framing -- */

/**
 * Renders the trusted context block.
 *
 * Three scalars, formatted by this function rather than interpolated by a caller. The
 * type system does the rest: `TrustedContext` admits an enum, a number and a boolean, so
 * there is no string field through which free text could arrive dressed as context.
 */
function renderTrustedContext(trusted: TrustedContext): string {
  return [
    '[APPLICATION-CONTEXT]',
    `unit_resolution: ${trusted.unitResolution}`,
    `candidate_unit_count: ${Number.isFinite(trusted.candidateUnitCount) ? Math.max(0, Math.trunc(trusted.candidateUnitCount)) : 0}`,
    `has_active_tenancy: ${trusted.hasActiveTenancy ? 'true' : 'false'}`,
    '[/APPLICATION-CONTEXT]',
  ].join('\n');
}

/* ------------------------------------------------------------------ validation -- */

type ReplyVerdict =
  | { ok: true; classification: Classification }
  | { ok: false; rejection: AiOutputRejection; cause?: unknown };

/**
 * Decides whether a reply is believable, in the only order that is safe.
 *
 * `max_tokens` is checked before parsing. A truncated reply can still parse if the cut
 * happened to land after a closing brace, and believing it would mean accepting a
 * classification whose `reported_symptoms` were silently clipped.
 *
 * Exported for the eval suite, which asserts each rejection path individually.
 */
export function evaluateReply(text: string, stopReason: string | null): ReplyVerdict {
  if (stopReason === 'max_tokens') return { ok: false, rejection: 'stopped_early' };

  const raw = (text ?? '').trim();
  if (raw.length === 0) return { ok: false, rejection: 'empty' };
  if (raw.length > MAX_REPLY_CHARS) return { ok: false, rejection: 'too_large' };

  const parsed = parseJsonObject(raw);
  if (parsed.kind === 'not_json') return { ok: false, rejection: 'not_json', cause: parsed.cause };
  if (parsed.kind === 'not_object') return { ok: false, rejection: 'not_object' };

  const result = ClassificationSchema.safeParse(parsed.value);
  if (!result.success) {
    return { ok: false, rejection: 'schema_rejected', cause: result.error };
  }
  return { ok: true, classification: result.data };
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
 * balanced `{...}` span. The prompt says "no markdown fence and no prose", so a reply
 * needing candidate 2 or 3 is already off-contract — but a presentational wrapper is a
 * formatting slip, not a semantic one, and rejecting it would trade a usable draft for a
 * failed request. What is *not* given benefit of the doubt is the content: whichever
 * candidate parses still has to satisfy `ClassificationSchema` in full.
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
 * A naive `indexOf('{')`/`lastIndexOf('}')` pair would swallow trailing prose that
 * happened to contain a brace, and a naive depth counter would miscount a `}` inside
 * `summary`. This walks the string once, tracking string state and escapes.
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
