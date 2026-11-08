/**
 * `POST /api/v1/documents/{documentId}/process` — enqueue extraction. `202 Accepted`.
 *
 * This route creates a job and nothing else. It does not parse the PDF, does not call a
 * model and does not touch `verification_status`. `202` is the honest status: the work
 * has been accepted, not done, and the response carries the job id so a client can
 * watch it rather than guess.
 *
 * **Magic bytes are checked here**, and this is the only place in the request path where
 * they can be. The client uploaded straight to Storage through a signed URL, so the
 * bytes never passed through the application — a declared `application/pdf` and a
 * `.pdf` extension are both just strings the caller chose. `probePdfHeader` issues a
 * 60-second signed read URL with the *caller's* client and fetches the first kibibyte
 * with a `Range` header, so a file that is secretly a ZIP, an HTML page or an
 * executable is rejected with `422` before a single job row exists. The worker checks
 * the signature again on the complete object, because staff can overwrite an object
 * between enqueue and run.
 *
 * Staff only. `documents_update_staff` is the sole UPDATE policy on the table, and
 * extraction writes `extracted_text` and `extracted_data`, so a role that cannot update
 * the row must not be able to queue a write to it. In particular a service provider who
 * uploaded evidence cannot trigger processing of it.
 *
 * Idempotency is the database's, not this route's: `jobs.idempotency_key` is `unique`
 * and defaults to `document_extraction:{documentId}`, so two concurrent clicks produce
 * one job and the second caller receives the first caller's job id with `202`. A
 * deliberate re-extraction needs a distinct key, which the body accepts — that is the
 * trade, and it is the right way round: accidental duplication is silent and common,
 * deliberate re-extraction is rare and should be explicit.
 */

import {
  DocumentPathParamsSchema,
  ProcessDocumentSchema,
  type ProcessDocumentInput,
} from '@shared/index';
import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { accepted } from '@/lib/api/responses';
import { ApiRouteError } from '@/lib/api/errors';
import { assertDocumentWritable } from '@/features/documents/server/access';
import { DOCUMENT_STAFF_ROLES } from '@/features/documents/server/authorization';
import { probePdfHeader, requireDocument } from '@/features/documents/server/documents-service';
import {
  DOCUMENT_EXTRACTION_JOB_TYPE,
  documentExtractionIdempotencyKey,
  enqueueJob,
} from '@/services/workers';

export const POST = withPrivilegedApiHandler<ProcessDocumentInput>(
  {
    roles: DOCUMENT_STAFF_ROLES,
    bodySchema: ProcessDocumentSchema,
    // Extraction costs a model call. The ceiling is per-user and low enough that a loop
    // cannot run up a bill before anybody notices.
    rateLimit: { key: 'documents:process', perMinute: 10 },
    audit: { action: 'document_extraction_enqueued', entityType: 'document' },
  },
  async (ctx) => {
    const { documentId } = DocumentPathParamsSchema.parse(ctx.params);

    const document = await requireDocument(ctx.supabase, documentId);
    await assertDocumentWritable(ctx.supabase, ctx.membership, document);

    // A decided document is not re-processed. Fresh model output beside a `verified`
    // badge would show unreviewed values as though a human had accepted them, and a
    // `rejected` document was rejected on purpose.
    if (document.verification_status !== 'pending') {
      throw new ApiRouteError('CONFLICT', {
        message: 'This document has already been reviewed.',
        logFields: {
          reason: 'document_already_decided',
          document_id: document.id,
          verification_status: document.verification_status,
        },
      });
    }

    /* magic bytes ----------------------------------------------------------- */
    const probe = await probePdfHeader(ctx.supabase, document, ctx.membership);
    if (!probe.ok) {
      if (probe.reason === 'object_missing') {
        throw new ApiRouteError('UNPROCESSABLE', {
          message: 'The file has not finished uploading yet.',
          logFields: { reason: 'document_object_missing', document_id: document.id },
        });
      }
      if (probe.reason === 'probe_failed') {
        throw new ApiRouteError('INTERNAL_ERROR', {
          logFields: { reason: 'header_probe_failed', document_id: document.id },
        });
      }
      // The message names the rule, never the sniffed format: telling a caller what
      // their file actually looked like turns this route into a file-type oracle.
      throw new ApiRouteError('UNPROCESSABLE', {
        message: 'The uploaded file is not a PDF.',
        logFields: { reason: probe.validation.reason, document_id: document.id },
        cause: probe.validation,
      });
    }

    /* enqueue --------------------------------------------------------------- */
    if (!ctx.serviceRole) {
      // `jobs` is service-role only by design (RLS on, zero policies). Without the
      // credential there is no queue, and pretending to accept the work would be worse
      // than saying so.
      throw new ApiRouteError('INTERNAL_ERROR', {
        logFields: { reason: 'job_queue_unavailable', document_id: document.id },
      });
    }

    const { job, created } = await enqueueJob(ctx.serviceRole, {
      type: DOCUMENT_EXTRACTION_JOB_TYPE,
      idempotencyKey: documentExtractionIdempotencyKey(
        document.id,
        ctx.body.idempotency_key ?? null,
      ),
      payload: {
        document_id: document.id,
        // Carried so the worker can cross-check the row it reads with a service-role
        // client. It is a check, never the scope — see the worker's header.
        organization_id: document.organization_id,
        requested_by: ctx.membership.profile.id,
      },
    });

    ctx.audit({
      entityId: document.id,
      metadata: {
        document_id: document.id,
        organization_id: document.organization_id,
        job_id: job.id,
        // Records that a duplicate request was deduplicated rather than dropped.
        outcome: created ? 'enqueued' : 'already_enqueued',
        verification_status: document.verification_status,
      },
    });

    ctx.logger.info('extraction enqueued', {
      document_id: document.id,
      organization_id: document.organization_id,
      job_id: job.id,
      status: job.status,
      outcome: created ? 'enqueued' : 'already_enqueued',
    });

    return accepted(
      {
        document_id: document.id,
        job_id: job.id,
        status: job.status,
      },
      ctx.requestId,
    );
  },
);
