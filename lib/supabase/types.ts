/**
 * Client type aliases.
 *
 * Every Supabase client in `lib/supabase/**` is typed through one of the two aliases
 * below, and both are bound to the generated `Database` type from
 * `packages/shared/types/database.ts`. Routing it through this file rather than naming
 * `SupabaseClient<Database>` at thirty call sites means a schema regeneration is a
 * one-line change here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/shared';

/**
 * A request-scoped Supabase client carrying the caller's identity. Row Level Security
 * is in force: this is the client every route handler should use.
 */
export type AppSupabaseClient = SupabaseClient<Database>;

/**
 * A client authenticated with the service-role key. **Bypasses Row Level Security.**
 * Structurally identical to `AppSupabaseClient`, but named separately so that handing a
 * privileged client to something expecting a caller-scoped one has to be written out
 * deliberately and shows up in review.
 */
export type PrivilegedSupabaseClient = SupabaseClient<Database>;
