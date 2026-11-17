/**
 * The typed bridge to `public.outbound_messages`, and the only two writes this lane
 * performs against it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Migration `0006` creates `public.outbound_messages`. It is not applied, and
 * `packages/shared/types/database.ts` — lane w0-l4's file, frozen at the post-`0003`
 * schema — does not describe it. No lane in this wave owns that generated file, so
 * `supabase.from('outbound_messages')` does not typecheck anywhere in the repository,
 * for anyone. That is a planning defect and it is reported as one.
 *
 * This module is the bounded workaround, and it is deliberately the *same* workaround
 * `features/inbox/domain/wave-three.ts` already applies to `inbound_messages` — one
 * documented pattern rather than two improvised ones:
 *
 *   - Every declaration is transcribed from the `0006` column list, column by column.
 *     Nothing is inferred and nothing is widened: `provider_message_id` is nullable
 *     because the id does not exist until the provider has accepted the send, and
 *     `sent_at` is nullable for the same reason.
 *   - It is a *type* assertion over the same runtime client. No second client is
 *     constructed, no key changes hands, and Row Level Security is in force exactly as
 *     before. This changes what the compiler believes, not what Postgres enforces.
 *   - When `database.ts` is regenerated, deleting this file and dropping the
 *     `outboundTable(x)` wrapper is the entire migration.
 *
 * WHY THE WRITES TAKE A SERVICE-ROLE CLIENT
 * -----------------------------------------
 * `0004` revoked INSERT and UPDATE on `inbound_messages` from `authenticated` outright,
 * with the reasoning written into the migration: a client that could edit the row could
 * forge the evidence an AI decision was based on. `outbound_messages` is the same kind
 * of row on the way out — it is the record of what this organization said to a tenant,
 * and `sent_by_profile_id` is the name attached to it — so this lane assumes the same
 * grant shape and writes through the service-role client the privileged handler
 * supplies.
 *
 * Both writes carry an explicit `organization_id` taken from `ctx.membership`, which is
 * derived from trusted rows by `resolveMembership()` (CLAUDE.md rule 5). A privileged
 * query without its own scope clause is the defect these two functions are written to
 * avoid: RLS is bypassed here, so the filter in the statement is the only boundary left.
 *
 * Nothing in this file logs `body`. It is a message to a tenant (CLAUDE.md rule 8).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { ApiRouteError } from '@/lib/api/errors';
import type { Logger } from '@/lib/observability/logger';
import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

/* ------------------------------------------------------------- vocabulary -- */

/**
 * `outbound_messages.kind` — the `0006` CHECK constraint.
 *
 * This lane writes exactly one of the two. `acknowledgement` belongs to the automatic
 * path that answers an inbound message the moment it lands; `staff_reply` is a person
 * typing to a tenant. A background job must not be able to reach a value that stands for
 * a human's words, and this route must not be able to reach one that stands for a
 * machine's.
 */
export const OUTBOUND_MESSAGE_KINDS = ['acknowledgement', 'staff_reply'] as const;
export type OutboundMessageKind = (typeof OUTBOUND_MESSAGE_KINDS)[number];

/**
 * `outbound_messages.drafted_by` — the `0006` CHECK constraint.
 *
 * Provenance of the *text*, never of the authority to send it. `sent_by_profile_id` is
 * the authenticated caller in every case, including `'ai'`: the label says a model
 * produced the wording, not that a model decided to send it. See `draftProvenance()` in
 * `./reply-guards.ts` for how `'ai'` is earned and what it cannot be used to claim.
 */
export const OUTBOUND_DRAFTED_BY = ['system', 'ai', 'human'] as const;
export type OutboundDraftedBy = (typeof OUTBOUND_DRAFTED_BY)[number];

/** `outbound_messages.status` — the `0006` CHECK constraint. Default `queued`. */
export const OUTBOUND_MESSAGE_STATUSES = ['queued', 'sent', 'failed'] as const;
export type OutboundMessageStatus = (typeof OUTBOUND_MESSAGE_STATUSES)[number];

/* ------------------------------------------------------------------ types -- */

/** `public.outbound_messages`, migration `0006`. */
export type OutboundMessageRow = {
  id: string;
  organization_id: string;
  inbound_message_id: string | null;
  tenant_id: string | null;
  to_identifier: string;
  /** What was said to the tenant. Never logged, never audited (CLAUDE.md rule 8). */
  body: string;
  kind: string;
  drafted_by: string;
  sent_by_profile_id: string | null;
  provider: string;
  provider_message_id: string | null;
  status: string;
  created_at: string;
  sent_at: string | null;
};

export type OutboundMessageInsert = {
  id?: string;
  organization_id: string;
  inbound_message_id?: string | null;
  tenant_id?: string | null;
  to_identifier: string;
  body: string;
  kind: OutboundMessageKind;
  drafted_by: OutboundDraftedBy;
  sent_by_profile_id?: string | null;
  provider?: string;
  provider_message_id?: string | null;
  status?: OutboundMessageStatus;
  sent_at?: string | null;
};

