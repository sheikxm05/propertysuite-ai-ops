/**
 * The `document_extraction` job handler.
 *
 * Runs with the service-role client, because a background job has no `auth.uid()` and
 * therefore no RLS identity. That is the one legitimate use of an RLS-bypassing client
 * named in `lib/api/server-only/privileged-handler.ts`, and it shifts the burden of
 * tenant scoping onto this file. Two checks carry it:
 *
 *  1. **`organization_id` is re-derived from the row, and the payload must agree.** The
 *     payload was written by an authenticated request that had already resolved
 *     membership, but a payload is data, and this handler reads it with a client that
 *     ignores policies. If the payload's organization and the document's organization
 *     differ, the job fails permanently rather than proceeding with either. A poisoned
 *     payload therefore cannot steer the worker at another tenant's document.
 *  2. **The document must be `pending`.** A `verified` document's values were confirmed
 *     by a human; overwriting its proposal with fresh model output would make the
 *     verification screen show unreviewed values beside a `verified` badge. A
 *     `rejected` one was rejected on purpose. Either is a permanent failure, not a
 *     retry.
 *
 * And the invariant the whole lane exists for: **this handler never writes
 * `verification_status`.** It writes `extracted_text` and `extracted_data`, and the
 * envelope it builds comes from `buildPendingEnvelope`, which has no parameter capable
 * of producing a verification block. The only writer of that block is
 * `POST /api/v1/documents/{documentId}/verify`, behind an authenticated human
 * confirmation. `tests/documents/verification-gate.test.ts` asserts it by inspecting
 * every column this file updates.
 *
 * Logging: job id, document id, organization id, counts, outcome. Never the extracted
 * text, never the storage path, never a provider message (CLAUDE.md rule 8). The
 * logger's allowlist in `lib/observability/redaction.ts` enforces that independently,
 * but the call sites below do not rely on it.
 */

import { z } from 'zod';

import { STORAGE_BUCKET, UuidSchema, isStoragePathForOrganization, type Json } from '@shared/index';
import type { Logger } from '@/lib/observability/logger';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';
import {
  FIELD_EXTRACTION_UNAVAILABLE_NOTE,
  FenceIntegrityError,
  assertPdfBytes,
  buildFieldExcerpts,
  buildPendingEnvelope,
  extractDocumentFields,
  extractPdfText,
  looksLikePdf,
  readEnvelope,
  type DocumentExtractionEnvelope,
  type ExtractFieldsOptions,
  type ExtractPdfTextDeps,
} from '@/services/extraction';

import { PermanentJobError, RetryableJobError } from './job-errors';
import type { JobHandler, JobHandlerContext } from './runner-types';

/** `jobs.type` for this handler. The value is frozen in `JOB_TYPES` (`@shared/index`). */
export const DOCUMENT_EXTRACTION_JOB_TYPE = 'document_extraction' as const;

/**
 * The payload.
 *
 * `organization_id` is carried so the handler can *cross-check* the row it reads, not
 * so it can scope the read. `requested_by` is the profile that asked, recorded for the
 * log trail; it grants nothing.
 */
export const DocumentExtractionPayloadSchema = z
  .object({
    document_id: UuidSchema,
    organization_id: UuidSchema,
    requested_by: UuidSchema.nullable().optional(),
  })
  .strict();

export type DocumentExtractionPayload = z.infer<typeof DocumentExtractionPayloadSchema>;

/** Builds the exactly-once key for a document's extraction. */
export function documentExtractionIdempotencyKey(
  documentId: string,
  suffix?: string | null,
): string {
  const base = `${DOCUMENT_EXTRACTION_JOB_TYPE}:${documentId}`;
  return suffix && suffix.length > 0 ? `${base}:${suffix}` : base;
}

/* ------------------------------------------------------------------- row -- */

const DOCUMENT_COLUMNS =
  'id, organization_id, property_id, tenancy_id, ticket_id, document_type, storage_path, extracted_data, verification_status, uploaded_by, created_at';

