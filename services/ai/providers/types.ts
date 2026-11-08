/**
 * The provider-neutral AI interface.
 *
 * This is the frozen surface the rest of the application codes against — the two
 * `/api/v1/ai/*` routes and, per `docs/agent-briefings.md`, lane w1-l6's document
 * extraction. Nothing outside `services/ai/providers/**` names Anthropic.
 *
 * READ THIS INTERFACE FOR THE SECURITY PROPERTY
 * ---------------------------------------------
 * There is **no system-prompt parameter**, and there is no parameter of any name through
 * which a caller can contribute to the system role. Caller text has exactly one way in:
 * `ClassifyInput.untrusted`, whose every field is fenced as data by
 * `services/ai/fence.ts` and placed in the user role.
 *
 * That is deliberate and it is the structural half of CLAUDE.md rule 7's defence. A
 * reviewer does not have to audit thirty call sites to know that untrusted input cannot
 * become an instruction; they read this file and see that the argument does not exist.
 *
 * `TrustedContext` is the one place server-derived facts enter the request, and note what
 * it admits: enums, counts and booleans. No free text, no identifiers a model could echo
 * into a draft, and nothing a client can set. A client-supplied value must never be
 * placed in it — `resolveUnitContext` in `services/ai/maintenance/intake.ts` derives
 * every field from database rows.
 */

import type { Classification } from '@shared/index';

import type { FencedSectionInfo } from '../fence';

/**
 * The untrusted half of a request. Fenced, never logged, never in the system role.
 *
 * `documentText` exists for lane w1-l6: a tenancy contract's extracted text is exactly
 * as hostile as a tenant's message and goes through the same path.
 */
export interface UntrustedInput {
  /** A tenant's free-text message. Bounded by `AiMessageContentSchema` upstream. */
  readonly tenantMessage: string;
  /** Optional supplementary text extracted from a document. Also hostile. */
  readonly documentText?: string | null;
}

/** How confidently the server identified the unit the message is about. */
export type UnitResolution = 'resolved' | 'ambiguous' | 'none';

/**
 * Trusted, server-derived context.
 *
 * Every field must come from a database row or the server clock. Deliberately coarse:
 * the model is told *that* the unit is ambiguous, not *which* units exist, because the
 * candidate list is other people's data and the model does not need it to ask a
 * clarifying question.
 */
export interface TrustedContext {
  readonly unitResolution: UnitResolution;
  /** How many units the caller holds an active tenancy on. A count, never ids. */
  readonly candidateUnitCount: number;
  /** Is anyone living in the resolved unit? From `tenancies`, not from the request. */
  readonly hasActiveTenancy: boolean;
}

export interface ClassifyInput {
  readonly untrusted: UntrustedInput;
  readonly trusted: TrustedContext;
}

export interface ClassifyOptions {
  /** Correlation id, so a provider call can be traced to the request that made it. */
  readonly requestId?: string;
  /** Abort signal, for a caller that enforces its own deadline. */
  readonly signal?: AbortSignal;
}

/**
 * A validated classification plus the metadata needed to audit it.
 *
 * `classification` has already passed `ClassificationSchema`. There is no partial or
 * provisional variant of this type: `classify()` either returns one of these or throws.
 */
export interface ClassificationResult {
  readonly classification: Classification;
  readonly promptVersion: string;
  /** Resolved model id, as reported by the provider. Logged; never hardcoded. */
  readonly model: string;
  readonly providerId: string;
  /** Provider calls made, including the retry. 1 or 2. */
  readonly attempts: number;
  readonly latencyMs: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  /** Lengths and flags for the fenced sections. Safe to log; carries no content. */
  readonly fenced: readonly FencedSectionInfo[];
}

/**
 * The adapter.
 *
 * `classify` returns a validated object or throws (`services/ai/errors.ts`). It performs
 * no I/O other than the model call: it reads nothing from the database, writes nothing,
 * and has no Supabase client. A provider that cannot reach a table cannot be talked into
 * changing one.
 */
export interface AiProvider {
  /** Stable provider id for logs: `anthropic`, `recorded`, and so on. */
  readonly id: string;
  classify(input: ClassifyInput, options?: ClassifyOptions): Promise<ClassificationResult>;
}
