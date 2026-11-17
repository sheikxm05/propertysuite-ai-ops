/**
 * The typed bridge to the Wave 3 tables and functions.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `packages/shared/types/database.ts` is lane w0-l4's file, frozen at the post-`0003`
 * schema. Migration `0004_agentic.sql` (lane w3-l1) adds `public.inbound_messages`, the
 * agent tables and three new functions, and **no lane in Wave 3 owns the generated types
 * file**: w3-l1 owns the SQL and nothing else, and `packages/shared/**` is read-only to
 * every Wave 3 lane. So `supabase.from('inbound_messages')` does not typecheck anywhere
 * in the repository, for anyone. That is a planning defect and it is reported as one.
 *
 * This module is the bounded workaround until `database.ts` is regenerated:
 *
 *   - Every declaration below is transcribed from `0004_agentic.sql`, column by column
 *     and signature by signature — not inferred, not guessed. `body` is nullable because
 *     the column is `text` with no `not null`; `status` is the frozen vocabulary
 *     `services/integrations` owns, imported rather than copied.
 *   - It redeclares nothing that already exists in `packages/shared` (CLAUDE.md rule 4).
 *     There is nothing there to copy: `0004` landed after the types were frozen.
 *   - It is a *type* assertion over the same runtime client. No second client is
 *     constructed, no key changes hands, and Row Level Security is in force exactly as
 *     before: this changes what the compiler believes, not what Postgres enforces.
 *   - When `database.ts` is regenerated, deleting this file and dropping the
 *     `waveThree(x)` wrappers is the entire migration.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AppSupabaseClient, PrivilegedSupabaseClient } from '@/lib/supabase/types';

/**
 * `inbound_messages.status` — six values, frozen by the orchestrator and enforced by a
 * CHECK constraint in `0004_agentic.sql`:
 * `received | unmatched | classified | linked | ignored | failed`.
 *
 * Re-exported from `services/integrations`, never redeclared (CLAUDE.md rule 4). This
 * lane and w3-l6 each independently pinned an overlapping-but-different vocabulary; the
 * orchestrator reconciled them and w3-l6's constant is the survivor. Importing it rather
 * than copying it is what makes a future amendment a compile error here instead of a
 * 23514 at runtime.
 *
 * This lane writes exactly two of the six — `linked` and `ignored` — because both stand
 * for a person's decision. `received`, `classified` and `unmatched` belong to the
 * ingestion path; a background job must not be able to reach a state that represents a
 * human's choice, and this lane must not reach one that represents resolution.
 */
export { INBOUND_MESSAGE_STATUSES, type InboundMessageStatus } from '@/services/integrations';

import type { InboundMessageStatus as Status } from '@/services/integrations';

/**
 * `public.inbound_messages`, migration `0004` §5.
 *
 * `organization_id` is nullable because a message from a number that resolves to no
 * tenant belongs to no organization — and the SELECT policy carries
 * `organization_id is not null`, so an unattributed row is visible to **no** organization
 * rather than leaking to the first one that asks. `ticket_id` is nullable because a
 * message becomes a ticket only after a human says so.
 */
/*
 * `type`, not `interface`, for all four of these — and the distinction is not stylistic.
 * `GenericTable` requires `Row: Record<string, unknown>`, and TypeScript gives a type
 * alias an implicit index signature while an interface gets none. Declared as interfaces,
 * the schema silently fails `GenericSchema`, `Schema` resolves to `never`, and every
 * `insert`, `update` and `rpc` call below stops typechecking with an argument of type
 * `never`. The reads keep working, which is what makes it confusing.
 */
export type InboundMessageRow = {
  id: string;
  organization_id: string | null;
  provider: string;
  external_message_id: string;
  from_identifier: string;
  /** The tenant's own words. Nullable, and never logged — CLAUDE.md rule 8. */
  body: string | null;
  received_at: string;
  status: string;
  ticket_id: string | null;
};

export type InboundMessageInsert = {
  id?: string;
  organization_id?: string | null;
  provider: string;
  external_message_id: string;
  from_identifier: string;
  body?: string | null;
  received_at?: string;
  status?: Status;
  ticket_id?: string | null;
};

export type InboundMessageUpdate = {
  status?: Status;
  ticket_id?: string | null;
  organization_id?: string | null;
};

/** One row of `public.tenant_contact(uuid, uuid)`. */
export type TenantContactRow = {
  tenant_id: string;
  email: string | null;
  phone: string | null;
};

/**
 * The `0004` surface this lane touches.
 *
 * `agent_proposals` is deliberately absent, and so are `approve_agent_proposal` and
 * `reject_agent_proposal`. This lane never reads, writes or decides that table: a
 * proposal reaches the screen in the body of `POST /api/v1/ai/agent/run`, and the
 * browser posts a decision to lane w3-l4's own endpoints, which hold the RPC calls and
 * the audit rows. Typing something we must not touch would be an invitation to touch
 * it.
 */
export type WaveThreeDatabase = {
  public: {
    Tables: {
      inbound_messages: {
        Row: InboundMessageRow;
        Insert: InboundMessageInsert;
        Update: InboundMessageUpdate;
        Relationships: [];
      };
    };
    /**
     * `{ [_ in never]: never }`, not `Record<string, never>`.
     *
     * The generated types in `packages/shared` spell empty maps this way and the
     * difference is load-bearing: `Record<string, never>` carries a string index
     * signature, so PostgREST's table resolution finds `inbound_messages` in `Views` as
     * well as in `Tables`, resolves the pair to `never`, and every `insert` and `update`
     * silently stops typechecking.
     */
    Views: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
    Functions: {
      /**
       * The ONE read path for `tenants.email` and `tenants.phone`.
       *
       * `0004` §1 revokes the table-level SELECT on `tenants` from `authenticated` and
       * grants back every column except those two, because row level security filters
       * rows and cannot withhold a column — a `service_provider` holding an assigned
       * ticket could read the tenant's phone number straight out of PostgREST. This
       * function answers for organization staff and for the tenant themselves, and
       * raises 42501 for everyone else.
       *
       * `p_tenant_id` is nullable and means "every tenant in this organization the
       * caller may see", so a directory is one round trip rather than one per row.
       */
      tenant_contact: {
        Args: { p_organization_id: string; p_tenant_id?: string | null };
        Returns: TenantContactRow[];
      };
    };
  };
};

export type WaveThreeClient = SupabaseClient<WaveThreeDatabase>;

/**
 * The same client, seen through the `0004` schema.
 *
 * Accepts either flavour because `0004` splits the work: a caller-scoped client does
 * every read (RLS in force), and the service-role client does the two status writes —
 * `0004` revokes INSERT and UPDATE on `inbound_messages` from `authenticated` outright,
 * so there is no caller-scoped write path to use even if we wanted one. Both are passed
 * explicitly at the call site, so which one is in play is always visible in the code.
 */
export function waveThree(supabase: AppSupabaseClient | PrivilegedSupabaseClient): WaveThreeClient {
  return supabase as unknown as WaveThreeClient;
}