interface DocumentRowForJob {
  id: string;
  organization_id: string;
  document_type: string;
  storage_path: string;
  extracted_data: unknown;
  verification_status: string;
}

/* --------------------------------------------------------------- handler -- */

export interface DocumentExtractionDeps {
  /** Injected in tests so the handler can be driven without Storage or a model. */
  readonly pdf?: ExtractPdfTextDeps;
  readonly fields?: ExtractFieldsOptions;
  readonly now?: () => Date;
}

/**
 * Creates the handler.
 *
 * A factory rather than a bare function so dependencies are injected at wiring time
 * instead of read from module state. The production call is
 * `createDocumentExtractionHandler()` with no arguments.
 */
export function createDocumentExtractionHandler(deps: DocumentExtractionDeps = {}): JobHandler {
  return {
    type: DOCUMENT_EXTRACTION_JOB_TYPE,
    async run(context: JobHandlerContext): Promise<void> {
      const payload = parsePayload(context.job.payload);
      const { client, logger, signal } = context;

      const document = await loadDocument(client, payload.document_id);
      assertDocumentUsable(document, payload);

      const bytes = await downloadObject(client, document, logger);
      // Magic bytes again, on the real object. The `/process` route already checked,
      // but an object can be replaced between enqueue and run, and only staff can
      // overwrite one — which is exactly the actor whose mistake this catches.
      assertPdfBytes(bytes);

      const text = await extractPdfText(bytes, deps.pdf ?? {});
      await persistExtractedText(client, document.id, text.text);

      logger.info('document text extracted', {
        document_id: document.id,
        organization_id: document.organization_id,
        count: text.characterCount,
        outcome: 'text_extracted',
      });

      const notes: string[] = [];
      if (text.truncated) {
        notes.push(
          'The document was longer than the extraction limit, so only its first part was read.',
        );
      }
      if (!looksLikePdf(bytes).trailer) {
        notes.push(
          'The file has no readable PDF end-of-file marker, so it may be truncated or incomplete.',
        );
      }

      const outcome = await proposeFields(text.text, deps.fields, signal);
      if (outcome.status === 'unavailable') notes.push(FIELD_EXTRACTION_UNAVAILABLE_NOTE);

      const previous = readEnvelope(document.extracted_data);
      const envelope = buildPendingEnvelope({
        version: outcome.promptVersion,
        extractorId: outcome.status === 'extracted' ? outcome.extractorId : null,
        text: {
          characterCount: text.characterCount,
          pageCount: text.pageCount,
          truncated: text.truncated,
        },
        proposed: outcome.status === 'extracted' ? outcome.extraction : null,
        excerpts:
          outcome.status === 'extracted' ? buildFieldExcerpts(text.text, outcome.extraction) : {},
        notes,
        previous,
        ...(deps.now ? { now: deps.now } : {}),
      });

      await persistEnvelope(client, document.id, envelope);

      logger.info('document extraction complete', {
        document_id: document.id,
        organization_id: document.organization_id,
        // The row's own status, re-stated so the log proves the gate held.
        verification_status: document.verification_status,
        outcome: outcome.status === 'extracted' ? 'fields_proposed' : 'fields_unavailable',
      });
    },
  };
}

/* ----------------------------------------------------------------- steps -- */

function parsePayload(raw: unknown): DocumentExtractionPayload {
  const parsed = DocumentExtractionPayloadSchema.safeParse(raw);
  // A malformed payload cannot become well formed on a retry.
  if (!parsed.success) throw new PermanentJobError('payload_invalid');
  return parsed.data;
}

async function loadDocument(
  client: PrivilegedSupabaseClient,
  documentId: string,
): Promise<DocumentRowForJob> {
  const { data, error } = await client
    .from('documents')
    .select(DOCUMENT_COLUMNS)
    .eq('id', documentId)
    .maybeSingle();

  if (error) throw new RetryableJobError('database_write_failed', { cause: error });
  if (!data) throw new PermanentJobError('document_not_found');
  return data as unknown as DocumentRowForJob;
}

