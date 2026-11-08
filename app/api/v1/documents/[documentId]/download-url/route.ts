/**
 * `POST /api/v1/documents/{documentId}/download-url` — a 60-second read URL.
 *
 * `POST` rather than `GET` for a read, on purpose. Issuing a credential is a side
 * effect: it is rate-limited, it is audited, and it must never be cacheable or
 * prefetchable. A `GET` that mints a signed URL is a `GET` that a browser prefetcher, a
 * link scanner or an email client will trigger on the user's behalf.
 *
 * Unlike the upload URL, this TTL is real: `createSignedUrl(path, 60)` takes the
 * lifetime as an argument, and the frozen 60 seconds from §5.7 is what the token
 * actually carries. A leaked URL is useless a minute later.
 *
 * Three independent checks stand between a caller and an object:
 *
 *   1. RLS on `documents` decides whether the row is visible at all.
 *   2. `assertDocumentReadable` re-applies the §4 matrix — and, for a provider,
 *      amendment A7's `ticket_id is not null` clause, which is what keeps a provider out
 *      of tenancy contracts.
 *   3. `createDownloadUrl` re-checks that the stored path sits under the caller's own
 *      organization prefix before signing, and Storage's own SELECT policy checks the
 *      same prefix again when the URL is redeemed.
 *
 * Check 3 looks redundant after 1 and 2. It is the one that matters if `storage_path`
 * is ever corrupted: the row would pass RLS and the matrix while pointing into another
 * tenant's prefix, and only a path check catches that.
 */

import { DocumentPathParamsSchema } from '@shared/index';
import { withApiHandler } from '@/lib/api/with-handler';
import { ok } from '@/lib/api/responses';
import { assertDocumentReadable } from '@/features/documents/server/access';
import { createDownloadUrl, requireDocument } from '@/features/documents/server/documents-service';

export const POST = withApiHandler(
  {
    // Every role has some read on `documents`; which rows differs, and that is RLS's
    // and the matrix's decision, not a route's. See the list route for the same note.
    rateLimit: { key: 'documents:download-url', perMinute: 30 },
    audit: { action: 'document_download_url_issued', entityType: 'document' },
  },
  async (ctx) => {
    const { documentId } = DocumentPathParamsSchema.parse(ctx.params);

    const document = await requireDocument(ctx.supabase, documentId);
    await assertDocumentReadable(ctx.supabase, ctx.membership, document);

    const signed = await createDownloadUrl(ctx.supabase, document, ctx.membership);

    ctx.audit({
      entityId: document.id,
      metadata: {
        document_id: document.id,
        organization_id: document.organization_id,
        // The URL itself is never audited or logged: it is a bearer credential, and
        // `signed_url` is deliberately absent from the log allowlist.
        outcome: 'issued',
      },
    });

    return ok(
      { download_url: signed.url, expires_in_seconds: signed.expiresInSeconds },
      ctx.requestId,
    );
  },
);
