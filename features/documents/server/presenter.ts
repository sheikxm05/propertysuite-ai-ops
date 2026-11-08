/**
 * Row to response. The only place a `documents` row becomes JSON.
 *
 * Two things are enforced here rather than remembered at each call site:
 *
 *  1. **`extracted_text` never leaves the server.** It is not selected by
 *     `DOCUMENT_COLUMNS` and there is no field for it on `DocumentSchema`, so there is
 *     nothing to forget. The document body is retrievable only by downloading the
 *     original object through a 60-second signed URL — which is an authorization
 *     decision Storage re-makes — rather than by reading a list endpoint.
 *  2. **`is_verified` is derived from the column, never from the extraction.**
 *     `extracted_data` is model output. It can contain any JSON at all, including a
 *     `verification` block somebody tampered with through a service-role script. The
 *     flag the UI branches on therefore comes from `documents.verification_status`,
 *     which only `POST .../verify` writes. `DocumentDetailSchema`'s own comment in
 *     `packages/shared` says the same thing; this is where it is true.
 *
 * `proposed_fields` is named for what it is. A reviewer's screen shows it beside the
 * value they are about to accept, and the two are different things until they press the
 * button.
 */

import {
  DocumentDetailSchema,
  DocumentSchema,
  type Document,
  type DocumentDetail,
  type DocumentType,
  type JobStatus,
  type VerificationStatus,
} from '@shared/index';
import {
  readEnvelope,
  proposedFieldsFor,
  type DocumentExtractionEnvelope,
} from '@/services/extraction';

import type { DocumentRecord } from './documents-service';

/**
 * The list shape.
 *
 * Parsed through `DocumentSchema` rather than cast. A response that does not satisfy
 * the frozen schema is a bug worth a 500, not a payload worth shipping — and parsing
 * also strips anything a future column addition would otherwise leak into the body.
 */
export function toDocument(record: DocumentRecord): Document {
  return DocumentSchema.parse({
    id: record.id,
    organization_id: record.organization_id,
    property_id: record.property_id,
    tenancy_id: record.tenancy_id,
    ticket_id: record.ticket_id,
    document_type: record.document_type as DocumentType,
    storage_path: record.storage_path,
    extracted_data: normaliseEnvelopeForClient(record.extracted_data),
    verification_status: record.verification_status as VerificationStatus,
    uploaded_by: record.uploaded_by,
    created_at: record.created_at,
  });
}

export interface DetailOptions {
  /** `jobs.status` for the document's extraction job, when one exists. */
  readonly jobStatus?: JobStatus | null;
}

/** The verification screen's shape. */
export function toDocumentDetail(
  record: DocumentRecord,
  options: DetailOptions = {},
): DocumentDetail {
  const envelope = readEnvelope(record.extracted_data);

  return DocumentDetailSchema.parse({
    ...toDocument(record),
    proposed_fields: proposedFieldsFor(envelope),
    confidence_notes: envelope?.notes ?? [],
    // From the column. Never from `envelope.verification` — see the file header.
    is_verified: record.verification_status === 'verified',
    job_status: options.jobStatus ?? null,
  });
}

/**
 * What of `extracted_data` a client may see.
 *
 * The stored envelope carries source excerpts — real document text — and the
 * `verification` block. Both are legitimate for an authorized verifier, who may read
 * the whole document anyway, so they are passed through. What is removed is anything
 * that failed to parse as an envelope: unrecognised JSON in this column could have been
 * written by any service-role path, and echoing it back unexamined would make the
 * response shape depend on whatever that was.
 */
function normaliseEnvelopeForClient(value: unknown): DocumentExtractionEnvelope | null {
  return readEnvelope(value);
}