/**
 * The two tenant and gate checks described in the file header.
 *
 * The storage path is checked too: it must begin with the document's own organization
 * id, which is the convention the storage policies rely on (`{organization_id}/…`). A
 * row whose path points into another organization's prefix is a corrupted row, and
 * signing or downloading it would cross the isolation boundary with no policy violated.
 */
function assertDocumentUsable(
  document: DocumentRowForJob,
  payload: DocumentExtractionPayload,
): void {
  if (document.organization_id !== payload.organization_id) {
    throw new PermanentJobError('document_organization_mismatch');
  }
  if (!isStoragePathForOrganization(document.storage_path, document.organization_id)) {
    throw new PermanentJobError('document_organization_mismatch');
  }
  if (document.verification_status !== 'pending') {
    throw new PermanentJobError('document_not_pending_verification');
  }
}

async function downloadObject(
  client: PrivilegedSupabaseClient,
  document: DocumentRowForJob,
  logger: Logger,
): Promise<Uint8Array> {
  const { data, error } = await client.storage.from(STORAGE_BUCKET).download(document.storage_path);

  if (error || !data) {
    // A 404 here is the ordinary case of "the client asked us to process a document it
    // never finished uploading", so it is separated from a transport failure: the first
    // is permanent, the second is worth retrying.
    const status = (error as { statusCode?: string | number } | null)?.statusCode;
    const missing = String(status ?? '') === '404' || String(status ?? '') === '400';
    logger.warn('document object unavailable', {
      document_id: document.id,
      organization_id: document.organization_id,
      bucket: STORAGE_BUCKET,
      reason: missing ? 'object_missing' : 'download_failed',
    });
    if (missing) throw new PermanentJobError('document_object_missing', { cause: error });
    throw new RetryableJobError('storage_download_failed', { cause: error });
  }

  return new Uint8Array(await data.arrayBuffer());
}

async function proposeFields(
  text: string,
  options: ExtractFieldsOptions | undefined,
  signal: AbortSignal | undefined,
) {
  try {
    return await extractDocumentFields(text, {
      ...(options ?? {}),
      ...(signal ? { signal } : {}),
    });
  } catch (thrown) {
    // A fence failure means the document text could not be safely delimited. That is a
    // property of the text, so it will recur: permanent, and loud.
    if (thrown instanceof FenceIntegrityError) {
      throw new PermanentJobError('fence_integrity_failed', { cause: thrown });
    }
    throw thrown;
  }
}

/**
 * Writes `documents.extracted_text`.
 *
 * Its own statement, before the envelope, so a later provider failure still leaves the
 * document's text available to a human verifier. The job will be retried and will
 * re-propose the fields; the text does not need re-extracting to be useful.
 */
async function persistExtractedText(
  client: PrivilegedSupabaseClient,
  documentId: string,
  text: string,
): Promise<void> {
  const { error } = await client
    .from('documents')
    .update({ extracted_text: text })
    .eq('id', documentId)
    // Belt and braces against a concurrent human verification landing mid-job: a
    // document that stopped being `pending` must not receive machine output.
    .eq('verification_status', 'pending');

  if (error) throw new RetryableJobError('database_write_failed', { cause: error });
}

/**
 * Writes `documents.extracted_data`.
 *
 * The update names exactly one column. `verification_status` is absent from the patch —
 * not set to `'pending'`, absent — so there is no value of any variable in this process
 * that could move the document's state.
 */
async function persistEnvelope(
  client: PrivilegedSupabaseClient,
  documentId: string,
  envelope: DocumentExtractionEnvelope,
): Promise<void> {
  const { error } = await client
    .from('documents')
    .update({ extracted_data: envelope as unknown as Json })
    .eq('id', documentId)
    .eq('verification_status', 'pending');

  if (error) throw new RetryableJobError('database_write_failed', { cause: error });
}
