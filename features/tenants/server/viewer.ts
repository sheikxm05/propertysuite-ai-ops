/**
 * The server-component equivalent of `withApiHandler`'s first two stages.
 *
 * A route handler gets `session` and `membership` from the wrapper. A server component
 * has no wrapper, so this resolves the same two things the same way — a **verified**
 * session (`auth.getUser()`, not a decoded cookie) and a membership derived from trusted
 * database rows by `resolveMembership()`.
 *
 * It is a convenience, not a security boundary. `middleware.ts` gates the `(dashboard)`
 * route group, every API route re-authorizes, and Row Level Security denies
 * independently — a page that forgot to call this would render nothing, because the
 * caller-scoped client it would have to build anyway returns no rows.
 *
 * Returns `null` rather than throwing when there is no session or no membership, so a
 * page can redirect and a dashboard widget can render its empty state. Both are
 * legitimate states: authenticated with an unaccepted invitation is one of them.
 */

import { resolveMembership } from '@/lib/auth/roles';
import { getSession } from '@/lib/auth/session';
import { createLogger } from '@/lib/observability/logger';
import { newRequestId } from '@/lib/observability/correlation';
import { createServerClient } from '@/lib/supabase/server';

import type { DataContext } from './context';

/** The signed-in viewer's data context, or `null` when there is nobody to serve. */
export async function resolveViewer(label: string): Promise<DataContext | null> {
  const supabase = await createServerClient();

  const session = await getSession(supabase);
  if (!session) return null;

  const membership = await resolveMembership(session.userId, supabase);
  if (!membership) return null;

  const logger = createLogger({
    requestId: newRequestId(),
    base: {
      route: label,
      organization_id: membership.organization.id,
      profile_id: membership.profile.id,
      role: membership.role,
    },
  });

  return { supabase, membership, logger };
}
