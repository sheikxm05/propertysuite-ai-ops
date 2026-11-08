/**
 * The AI conversation transcript.
 *
 * `ai_conversations` / `ai_messages` are evidence: what the model was told and what it
 * answered. Three properties hold, and each is enforced somewhere other than this file,
 * which is why this file can be short.
 *
 * 1. **A client can only append its own turn.** `0002`'s `ai_messages_insert_own_tenant`
 *    policy requires `sender_type = 'user'` and a conversation owned by the caller. So
 *    `recordUserTurn` uses the caller's client and cannot write anything else.
 * 2. **Assistant and system turns are server-written.** They need the service-role
 *    client, reached only through `withPrivilegedApiHandler`. That restriction is
 *    load-bearing, not incidental: a client able to forge an `assistant` or `system` turn
 *    could plant text that a later request replays as trusted instruction.
 * 3. **The transcript is never replayed into the model.** This is the strongest of the
 *    three and it is a property of the adapter, not of the policies: the only input to
 *    `AiProvider.classify` is the current request's fenced message. No stored row — forged
 *    or genuine — can become model context, because nothing ever reads one back into a
 *    prompt. `tests/ai/prompt-isolation.test.ts` asserts it.
 *
 * Nothing here logs `content`. It is a message body (CLAUDE.md rule 8).
 */

import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { Logger } from '@/lib/observability/logger';
import type { AppSupabaseClient, PrivilegedSupabaseClient } from '@/lib/supabase/types';
import type { Json } from '@shared/index';

/** `ai_conversations.channel` for a browser-originated intake. */
const WEB_CHANNEL = 'web';

/**
 * Finds or opens the caller's conversation.
 *
 * A supplied `conversationId` is authorized before use: it must exist in the caller's
 * organization **and** name the caller as `user_profile_id`. RLS would reject a foreign
 * conversation on the subsequent message insert anyway, but relying on that alone would
 * surface as an opaque 403 from a write rather than an honest 404 from a read, and would
 * leave the server-side half of the check unwritten.
 */
export async function ensureConversation(
  supabase: AppSupabaseClient,
  membership: Membership,
  conversationId: string | null | undefined,
): Promise<string> {
  const organizationId = membership.organization.id;

  if (conversationId) {
    const { data, error } = await supabase
      .from('ai_conversations')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('id', conversationId)
      .eq('user_profile_id', membership.profile.id)
      .maybeSingle();
    throwIfPostgresError(error);

    if (!data) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'conversation_not_owned_by_caller' },
      });
    }
    return data.id;
  }

  const { data, error } = await supabase
    .from('ai_conversations')
    .insert({
      organization_id: organizationId,
      user_profile_id: membership.profile.id,
      channel: WEB_CHANNEL,
      status: 'active',
    })
    .select('id')
    .single();
  throwIfPostgresError(error);

  if (!data) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'conversation_insert_returned_no_row' },
    });
  }
  return data.id;
}

/**
 * Appends the caller's own turn, as the caller.
 *
 * Mandatory: this is the record of what was sent to the model, and a draft whose input
 * was never recorded is not auditable. A failure therefore fails the request — nothing
 * has been created at this point, so there is nothing to leave half-done.
 */
export async function recordUserTurn(
  supabase: AppSupabaseClient,
  input: { organizationId: string; conversationId: string; content: string },
): Promise<void> {
  const { error } = await supabase.from('ai_messages').insert({
    organization_id: input.organizationId,
    conversation_id: input.conversationId,
    sender_type: 'user',
    content: input.content,
    metadata: {},
  });
  throwIfPostgresError(error);
}

/** Metadata stored beside a server-written turn. Ids, enums and counters only. */
export interface TurnMetadata {
  readonly [key: string]: Json;
}

/**
 * Appends a server-written turn with the service-role client.
 *
 * `serviceRole` is optional because `tryCreateServiceRoleClient` returns `null` when no
 * credential is configured — a developer running without a service key gets a working
 * draft and a warning, not a crash. The return value says whether the turn was stored, so
 * the caller can report the gap rather than assume it did not happen.
 *
 * Best-effort by design: the assistant turn is a record of a draft that creates nothing.
 * Failing the whole request because the *transcript* could not be appended would trade a
 * useful outcome for a bookkeeping one. The user turn, above, is not best-effort.
 */
export async function recordServerTurn(
  serviceRole: PrivilegedSupabaseClient | null | undefined,
  input: {
    organizationId: string;
    conversationId: string;
    senderType: 'assistant' | 'system';
    content: string;
    metadata: TurnMetadata;
  },
  logger: Logger,
): Promise<boolean> {
  if (!serviceRole) {
    logger.warn('server turn not recorded', {
      reason: 'service_role_unavailable',
      conversation_id: input.conversationId,
    });
    return false;
  }

  const { error } = await serviceRole.from('ai_messages').insert({
    organization_id: input.organizationId,
    conversation_id: input.conversationId,
    sender_type: input.senderType,
    content: input.content,
    metadata: input.metadata as Json,
  });

  if (error) {
    // Logged, not thrown: see the note above. `pg_code` and `reason` are allowlisted;
    // the raw message is not logged because it can echo row data.
    logger.warn('server turn not recorded', {
      reason: 'ai_message_insert_failed',
      pg_code: error.code ?? 'unknown',
      conversation_id: input.conversationId,
    });
    return false;
  }
  return true;
}