export type OutboundMessageUpdate = {
  status?: OutboundMessageStatus;
  provider_message_id?: string | null;
  sent_at?: string | null;
};

/**
 * The `0006` surface this lane touches — one table, no functions.
 *
 * `type`, not `interface`, and the distinction is not stylistic: `GenericTable` requires
 * `Row: Record<string, unknown>`, TypeScript gives a type alias an implicit index
 * signature and an interface none, and declared as an interface the whole schema
 * silently resolves to `never` for every `insert` and `update`. The same note is on
 * `features/inbox/domain/wave-three.ts`, which learned it the hard way.
 */
export type OutboundDatabase = {
  public: {
    Tables: {
      outbound_messages: {
        Row: OutboundMessageRow;
        Insert: OutboundMessageInsert;
        Update: OutboundMessageUpdate;
        Relationships: [];
      };
    };
    /** `{ [_ in never]: never }`, not `Record<string, never>` — see `wave-three.ts`. */
    Views: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
    Functions: { [_ in never]: never };
  };
};

export type OutboundClient = SupabaseClient<OutboundDatabase>;

/** The same runtime client, seen through the `0006` schema. */
export function outboundTable(supabase: PrivilegedSupabaseClient): OutboundClient {
  return supabase as unknown as OutboundClient;
}

/* ----------------------------------------------------------------- writes -- */

export interface QueueReplyInput {
  readonly organizationId: string;
  readonly inboundMessageId: string;
  readonly tenantId: string | null;
  /** The tenant's number, read from the inbound row. Never from the request. */
  readonly toIdentifier: string;
  /** The operator's words, from the request body. Never from a model. */
  readonly body: string;
  readonly draftedBy: OutboundDraftedBy;
  /** The authenticated caller. Always present, whatever `draftedBy` says. */
  readonly sentByProfileId: string;
}

/**
 * Writes the `queued` row, before anything is handed to the provider.
 *
 * The order matters and is the reason this function exists separately from the send. A
 * send that happened with no row is a message to a tenant that the organization has no
 * record of; a row that exists with nothing sent is a `failed` row, which is merely
 * untidy. So the row is written first and the id it returns becomes the send's
 * idempotency key — a retry after a crash between "sent" and "recorded" reuses the key
 * and the adapter declines to deliver twice.
 */
export async function queueStaffReply(
  serviceRole: PrivilegedSupabaseClient,
  logger: Logger,
  input: QueueReplyInput,
): Promise<OutboundMessageRow> {
  const { data, error } = await outboundTable(serviceRole)
    .from('outbound_messages')
    .insert({
      organization_id: input.organizationId,
      inbound_message_id: input.inboundMessageId,
      tenant_id: input.tenantId,
      to_identifier: input.toIdentifier,
      body: input.body,
      kind: 'staff_reply',
      drafted_by: input.draftedBy,
      sent_by_profile_id: input.sentByProfileId,
      provider: 'whatsapp',
      status: 'queued',
    })
    .select('*')
    .single();

  if (error || !data) {
    // PostgREST error text can quote the row it refused, and the row carries the
    // message body. The reason code is ours and is enough to find the statement.
    logger.warn('outbound reply could not be queued', { reason: 'outbound_insert_failed' });
    throw new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'outbound_insert_failed' } });
  }

  return data;
}

/**
 * Records the provider's answer against a row that already exists.
 *
 * Never throws. By the time this runs the message has either reached the tenant or been
 * refused, and neither outcome can be undone by failing the request — returning 500
 * after a successful send would invite a retry that messages the tenant twice. The
 * failure is logged with the request's correlation id instead, which is the same bargain
 * `lib/audit/write.ts` makes for the same reason.
 */
export async function settleStaffReply(
  serviceRole: PrivilegedSupabaseClient,
  logger: Logger,
  input: {
    readonly organizationId: string;
    readonly outboundMessageId: string;
    readonly status: Extract<OutboundMessageStatus, 'sent' | 'failed'>;
    readonly providerMessageId?: string | null;
  },
): Promise<void> {
  const patch: OutboundMessageUpdate = { status: input.status };
  if (input.status === 'sent') {
    patch.provider_message_id = input.providerMessageId ?? null;
    patch.sent_at = new Date().toISOString();
  }

  const { error } = await outboundTable(serviceRole)
    .from('outbound_messages')
    .update(patch)
    .eq('id', input.outboundMessageId)
    // RLS is bypassed on this client, so this clause is the only boundary left. It is
    // not redundant with the id filter: it is what makes the statement unable to touch
    // another organization's row even if the id were wrong.
    .eq('organization_id', input.organizationId);

  if (error) {
    logger.error('outbound reply status not recorded', {
      reason: 'outbound_status_update_failed',
      entity_id: input.outboundMessageId,
      status: input.status,
    });
  }
}
