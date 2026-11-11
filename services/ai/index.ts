/**
 * `services/ai` — the provider-neutral AI layer. Lane w1-l5.
 *
 * This barrel is the surface other lanes code against. Lane w1-l6 reaches the adapter
 * through `getAiProvider()` and the types below; it writes no code under `services/ai`.
 * Two capabilities are exposed: `classify` for maintenance intake and
 * `extractDocumentFields` for w1-l6's document pipeline.
 *
 * Importing this barrel evaluates `providers/index.ts`, which reads validated
 * configuration and can construct an HTTP client. A module that wants only the fence
 * should deep-import `@/services/ai/fence`, as `services/extraction/fence.ts` does.
 *
 * THE ONE SENTENCE THAT MATTERS
 * The model drafts, a human commits. Nothing exported here mutates anything. No function
 * in this directory holds a Supabase client that can write a ticket, and the only module
 * that writes any row at all (`maintenance/transcript.ts`) writes conversation evidence,
 * which creates nothing and causes nothing. Ticket creation happens exclusively behind
 * `maintenance/ticket-creation.ts`, which is reached only from the confirm route, only
 * after `ConfirmTicketSchema`'s `confirmed: true` literal, and only with the caller's own
 * credentials.
 *
 * Reading order for a reviewer who has five minutes:
 *   providers/types.ts   — note the absence of a system-prompt parameter on either method
 *   fence.ts             — the only path untrusted text takes into a request
 *   prompts/*            — the frozen, versioned instructions
 *   providers/provider.ts — validate-or-throw, one retry, no partial apply, and
 *                           `requires_human_review` forced on for every extraction
 */

export {
  AiError,
  AiNotConfiguredError,
  AiOutputInvalidError,
  AiProviderError,
  AiUnsupportedError,
  isAiError,
  toApiRouteError,
  type AiOutputRejection,
} from './errors';

export {
  FENCE_BEGIN,
  FENCE_END,
  FENCE_FORMAT_VERSION,
  MAX_SECTION_CHARS,
  UNTRUSTED_LABELS,
  countFenceMarkers,
  fenceUntrusted,
  newFenceNonce,
  type FencedPayload,
  type FencedSectionInfo,
  type UntrustedLabel,
  type UntrustedSection,
} from './fence';

export {
  ACTIVE_DOCUMENT_EXTRACTION_PROMPT,
  ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT,
  DOCUMENT_EXTRACTION_PROMPTS,
  MAINTENANCE_CLASSIFICATION_PROMPTS,
  documentExtractionPrompt,
  maintenanceClassificationPrompt,
  promptFingerprint,
  type VersionedPrompt,
} from './prompts/registry';

export {
  REVIEW_FLAG_OVERRIDE_NOTE,
  createAiProvider,
  createAnthropicProvider,
  createClassificationProvider,
  evaluateDocumentReply,
  evaluateReply,
  evaluateWith,
  getAiProvider,
  hasAnthropicCredential,
  registerAiProviderOverride,
  resetAiProvider,
  type AiCallOptions,
  type AiProvider,
  type ClassificationProviderOptions,
  type ClassificationResult,
  type ClassifyInput,
  type ClassifyOptions,
  type DocumentExtractionResult,
  type DocumentTrustedContext,
  type ExtractDocumentInput,
  type ModelCallReply,
  type ModelCallRequest,
  type ModelProviderOptions,
  type ModelTransport,
  type TrustedContext,
  type UnitResolution,
  type UntrustedDocument,
  type UntrustedInput,
} from './providers';

export {
  decidePriority,
  isOutsideBusinessHours,
  resolveUnitContext,
  type UnitContext,
} from './maintenance/intake';

export {
  MISSING_UNIT_MARKER,
  UNIT_CLARIFICATION_QUESTIONS,
  applyUnitClarification,
  suggestDescription,
  suggestTitle,
  type UnitResolutionView,
} from './maintenance/draft';

export {
  ensureConversation,
  recordServerTurn,
  recordUserTurn,
  type TurnMetadata,
} from './maintenance/transcript';

export {
  MAINTENANCE_TICKETS_PATH,
  createHttpTicketCreationService,
  getTicketCreationService,
  registerTicketCreationService,
  resetTicketCreationService,
  type TicketCreationCaller,
  type TicketCreationService,
} from './maintenance/ticket-creation';

export {
  DOCUMENT_FIELD_EXTRACTOR_ID,
  createDocumentFieldExtractorBinding,
  type DocumentFieldExtractionRequest,
  type DocumentFieldExtractorBinding,
} from './documents/extractor-binding';
