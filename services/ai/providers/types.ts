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
 * The trusted-context types are the one place server-derived facts enter a request, and
 * note what they admit: enums, counts and booleans. No free text, no identifiers a model
 * could echo into a draft, and nothing a client can set. A client-supplied value must
 * never be placed in one — `resolveUnitContext` in `services/ai/maintenance/intake.ts`
 * derives every maintenance field from database rows, and the document fields come from
 * the `documents` row and the PDF itself.
 */

import type { Classification, DocumentExtraction, DocumentType } from '@shared/index';

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

export interface AiCallOptions {
  /** Correlation id, so a provider call can be traced to the request that made it. */
  readonly requestId?: string;
  /** Abort signal, for a caller that enforces its own deadline. */
  readonly signal?: AbortSignal;
}

/** Historical name for `AiCallOptions`, kept because the barrel has exported it. */
export type ClassifyOptions = AiCallOptions;

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

/* -------------------------------------------------------------------------- */
/* Document field extraction                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The untrusted half of an extraction request.
 *
 * A PDF is the most hostile input in this application: whoever uploaded the file wrote
 * every character the model will read. It is fenced under the `document_text` label by
 * `services/ai/fence.ts` — the same fence, not a second one.
 */
export interface UntrustedDocument {
  /** Text extracted from the document. Bounded by `MAX_SECTION_CHARS` when fenced. */
  readonly documentText: string;
}

/**
 * Trusted, server-derived document context.
 *
 * `documentType` is the controlled value already stored on the `documents` row, never the
 * document's own claim about what it is. `pageCount` is a count. Neither can carry
 * document text, which is the property that makes this block safe to place outside the
 * fence.
 */
export interface DocumentTrustedContext {
  readonly documentType: DocumentType | 'unknown';
  /** Pages in the source PDF, or `null` when unknown. */
  readonly pageCount: number | null;
}

export interface ExtractDocumentInput {
  readonly untrusted: UntrustedDocument;
  readonly trusted: DocumentTrustedContext;
}

/**
 * A validated extraction plus the metadata needed to audit it.
 *
 * `extraction.requires_human_review` is **always `true`**. It is server-owned, exactly
 * like ticket priority: the model's own claim is reported separately as
 * `modelRequiresHumanReview` so the signal survives, and `reviewFlagOverridden` says when
 * the model tried to lower it — which is what a successful injection inside a PDF looks
 * like, and is worth logging.
 *
 * There is no partial or provisional variant of this type:
 * `extractDocumentFields()` either returns one of these or throws.
 */
export interface DocumentExtractionResult {
  /** Validated against `DocumentExtractionSchema`, with review forced on. */
  readonly extraction: DocumentExtraction;
  /** What the model claimed. Advisory only, never acted on. */
  readonly modelRequiresHumanReview: boolean;
  /** True when the model returned anything other than `true`. */
  readonly reviewFlagOverridden: boolean;
  readonly promptVersion: string;
  readonly model: string;
  readonly providerId: string;
  /** Provider calls made, including the retry. 1 or 2. */
  readonly attempts: number;
  readonly latencyMs: number;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly fenced: readonly FencedSectionInfo[];
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The adapter.
 *
 * Both methods return a validated object or throw (`services/ai/errors.ts`). Neither
 * performs any I/O other than the model call: the provider reads nothing from the
 * database, writes nothing, and has no Supabase client. A provider that cannot reach a
 * table cannot be talked into changing one.
 *
 * Neither method takes a system prompt, a pre-built prompt, a conversation history or a
 * stored turn. That is the structural half of CLAUDE.md rule 7's defence, and it is why
 * this interface is the thing to read rather than the call sites.
 */
export interface AiProvider {
  /** Stable provider id for logs: `anthropic`, `recorded`, and so on. */
  readonly id: string;
  /** Maintenance intake. Drafts a classification for a human to review. */
  classify(input: ClassifyInput, options?: AiCallOptions): Promise<ClassificationResult>;
  /**
   * Document field extraction, for lane w1-l6's extraction pipeline.
   *
   * Proposes field values for human verification. It cannot verify, approve or change
   * anything, and `requires_human_review` comes back `true` whatever the document says.
   */
  extractDocumentFields(
    input: ExtractDocumentInput,
    options?: AiCallOptions,
  ): Promise<DocumentExtractionResult>;
}
