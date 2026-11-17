/**
 * A typed view of the tables migrations `0004_agentic.sql` and `0006` add, held here
 * because lane w3-l1 is writing those migrations *concurrently with this lane*.
 * (`webhook_events` and `inbound_messages` come from 0004; `outbound_messages` from
 * 0006, which is not applied yet at the time of writing.)
 *
 * `packages/shared/types/database.ts` is generated from the applied schema and belongs
 * to w0-l4. It cannot contain `webhook_events` or `inbound_messages` until 0004 has
 * landed and been regenerated, which is after this lane ships. The options were:
 *
 *   (a) call `client.from('webhook_events')` and let it be a type error;
 *   (b) cast the client to `any` at each call site;
 *   (c) declare the two tables' shapes once, in one place, with one documented cast.
 *
 * (c) is here. It is a *single* `as unknown as` in `asAgenticClient`, so there is
 * exactly one line to delete when the generated types catch up — at which point
 * `AgenticClient` becomes `PrivilegedSupabaseClient` and every call site is unchanged.
 * (b) would scatter the same unsoundness across six files and lose the shapes; (a)
 * would mean the lane does not typecheck, which is not a deliverable.
 *
 * This is **not** a local copy of a shared type in the CLAUDE.md rule 4 sense: there is
 * nothing in `packages/shared` to copy yet. The column list below is the contract this
 * lane needs 0004 to provide, and it is reproduced verbatim in the planning-defect
 * report so the migration and this file can be diffed against each other rather than
 * discovered to differ at runtime.
 *
 * Both tables are service-role only: RLS enabled, zero policies, no grants to `anon` or
 * `authenticated` — the same posture `0003` gives `public.jobs`. Nothing below may be
 * reached with a caller-scoped client, and nothing in this directory may be imported by
 * a client component.
 */

import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

import type {
  InboundMessageStatus,
  OutboundDraftSource,
  OutboundMessageKind,
  OutboundMessageStatus,
} from '../whatsapp/constants';

/* ------------------------------------------------------------------- rows -- */

/**
 * `public.webhook_events` — the idempotency ledger.
 *
 * The load-bearing part is not a column; it is `unique (provider, event_id)`. Dedupe is
 * the constraint's job, never the application's: a `select`-then-`insert` leaves a
 * window in which two concurrent retries of one delivery both see nothing and both
 * proceed, and Meta retries aggressively enough to find that window. The insert is
 * issued unconditionally and a `23505` is read as "already processed".
 */
export type WebhookEventRow = {
  readonly id: string;
  readonly provider: string;
  readonly event_id: string;
  readonly received_at: string;
  readonly processed_at: string | null;
  readonly payload: unknown;
};

export type WebhookEventInsert = {
  readonly provider: string;
  readonly event_id: string;
  readonly received_at?: string;
  readonly processed_at?: string | null;
  readonly payload?: unknown;
};

/**
 * `public.inbound_messages` — the normalised message.
 *
 * `organization_id` is nullable and that nullability is a security property, not a
 * convenience: a message from a number no tenant owns has no organization, and the only
 * honest representation of that is `null`. See `sender-resolution.ts`.
 */
export type InboundMessageRow = {
  readonly id: string;
  readonly provider: string;
  readonly external_message_id: string;
  readonly from_identifier: string;
  readonly body: string;
  readonly received_at: string;
  readonly status: InboundMessageStatus;
  readonly organization_id: string | null;
  readonly ticket_id: string | null;
};

export type InboundMessageInsert = {
  readonly provider: string;
  readonly external_message_id: string;
  readonly from_identifier: string;
  readonly body: string;
  readonly received_at: string;
  readonly status: InboundMessageStatus;
  readonly organization_id?: string | null;
  readonly ticket_id?: string | null;
};

export type InboundMessageUpdate = {
  readonly status?: InboundMessageStatus;
  readonly organization_id?: string | null;
  readonly ticket_id?: string | null;
};

/**
 * `public.outbound_messages` — every message this system sends to a tenant (migration
 * 0006). The frozen interface, reproduced verbatim so that the migration and this file
 * can be diffed rather than discovered to differ at runtime:
 *
 *     id, organization_id not null, inbound_message_id, tenant_id,
 *     to_identifier, body, kind in ('acknowledgement','staff_reply'),
 *     drafted_by in ('system','ai','human'), sent_by_profile_id,
 *     provider default 'whatsapp', provider_message_id,
 *     status in ('queued','sent','failed') default 'queued',
 *     created_at, sent_at
 *
 * Two parts of that are load-bearing rather than descriptive.
 *
 * **`organization_id not null`.** An outbound message always has an owner, because we
 * only ever send to a number we resolved to exactly one tenant in exactly one
 * organization. The inbound side's `organization_id` is nullable precisely so that an
 * unattributable message can exist; the outbound side's is not, because an
 * unattributable *send* must not exist at all. The schema is the enforcement.
 *
 * **`unique (inbound_message_id) where kind = 'acknowledgement'`.** A partial unique
 * index, and the only thing preventing a retried job from messaging a tenant twice. The
 * in-memory idempotency store in `whatsapp/outbound.ts` cannot do this — it is
 * per-process and empty after a cold start — so the guarantee has to live in the
 * database. `23505` on the insert means "already acknowledged", which is success.
 */
