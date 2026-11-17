/**
 * `GET /api/v1/inbox/messages/{messageId}` — one inbound message in full.
 *
 * `readMessage()` returns `null` for a row that does not exist, a row in another
 * organization, and a row a tenant did not send. All three become the same 404, with the
 * same frozen message, because distinguishing them would answer "does this id exist
 * somewhere?" for anyone willing to enumerate.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { UuidSchema } from '@shared/index';
import {
  inboxContextFrom,
  readMessage,
  senderDirectory,
  toMessageDetailView,
} from '@/features/inbox/domain';

export const GET = withApiHandler({}, async (ctx) => {
  const messageId = UuidSchema.safeParse(ctx.params.messageId);
  if (!messageId.success) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'message_id_not_a_uuid' } });
  }

  const context = inboxContextFrom(ctx);
  const row = await readMessage(context, messageId.data);
  if (!row) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'inbound_message_not_visible' } });
  }

  const directory = await senderDirectory(context);
  return ok(toMessageDetailView(row, directory), ctx.requestId);
});
