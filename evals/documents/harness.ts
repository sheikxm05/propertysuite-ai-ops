/**
 * Shared document-extraction eval helpers. Lane w1-l5.
 *
 * `runCase` builds the real adapter over the recorded transport and calls
 * `extractDocumentFields`, so every assertion below is about the application's end-to-end
 * answer: the frozen prompt, the shared fence, strict `DocumentExtractionSchema`
 * validation, the single retry, and the `requires_human_review` override.
 */

import { loadRecordings, type RecordedCase, type RecordedTransport } from '../_support/recordings';
import { createAiProvider } from '@/services/ai/providers/provider';
import type { DocumentExtractionResult, DocumentTrustedContext } from '@/services/ai';

const SET = loadRecordings('evals', 'documents', 'fixtures', 'recordings.json');

export const recordings = () => SET.file;
export const recordedCase = (id: string): RecordedCase => SET.caseFor(id);
export const runnableIds = (): string[] => SET.runnableIds();

/** A tenancy contract, as the `documents` row already classified it. Trusted. */
export const TENANCY_CONTRACT_CONTEXT: DocumentTrustedContext = Object.freeze({
  documentType: 'tenancy_contract',
  pageCount: 4,
});

/** A document whose type was never set. Still trusted — it is an enum, not a claim. */
export const UNKNOWN_TYPE_CONTEXT: DocumentTrustedContext = Object.freeze({
  documentType: 'unknown',
  pageCount: null,
});

export interface DocumentEvalOutcome extends DocumentExtractionResult {
  readonly transport: RecordedTransport;
}

export interface RunDocumentCaseOptions {
  readonly trusted?: DocumentTrustedContext;
  /** Overrides the document text from the fixture. */
  readonly documentText?: string;
}

/** Runs one recorded case through the real adapter. */
export async function runCase(
  id: string,
  options: RunDocumentCaseOptions = {},
): Promise<DocumentEvalOutcome> {
  const { transport, extract } = adapterFor(id);
  const documentText = options.documentText ?? recordedCase(id).message;
  if (!documentText) {
    throw new Error(`Case '${id}' has no document text; pass one with options.documentText.`);
  }

  const result = await extract(documentText, options.trusted);
  return { ...result, transport };
}

/** Builds the adapter for a case without running it, for the failure-path evals. */
export function adapterFor(id: string): {
  transport: RecordedTransport;
  extract: (
    documentText: string,
    trusted?: DocumentTrustedContext,
  ) => Promise<DocumentExtractionResult>;
} {
  const transport = SET.transportFor(id);
  const adapter = createAiProvider({ transport, model: 'fixture-model' });
  return {
    transport,
    extract: (documentText, trusted = TENANCY_CONTRACT_CONTEXT) =>
      adapter.extractDocumentFields({ untrusted: { documentText }, trusted }),
  };
}

/** The nine fields `DocumentExtractionSchema` permits, sorted. Nothing else may appear. */
export const DOCUMENT_CONTRACT_FIELDS = [
  'confidence_notes',
  'contract_number',
  'currency',
  'end_date',
  'property_address',
  'rent_amount',
  'requires_human_review',
  'start_date',
  'tenant_name',
] as const;