export type OutboundMessageRow = {
  readonly id: string;
  readonly organization_id: string;
  readonly inbound_message_id: string | null;
  readonly tenant_id: string | null;
  readonly to_identifier: string;
  readonly body: string;
  readonly kind: OutboundMessageKind;
  readonly drafted_by: OutboundDraftSource;
  readonly sent_by_profile_id: string | null;
  readonly provider: string;
  readonly provider_message_id: string | null;
  readonly status: OutboundMessageStatus;
  readonly created_at: string;
  readonly sent_at: string | null;
};

export type OutboundMessageInsert = {
  readonly organization_id: string;
  readonly inbound_message_id?: string | null;
  readonly tenant_id?: string | null;
  readonly to_identifier: string;
  readonly body: string;
  readonly kind: OutboundMessageKind;
  readonly drafted_by: OutboundDraftSource;
  readonly sent_by_profile_id?: string | null;
  readonly provider?: string;
  readonly provider_message_id?: string | null;
  readonly status?: OutboundMessageStatus;
  readonly sent_at?: string | null;
};

/**
 * The only columns anything may change after the row exists.
 *
 * `body`, `kind`, `drafted_by`, `to_identifier` and `sent_by_profile_id` are absent on
 * purpose: this table is the record of what was sent to whom and on whose authority,
 * and a record that can be edited after the fact is not a record. Only the delivery
 * outcome is mutable.
 */
export type OutboundMessageUpdate = {
  readonly status?: OutboundMessageStatus;
  readonly provider_message_id?: string | null;
  readonly sent_at?: string | null;
};

/* ----------------------------------------------------------------- client -- */

/**
 * The minimal `Database` shape PostgREST's types need for these three tables. Only the
 * operations this lane performs are declared, so an accidental `delete()` on any of
 * them does not typecheck — which matters, because CLAUDE.md rule 6 forbids a DELETE
 * path and `inbound_messages` and `outbound_messages` are both tenant-scoped content.
 */
type AgenticDatabase = {
  public: {
    Tables: {
      webhook_events: {
        Row: WebhookEventRow;
        Insert: WebhookEventInsert;
        Update: Partial<WebhookEventInsert>;
        Relationships: [];
      };
      inbound_messages: {
        Row: InboundMessageRow;
        Insert: InboundMessageInsert;
        Update: InboundMessageUpdate;
        Relationships: [];
      };
      outbound_messages: {
        Row: OutboundMessageRow;
        Insert: OutboundMessageInsert;
        Update: OutboundMessageUpdate;
        Relationships: [];
      };
    };
    // `type`, not `interface`, and `{ [_ in never]: never }` rather than
    // `Record<never, never>`: PostgREST's `GenericSchema` constraint is satisfied by
    // implicit index signatures, which TypeScript infers for a type alias and
    // deliberately does not infer for an interface. An interface here silently fails
    // the constraint and every `.from()` call resolves to `never` — the exact shape the
    // generated `Database` in `packages/shared` already uses, for the same reason.
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

/** A service-role client narrowed to the 0004 tables. **Bypasses RLS.** */
export type AgenticClient = SupabaseClient<AgenticDatabase, 'public'>;

/**
 * The one cast.
 *
 * Runtime-identical — the same supabase-js client, the same PostgREST URL — so this
 * changes nothing about what is sent to the database. When
 * `packages/shared/types/database.ts` is regenerated after 0004 applies, delete this
 * function and the `AgenticDatabase` interface above; `AgenticClient` becomes an alias
 * for `PrivilegedSupabaseClient` and no call site moves.
 */
export function asAgenticClient(client: PrivilegedSupabaseClient): AgenticClient {
  return client as unknown as AgenticClient;
}

/** Postgres `unique_violation`. The duplicate-delivery signal. */
export const UNIQUE_VIOLATION = '23505';

/** Postgres `undefined_table`. Raised when 0004 has not been applied yet. */
export const UNDEFINED_TABLE = '42P01';

/** Reads a Postgres error code without touching the message, which can echo row data. */
export function pgCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}
