/**
 * `GET /api/v1/documents/{documentId}` — one document, with its proposed fields.
 *
 * This is the verification screen's payload. It carries three things that have to be
 * kept distinct, and the response schema keeps them distinct by name:
 *
 *   `proposed_fields`      what the model suggested. A draft.
 *   `extracted_data`       the whole envelope, including source excerpts and — if a
 *                          human has decided — their accepted values.
 *   `is_verified`          derived from `documents.verification_status`, the column.
 *                          Never from anything inside `extracted_data`.
 *
 * `job_status` is why this route uses `withPrivilegedApiHandler`, and it is the only
 * reason. `public.jobs` has RLS enabled with **zero policies** and no grants to
 * `authenticated`, so there is no caller-scoped way to read it at all — the choice is a
 * service-role read or no job status. The document itself is read through
 * `ctx.supabase`, so RLS remains the first enforcement layer for the thing that
 * actually holds tenant data, and the privileged client touches exactly one table whose
 * rows contain no tenant data by design (`jobs` has no `organization_id`; see
 * migration 0003).
 *
 * The job is found by its idempotency key, which is derived from the document id — so
 * the privileged query is `where idempotency_key = 'document_extraction:<id>'` for an
 * id the caller has already been authorized to read. It cannot be pointed at anything
 * else.
 */

import { DocumentPathParamsSchema, type JobStatus } from '@shared/index';
import { withPrivilegedApiHandler } from '@/lib/api/server-only/privileged-handler';
import { ok } from '@/lib/api/responses';
import { assertDocumentReadable } from '@/features/documents/server/access';
import { requireDocument } from '@/features/documents/server/documents-service';
import { toDocumentDetail } from '@/features/documents/server/presenter';
import { documentExtractionIdempotencyKey, findJobByIdempotencyKey } from '@/services/workers';

export const GET = withPrivilegedApiHandler({}, async (ctx) => {
  const { documentId } = DocumentPathParamsSchema.parse(ctx.params);

  const document = await requireDocument(ctx.supabase, documentId);
  await assertDocumentReadable(ctx.supabase, ctx.membership, document);

  const jobStatus = await readJobStatus(ctx.serviceRole, documentId);

  ctx.logger.info('document read', {
    document_id: document.id,
    organization_id: document.organization_id,
    verification_status: document.verification_status,
    outcome: 'ok',
  });

  return ok(toDocumentDetail(document, { jobStatus }), ctx.requestId);
});

/**
 * The extraction job's status, or `null`.
 *
 * Returns `null` rather than throwing when no service-role credential is configured:
 * the verification screen is fully usable without a job status, and failing a read of
 * a document because a background queue is unreachable would be the wrong trade.
 */
async function readJobStatus(
  serviceRole: Parameters<typeof findJobByIdempotencyKey>[0] | undefined,
  documentId: string,
): Promise<JobStatus | null> {
  if (!serviceRole) return null;
  try {
    const job = await findJobByIdempotencyKey(
      serviceRole,
      documentExtractionIdempotencyKey(documentId),
    );
    return (job?.status as JobStatus | undefined) ?? null;
  } catch {
    // A queue lookup failure is not a reason to fail the document read.
    return null;
  }
}
