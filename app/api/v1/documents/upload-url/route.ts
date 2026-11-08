/**
 * `POST /api/v1/documents/upload-url` — an authorized, short-lived upload URL.
 *
 * The frozen contract (§5.7, amendment A5): bucket `documents`, path
 * `{organization_id}/{entity}/{uuid}.pdf`, `application/pdf` only, 10 MB cap, signed
 * URL TTL 60 seconds.
 *
 * **The organization comes from the session.** It is read from
 * `ctx.membership.organization.id`, which `resolveMembership()` derived from trusted
 * rows, and there is no field in `UploadUrlSchema` through which a caller could supply
 * one. That is CLAUDE.md rule 5, and in this route it is load-bearing twice over: the
 * organization id becomes path segment 1, and the storage policies derive *their*
 * authorization decision from that same segment. A client-supplied value here would be
 * a client-supplied value there.
 *
 * Nothing about the file name reaches the path. The stored object is a server-generated
 * UUID, which is also the `documents.id`, so the row and the object cannot drift apart
 * and there is no string in the path for a caller to traverse with. `file_name` is
 * validated and then used for nothing but the audit metadata's character count.
 *
 * Order of operations, and why:
 *
 *   1. authorize       — staff by the matrix; a provider by amendment A7's predicate
 *   2. validate        — the declared MIME, extension and size, a second time
 *   3. associations    — every id the caller named must be one they can see
 *   4. insert the row  — the authorization record, `verification_status` left to default
 *   5. sign the URL    — last, because it is the only step that can be retried safely
 *
 * Step 4 before step 5 means a signing failure leaves a `pending` row with no object.
 * That row is inert: the process route refuses a document whose object is missing, and
 * the list view shows it as awaiting upload. The reverse order would hand out a signed
 * URL for a path with no row behind it, and an uploaded object nothing can ever
 * reference — a worse outcome, and one with no record of who caused it.
 *
 * Magic bytes are **not** checked here, because there are no bytes yet. The client
 * uploads straight to Storage, so the first moment the real file can be inspected is
 * `POST /documents/{documentId}/process`, which probes the object's header before it
 * enqueues anything. See `probePdfHeader`.
 */

import { UploadUrlSchema, type UploadUrlInput } from '@shared/index';
import { withApiHandler } from '@/lib/api/with-handler';
import { created } from '@/lib/api/responses';
import { ApiRouteError } from '@/lib/api/errors';
import { DOCUMENT_UPLOAD_ROLES, authorizeUpload } from '@/features/documents/server/authorization';
import {
  assertAssociationsVisible,
  createUploadUrl,
  insertDocument,
  storageEntityFor,
  storagePathFor,
} from '@/features/documents/server/documents-service';
import { assertDeclaredUpload, isUploadValidationError } from '@/services/extraction';

export const POST = withApiHandler<UploadUrlInput>(
  {
    roles: DOCUMENT_UPLOAD_ROLES,
    bodySchema: UploadUrlSchema,
    // Tighter than the default: each call creates a row and a signed credential, so the
    // bucket is per-user and small enough that a script cannot paper the bucket with
    // orphan rows.
    rateLimit: { key: 'documents:upload-url', perMinute: 20 },
    audit: { action: 'document_upload_authorized', entityType: 'document' },
  },
  async (ctx) => {
    const organizationId = ctx.membership.organization.id;

    /* 1. authorize ---------------------------------------------------------- */
    const authorization = await authorizeUpload(ctx.membership, ctx.body, ctx.supabase);

    /* 2. validate the claim ------------------------------------------------- */
    // `UploadUrlSchema` enforced all three already. Repeating it keeps the rule inside
    // this lane's test surface rather than depending on a schema in another lane's file
    // staying exactly as strict as it is today.
    try {
      assertDeclaredUpload({
        content_type: ctx.body.content_type,
        file_name: ctx.body.file_name,
        size_bytes: ctx.body.size_bytes,
      });
    } catch (thrown) {
      if (isUploadValidationError(thrown)) {
        throw new ApiRouteError('UNPROCESSABLE', {
          message: 'The file must be a PDF of at most 10 MB.',
          logFields: { reason: thrown.reason },
          cause: thrown,
        });
      }
      throw thrown;
    }

    /* 3. associations ------------------------------------------------------- */
    // A provider's associations were settled by A7's predicate in step 1: ticket only,
    // already proven assigned. Re-checking visibility would be a second read of the
    // same row.
    if (authorization.kind === 'staff') {
      await assertAssociationsVisible(ctx.supabase, {
        ...(ctx.body.property_id ? { property_id: ctx.body.property_id } : {}),
        ...(ctx.body.tenancy_id ? { tenancy_id: ctx.body.tenancy_id } : {}),
        ...(ctx.body.ticket_id ? { ticket_id: ctx.body.ticket_id } : {}),
      });
    }

    /* 4. the row ------------------------------------------------------------ */
    const ticketId =
      authorization.kind === 'provider_evidence'
        ? authorization.ticketId
        : (ctx.body.ticket_id ?? null);

    // One identifier for the row and the object. `crypto.randomUUID` rather than
    // anything derived from the request: a predictable object name would let a caller
    // guess another document's path, and the storage SELECT policy is organization
    // -scoped rather than row-scoped.
    const documentId = crypto.randomUUID();
    const storagePath = storagePathFor(organizationId, ticketId, documentId);

    const document = await insertDocument(ctx.supabase, {
      id: documentId,
      organizationId,
      documentType: ctx.body.document_type,
      storagePath,
      uploadedBy: ctx.membership.profile.id,
      // A provider is forbidden both by A7's policy and by step 1; pinning them to null
      // here means the insert cannot carry them even if step 1 is later loosened.
      propertyId:
        authorization.kind === 'provider_evidence' ? null : (ctx.body.property_id ?? null),
      tenancyId: authorization.kind === 'provider_evidence' ? null : (ctx.body.tenancy_id ?? null),
      ticketId,
    });

    /* 5. the credential ----------------------------------------------------- */
    const signed = await createUploadUrl(ctx.supabase, document.storage_path);

    ctx.audit({
      entityId: document.id,
      metadata: {
        document_id: document.id,
        organization_id: organizationId,
        // Identifiers and decisions only. Not the file name, which is user text, and
        // not the storage path, which is deliberately absent from the log allowlist.
        entity_type: storageEntityFor(ticketId),
        verification_status: document.verification_status,
        ...(ticketId ? { ticket_id: ticketId } : {}),
        ...(document.property_id ? { property_id: document.property_id } : {}),
        ...(document.tenancy_id ? { tenancy_id: document.tenancy_id } : {}),
      },
    });

    ctx.logger.info('upload url issued', {
      document_id: document.id,
      organization_id: organizationId,
      outcome: 'issued',
    });

    return created(
      {
        document_id: document.id,
        storage_path: document.storage_path,
        upload_url: signed.url,
        expires_in_seconds: signed.expiresInSeconds,
      },
      ctx.requestId,
      { location: `/api/v1/documents/${document.id}` },
    );
  },
);
