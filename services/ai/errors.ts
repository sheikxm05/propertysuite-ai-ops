/**
 * The failure vocabulary of `services/ai/**`.
 *
 * Four things can go wrong when drafting a classification, and they are four different
 * facts about the world, so they are four types:
 *
 *   AiNotConfiguredError   no credential — the deployment cannot call a model at all
 *   AiProviderError        the provider was reached and failed (network, 5xx, 429)
 *   AiOutputInvalidError   the provider replied, and the reply is not schema-valid
 *   AiUnsupportedError     the adapter was asked for something it deliberately refuses
 *
 * Collapsing them into one would make the one distinction that matters invisible:
 * `AiOutputInvalidError` is the safe-reject path. It means the model said something the
 * frozen `ClassificationSchema` rejects, and that **nothing was applied** — not
 * partially, not provisionally. See `services/ai/providers/classification-provider.ts`:
 * the result object is constructed only after a complete successful parse, so there is
 * no code path on which half a classification survives.
 *
 * Two rules every error here obeys:
 *
 *  1. `logFields` only ever contains names on the `lib/observability/redaction.ts`
 *     allowlist. A model reply is untrusted text and may contain a tenant's message
 *     echoed back; it is never attached to an error and never logged (CLAUDE.md rule 8).
 *  2. `userMessage` is written for a tenant reading a form, carries no internal detail,
 *     and never says that anything was created.
 */

import { ApiRouteError, type ErrorCode } from '@/lib/api/errors';

/** Base class, so a route can catch everything from this layer in one clause. */
export class AiError extends Error {
  /** Server-side diagnostics. Allowlisted field names only — never model text. */
  readonly logFields: Record<string, unknown>;
  /** What a tenant is shown. Never mentions creation, and never quotes the model. */
  readonly userMessage: string;
  /** Which frozen §5.2 code this becomes on the wire. */
  readonly errorCode: ErrorCode;

  constructor(
    message: string,
    options: {
      errorCode: ErrorCode;
      userMessage: string;
      logFields?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = new.target.name;
    this.errorCode = options.errorCode;
    this.userMessage = options.userMessage;
    this.logFields = options.logFields ?? {};
  }
}

/**
 * No model credential is available.
 *
 * `INTERNAL_ERROR` rather than a bespoke status: from the caller's point of view a
 * deployment that cannot reach its model is broken, and the frozen eight codes have no
 * "service unavailable". The distinguishing detail goes to the log as
 * `reason: 'ai_provider_not_configured'`, joined to the response by `request_id`.
 */
export class AiNotConfiguredError extends AiError {
  constructor(reason: string, cause?: unknown) {
    super(`AI provider is not configured: ${reason}`, {
      errorCode: 'INTERNAL_ERROR',
      userMessage:
        'Assisted reporting is unavailable right now. You can still report the issue manually.',
      logFields: { reason: 'ai_provider_not_configured', provider: reason },
      cause,
    });
  }
}

/** The provider was reached and failed. Transport, rate limit or upstream fault. */
export class AiProviderError extends AiError {
  /** Upstream HTTP status when there was one. Not forwarded to the client. */
  readonly upstreamStatus: number | null;

  constructor(
    reason: string,
    options: { upstreamStatus?: number | null; provider?: string; cause?: unknown } = {},
  ) {
    super(`AI provider call failed: ${reason}`, {
      errorCode: 'INTERNAL_ERROR',
      userMessage:
        'The assistant could not draft a summary just now. Please try again in a moment.',
      logFields: {
        reason: `ai_provider_${reason}`,
        status_code: options.upstreamStatus ?? undefined,
        provider: options.provider,
      },
      cause: options.cause,
    });
    this.upstreamStatus = options.upstreamStatus ?? null;
  }
}

/**
 * The reply is not valid against `ClassificationSchema`, after the single retry.
 *
 * This is the safe-reject path and the reason it is a distinct type: a caller must be
 * able to tell "the model is unreachable" from "the model answered and we refused to
 * believe it". Nothing has been applied when this is thrown.
 */
export class AiOutputInvalidError extends AiError {
  /** How many provider calls were made before giving up. Always >= 1. */
  readonly attempts: number;
  /** Stable token describing the rejection. Allowlisted-safe; carries no model text. */
  readonly rejection: AiOutputRejection;

  constructor(rejection: AiOutputRejection, attempts: number, cause?: unknown) {
    super(`AI output rejected after ${attempts} attempt(s): ${rejection}`, {
      errorCode: 'UNPROCESSABLE',
      userMessage:
        'The assistant could not produce a usable draft for this message. ' +
        'Please rephrase it, or report the issue manually.',
      logFields: { reason: `ai_output_${rejection}`, attempt: attempts, outcome: 'rejected' },
      cause,
    });
    this.attempts = attempts;
    this.rejection = rejection;
  }
}

/** Why a reply was refused. Deliberately coarse: enough to debug, safe to log. */
export type AiOutputRejection =
  'empty' | 'not_json' | 'not_object' | 'schema_rejected' | 'too_large' | 'stopped_early';

/**
 * The adapter was asked for something it will not do.
 *
 * Exists so that the refusal is a typed, testable outcome rather than a comment. The
 * one caller today is the guard that rejects an empty untrusted payload.
 */
export class AiUnsupportedError extends AiError {
  constructor(reason: string) {
    super(`Unsupported AI request: ${reason}`, {
      errorCode: 'VALIDATION_ERROR',
      userMessage: 'That request cannot be sent to the assistant.',
      logFields: { reason: `ai_unsupported_${reason}` },
    });
  }
}

/**
 * Translates an AI-layer failure into the frozen error envelope.
 *
 * Lives here rather than in both route handlers so the two routes cannot drift in how
 * they report the same failure. `INTERNAL_ERROR` messages are not customisable
 * (`lib/api/errors.ts`), so `userMessage` is honoured only for the codes that allow it —
 * which is correct: a 500 must not describe itself to the caller.
 */
export function toApiRouteError(error: unknown): ApiRouteError {
  if (error instanceof AiError) {
    return new ApiRouteError(error.errorCode, {
      message: error.userMessage,
      logFields: error.logFields,
      cause: error,
    });
  }
  return new ApiRouteError('INTERNAL_ERROR', {
    logFields: { reason: 'ai_unexpected_failure' },
    cause: error,
  });
}

/** Type guard, for a route that wants to branch before mapping. */
export function isAiError(value: unknown): value is AiError {
  return value instanceof AiError;
}
