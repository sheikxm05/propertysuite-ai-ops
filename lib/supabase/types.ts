/**
 * Client type aliases.
 *
 * `packages/shared/types/database.ts` (W0-L4) will export a generated `Database` type,
 * but §5.4 does not freeze that export's name or module path, so this lane cannot bind
 * to it without guessing. Every client in `lib/supabase/**` is therefore typed through
 * the aliases below. When the generated type lands, tightening it is a one-line change
 * in this file and nowhere else.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A request-scoped Supabase client carrying the caller's identity. Row Level Security
 * is in force: this is the client every route handler should use.
 */
export type AppSupabaseClient = SupabaseClient;

/**
 * A client authenticated with the service-role key. **Bypasses Row Level Security.**
 * Distinct from `AppSupabaseClient` so that a privileged client cannot be passed where
 * a caller-scoped one is expected without the type being written out deliberately.
 */
export type PrivilegedSupabaseClient = SupabaseClient & {
  readonly __privileged?: never;
};
