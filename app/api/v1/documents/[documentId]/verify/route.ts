/**
 * `POST /api/v1/documents/{documentId}/verify` — the human gate.
 *
 * Acceptance criterion 9 is "document extraction is marked unverified until a human
 * reviews it", and this route is the only thing in the codebase that can end that
 * state. Everything else about document intelligence — the queue, the parser, the
 * prompt, the model — produces a proposal. This produces a decision.
 *
 * What makes the gate real, rather than a comment claiming it is:
 *
 *  1. **`verification_status` is written here and nowhere else.** The extraction worker
 *     updates exactly two columns, `extracted_text` and `extracted_data`, and its
 *     envelope builder has no parameter that can produce a verification block. There is
 *     no model output path to a verified document, because there is no code that could
 *     carry one.
 *  2. **`confirmed: true` is a `z.literal`.** `VerifyDocumentSchema` in
 *     `packages/shared` rejects absent, `false` and truthy-but-not-`true`. A replayed or
 *     default-valued body is a 400, not a verification.
 *  3. **A verification carries the whole field set, including explicit nulls.**
 *     `VerifiedDocumentFieldsSchema` makes every field nullable but not optional, so
 *     "verified" means the reviewer stated a value for each one — including "this
 *     document does not say" — rather than having skipped the ones they did not read.
 *  4. **The stored values are the reviewer's, not the model's.** The request body is
 *     written to the envelope. They may be identical because the reviewer agreed; what
 *     is recorded is what the human sent, because that is what they are accountable for.
 *  5. **Compare-and-swap on `pending`.** Two reviewers racing produce one decision and
 *     one `409`. Last-write-wins would leave an audit trail showing two verifications of
 *     which only one took effect.
 *
 * And what this route deliberately does **not** do: it does not write `tenancies`. A
 * verified tenancy contract is a record of what a document says; its dates and rent
 * becoming a tenancy's actual terms is a separate decision by a human in the tenancy
 * screens. "A pending extraction must never flow into a tenancy record automatically" —
 * and nor must a verified one, silently. The only table this handler writes is
 * `documents`, which `tests/documents/verification-gate.test.ts` asserts by inspecting
 * every call the handler makes.
 */

import {
  DocumentPathParamsSchema,
  VerifyDocumentSchema,
  type VerifyDocumentInput,
} from '@shared/index';
import { withApiHandler } from '@/lib/api/with-handler';
import { ok } from '@/lib/api/responses';
import { ApiRouteError } from '@/lib/api/errors';
import { assertDocumentWritable } from '@/features/documents/server/access';
import { DOCUMENT_STAFF_ROLES } from '@/features/documents/server/authorization';
import { recordVerification, requireDocument } from '@/features/documents/server/documents-service';
import { toDocumentDetail } from '@/features/documents/server/presenter';
import { applyHumanRejection, applyHumanVerification, readEnvelope } from '@/services/extraction';

export const POST = withApiHandler<VerifyDocumentInput>(
  {
    roles: DOCUMENT_STAFF_ROLES,
    bodySchema: VerifyDocumentSchema,
    rateLimit: { key: 'documents:verify', perMinute: 30 },
    audit: { action: 'document_verification_decided', entityType: 'document' },
  },
  async (ctx) => {
    const { documentId } = DocumentPathParamsSchema.parse(ctx.params);

    const document = await requireDocument(ctx.supabase, documentId);
    await assertDocumentWritable(ctx.supabase, ctx.membership, document);

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

    const existing = readEnvelope(document.extracted_data);

    // `verifiedBy` comes from the resolved membership's profile id. There is no field
    // in the request schema for an actor, so a reviewer cannot attribute their decision
    // to somebody else.
    const envelope =
      ctx.body.verification_status === 'verified'
        ? applyHumanVerification(existing, {
            verifiedBy: ctx.membership.profile.id,
            fields: ctx.body.fields,
            note: ctx.body.note ?? null,
          })
        : applyHumanRejection(existing, {
            verifiedBy: ctx.membership.profile.id,
            reason: ctx.body.reason,
          });

    const updated = await recordVerification(ctx.supabase, {
      documentId: document.id,
      status: ctx.body.verification_status,
      envelope,
    });

    if (!updated) {
      // Zero rows from a compare-and-swap on `pending`: another reviewer decided while
      // this request was in flight. Their decision stands.
      throw new ApiRouteError('CONFLICT', {
        message: 'This document was reviewed by someone else a moment ago.',
        logFields: { reason: 'verification_race_lost', document_id: document.id },
      });
    }

    ctx.audit({
      entityId: updated.id,
      metadata: {
        document_id: updated.id,
        organization_id: updated.organization_id,
        // The decision and who made it. Never the field values: an audit row is
        // readable by an administrator and lives forever, and the accepted values are
        // tenant personal data (CLAUDE.md rule 8).
        verification_status: updated.verification_status,
        profile_id: ctx.membership.profile.id,
        outcome: 'decided',
      },
    });

    ctx.logger.info('document verification decided', {
      document_id: updated.id,
      organization_id: updated.organization_id,
      verification_status: updated.verification_status,
      profile_id: ctx.membership.profile.id,
      outcome: 'decided',
    });

    return ok(toDocumentDetail(updated), ctx.requestId);
  },
);
