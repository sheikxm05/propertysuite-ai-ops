/**
 * Prompt registry.
 *
 * One place that knows which prompt version is active and how to look up a retired one,
 * for each of the two model-facing capabilities. The adapter never imports a version file
 * directly; it asks for the active prompt. That indirection is what makes a prompt change
 * a one-line diff here instead of an edit scattered across the provider, the eval fixtures
 * and the route.
 *
 * `fingerprint` is a sha256 of the system text. It is logged (as `version`) and asserted
 * in `tests/ai/prompt-isolation.test.ts`: a system prompt that varies between two
 * requests with different untrusted input would change the fingerprint, which is the
 * mechanical statement of "nothing from a caller reaches the system role".
 *
 * The eval fixtures pin the fingerprint they were recorded against, so a prompt edit
 * cannot be silently certified by stale recordings — one named test fails instead. Both
 * capabilities work this way; see `evals/maintenance/` and `evals/documents/`.
 */

import { createHash } from 'node:crypto';

import {
  DOCUMENT_EXTRACTION_MAX_OUTPUT_TOKENS,
  DOCUMENT_EXTRACTION_PROMPT_VERSION,
  DOCUMENT_EXTRACTION_RETRY_INSTRUCTION,
  DOCUMENT_EXTRACTION_SYSTEM,
  DOCUMENT_EXTRACTION_USER_PREAMBLE,
} from './document-extraction.v1';
import {
  MAINTENANCE_CLASSIFICATION_MAX_OUTPUT_TOKENS,
  MAINTENANCE_CLASSIFICATION_PROMPT_VERSION,
  MAINTENANCE_CLASSIFICATION_RETRY_INSTRUCTION,
  MAINTENANCE_CLASSIFICATION_SYSTEM,
  MAINTENANCE_CLASSIFICATION_USER_PREAMBLE,
} from './maintenance-classification.v1';

/**
 * A released prompt.
 *
 * Note the absence of any function that takes caller text and returns a system string.
 * `system` is data, not a template, and that is the whole point.
 */
export interface VersionedPrompt {
  readonly version: string;
  /** Frozen system instruction. Byte-identical on every request. */
  readonly system: string;
  /** Trusted framing placed immediately before the fenced data in the user turn. */
  readonly userPreamble: string;
  /** Appended on the single retry after a schema rejection. */
  readonly retryInstruction: string;
  readonly maxOutputTokens: number;
}

const MAINTENANCE_CLASSIFICATION_V1: VersionedPrompt = Object.freeze({
  version: MAINTENANCE_CLASSIFICATION_PROMPT_VERSION,
  system: MAINTENANCE_CLASSIFICATION_SYSTEM,
  userPreamble: MAINTENANCE_CLASSIFICATION_USER_PREAMBLE,
  retryInstruction: MAINTENANCE_CLASSIFICATION_RETRY_INSTRUCTION,
  maxOutputTokens: MAINTENANCE_CLASSIFICATION_MAX_OUTPUT_TOKENS,
});

/**
 * Every released maintenance-classification prompt, newest last.
 *
 * Append-only. A retired version stays so that a historical draft or audit row can still
 * be interpreted.
 */
export const MAINTENANCE_CLASSIFICATION_PROMPTS: readonly VersionedPrompt[] = Object.freeze([
  MAINTENANCE_CLASSIFICATION_V1,
]);

/** The version new requests use. Moving this is the only way to change model behaviour. */
export const ACTIVE_MAINTENANCE_CLASSIFICATION_PROMPT: VersionedPrompt =
  MAINTENANCE_CLASSIFICATION_V1;

/** Looks up a released version, or `null`. Used when re-reading a historical row. */
export function maintenanceClassificationPrompt(version: string): VersionedPrompt | null {
  return MAINTENANCE_CLASSIFICATION_PROMPTS.find((p) => p.version === version) ?? null;
}

/**
 * sha256 of a prompt's system text, hex, first 16 characters.
 *
 * Short because it is a tripwire, not a signature: 64 bits is far more than enough to
 * notice that a frozen constant stopped being frozen.
 */
export function promptFingerprint(prompt: VersionedPrompt): string {
  return createHash('sha256').update(prompt.system, 'utf8').digest('hex').slice(0, 16);
}

/* -------------------------------------------------------------------------- */
/* Document field extraction                                                  */
/* -------------------------------------------------------------------------- */

const DOCUMENT_EXTRACTION_V1: VersionedPrompt = Object.freeze({
  version: DOCUMENT_EXTRACTION_PROMPT_VERSION,
  system: DOCUMENT_EXTRACTION_SYSTEM,
  userPreamble: DOCUMENT_EXTRACTION_USER_PREAMBLE,
  retryInstruction: DOCUMENT_EXTRACTION_RETRY_INSTRUCTION,
  maxOutputTokens: DOCUMENT_EXTRACTION_MAX_OUTPUT_TOKENS,
});

/**
 * Every released document-extraction prompt, newest last.
 *
 * Append-only, for the same reason as the classification list: a retired version must stay
 * so that a `pending` field proposed months ago is still attributable to the instruction
 * that proposed it.
 */
export const DOCUMENT_EXTRACTION_PROMPTS: readonly VersionedPrompt[] = Object.freeze([
  DOCUMENT_EXTRACTION_V1,
]);

/** The version new extractions use. */
export const ACTIVE_DOCUMENT_EXTRACTION_PROMPT: VersionedPrompt = DOCUMENT_EXTRACTION_V1;

/** Looks up a released version, or `null`. Used when re-reading a historical envelope. */
export function documentExtractionPrompt(version: string): VersionedPrompt | null {
  return DOCUMENT_EXTRACTION_PROMPTS.find((p) => p.version === version) ?? null;
}
