/**
 * `GET /api/v1/documents` — the documents the caller may see.
 *
 * No role gate. That is deliberate rather than an omission: all five roles have *some*
 * read on `documents` in the §4 matrix, and what differs is which rows, not whether.
 * Expressing "which rows" in a route's role list is impossible; it is expressed where it
 * can be, in the five `documents_select_*` policies and in `lib/auth/authorize.ts`.
 *
 * So the list route adds no filter of its own and trusts RLS to decide the row set —
 * then asserts the result. Every row that comes back is checked against the caller's
 * organization (`assertSameOrganization`) before it is serialised, so a policy
 * regression surfaces as a 500 in our logs rather than as organization B's contract on
 * organization A's screen. A filter would hide that; an assertion catches it.
 *
 * `extracted_text` is not selected and has no field in the response schema. A list
 * endpoint that returned document bodies would be a bulk exfiltration primitive wearing
 * a pagination parameter.
 */

import { ListDocumentsQuerySchema, type ListDocumentsQuery } from '@shared/index';
import { withApiHandler } from '@/lib/api/with-handler';
import { jsonResponse } from '@/lib/api/responses';
import { listDocuments } from '@/features/documents/server/documents-service';
import { toDocument } from '@/features/documents/server/presenter';

export const GET = withApiHandler<undefined, ListDocumentsQuery>(
  { querySchema: ListDocumentsQuerySchema },
  async (ctx) => {
    const page = await listDocuments(ctx.supabase, ctx.membership, ctx.query);

    ctx.logger.info('documents listed', {
      organization_id: ctx.membership.organization.id,
      count: page.items.length,
      limit: page.limit,
      outcome: 'ok',
    });

    // AMENDMENT A18. The list envelope was defined twice, incompatibly:
    // `listResponseSchema()` in `packages/shared` emits `{ data, page_info }` and
    // `paginated()` in `lib/api/responses.ts` emits `{ data, next_cursor }`. The
    // orchestrator ruled for the `packages/shared` shape — it is the frozen contract
    // source, and `has_more` carries information `next_cursor` alone cannot: on an
    // RLS-filtered list a short page is normal, so a client otherwise cannot tell "no
    // next page" from "the server forgot the cursor".
    //
    // Emitted through `jsonResponse` rather than a hand-rolled `Response`, so
    // `cache-control: no-store` and the `X-Request-Id` header still hold. When
    // `paginated()` is updated to match, this becomes a one-line change.
    return jsonResponse(
      {
        data: page.items.map(toDocument),
        page_info: {
          next_cursor: page.nextCursor,
          has_more: page.hasMore,
          limit: page.limit,
        },
      },
      ctx.requestId,
    );
  },
);
