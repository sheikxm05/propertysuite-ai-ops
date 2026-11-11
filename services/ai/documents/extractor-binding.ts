/**
 * The binding a document-extraction caller needs. Lane w1-l5.
 *
 * Lane w1-l6's `services/extraction/ai-port.ts` declares a `registerDocumentFieldExtractor()`
 * seam and waits for something to register. This file is what registers — but it is
 * deliberately shaped so that **this lane does not import w1-l6's types** (they are
 * outside its read-only set) and **w1-l6 does not import this lane's prompt**. Each side
 * owns what it owns; the contract between them is the structural shape below.
 *
 * The orchestrator wires it in one line, from w1-l6's side:
 *
 *     import { createDocumentFieldExtractorBinding } from '@/services/ai';
 *     registerDocumentFieldExtractor(createDocumentFieldExtractorBinding());
 *
 * WHY `prompt` IS ACCEPTED AND THEN IGNORED
 * ----------------------------------------
 * w1-l6's `FieldExtractionRequest` carries a pre-built `{ system, user }` prompt. This
 * binding accepts the field so the object it is handed is structurally acceptable, and
 * then **never reads it**. Using it would mean a caller supplying the system role, which
 * is the one thing this lane's adapter is built to make impossible: `AiProvider` has no
 * system-prompt parameter, and routing around that through a port would reintroduce the
 * hole by the back door. The system instruction used is always
 * `ACTIVE_DOCUMENT_EXTRACTION_PROMPT` from this lane's registry, and the document text is
 * always fenced by `services/ai/fence.ts` under the `document_text` label.
 *
 * `documentText` is therefore required, and its absence is a loud error rather than an
 * empty extraction — see the wiring note in the lane report. A caller that only has a
 * pre-built prompt has nothing this binding can use.
 *
 * WHY `id` CARRIES THE PROMPT VERSION
 * ----------------------------------
 * w1-l6 records `extractor.id` on the extraction envelope. Since this binding uses its own
 * prompt rather than the caller's, recording only `anthropic` would leave the envelope
 * naming a prompt version that was never sent. Encoding the version into the id makes the
 * instruction that actually produced the fields attributable through a field w1-l6 already
 * stores, with no change on their side.
 *
 * WHY `getAiProvider` IS IMPORTED LAZILY
 * -------------------------------------
 * `../providers` reads validated configuration and can construct an HTTP client at module
 * load. A static import would make this module — which is otherwise a pure mapping — fail
 * to import at all in an environment with no Supabase or model configuration, which is
 * exactly the environment the job runner's unit tests run in. The dynamic import is
 * reached only when no provider was injected, so an injected-provider caller never touches
 * configuration. `services/extraction/fence.ts` deep-imports the fence for the same
 * reason, and says so.
 *
 * WHY THE RETURN TYPE IS `unknown`
 * -------------------------------
 * It matches w1-l6's port, which re-parses whatever it receives against
 * `DocumentExtractionSchema` before believing any of it. The value returned here has
 * already passed that same schema inside the adapter, so the field is validated twice by
 * two lanes that do not trust each other. That is the intended arrangement, not
 * redundancy to be optimised away.
 */

import type { DocumentType } from '@shared/index';

import { DOCUMENT_EXTRACTION_PROMPT_VERSION } from '../prompts/document-extraction.v1';
import type { AiProvider } from '../providers/types';

/**
 * What the binding is handed.
 *
 * A superset of the fields w1-l6's port supplies today, so adding `documentText` on their
 * side is the only change needed. Every field other than `documentText` is optional and
 * trusted-or-ignored.
 */
export interface DocumentFieldExtractionRequest {
  /** Text extracted from the PDF. Required. Fenced as untrusted data. */
  readonly documentText?: string;
  /** The controlled type from the `documents` row. Not the document's own claim. */
  readonly documentType?: DocumentType | 'unknown';
  /** Pages in the source PDF. A count; never content. */
  readonly pageCount?: number | null;
  /** The job runner's deadline, so a hung provider cannot hold a claim open. */
  readonly signal?: AbortSignal;
  /**
   * Accepted for structural compatibility and **never read**. See the note above: a
   * caller-supplied prompt would be a caller-supplied system role.
   */
  readonly prompt?: unknown;
}

export interface DocumentFieldExtractorBinding {
  readonly id: string;
  extract(request: DocumentFieldExtractionRequest): Promise<unknown>;
}

/** Recorded on w1-l6's envelope, so the prompt actually used is attributable. */
export const DOCUMENT_FIELD_EXTRACTOR_ID = `anthropic:${DOCUMENT_EXTRACTION_PROMPT_VERSION}`;

/**
 * Builds the binding.
 *
 * `provider` is injectable for tests and for a replay against a pinned prompt version;
 * omitted, it resolves the configured adapter lazily on first call, so registering the
 * binding at start-up does not require a credential to exist yet.
 */
export function createDocumentFieldExtractorBinding(
  provider?: AiProvider,
): DocumentFieldExtractorBinding {
  return {
    id: DOCUMENT_FIELD_EXTRACTOR_ID,

    async extract(request: DocumentFieldExtractionRequest): Promise<unknown> {
      const documentText = (request.documentText ?? '').trim();
      if (documentText.length === 0) {
        // Loud, and specific about the wiring. An empty extraction here would be
        // indistinguishable from a document with no readable text, and would silently
        // produce nine nulls that a human would then have to disbelieve.
        throw new Error(
          'createDocumentFieldExtractorBinding: `documentText` is required. ' +
            'The caller must pass the extracted text, not only a pre-built prompt — ' +
            'this binding uses its own frozen system instruction by design.',
        );
      }

      // Lazy, and only when nothing was injected. See the note above.
      const adapter = provider ?? (await import('../providers')).getAiProvider();
      const result = await adapter.extractDocumentFields(
        {
          untrusted: { documentText },
          trusted: {
            documentType: request.documentType ?? 'unknown',
            pageCount: request.pageCount ?? null,
          },
        },
        request.signal ? { signal: request.signal } : {},
      );

      // `requires_human_review` is already forced to `true` by the adapter. Returned as
      // the plain extraction so w1-l6's own `DocumentExtractionSchema` parse succeeds.
      return result.extraction;
    },
  };
}
