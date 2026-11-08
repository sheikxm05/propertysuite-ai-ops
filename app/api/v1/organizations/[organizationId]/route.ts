/**
 * `GET /api/v1/organizations/{organizationId}` — one organization.
 *
 * The path parameter is validated as a UUID and then used only as a **filter over rows
 * the caller can already see**. It is never the source of the caller's organization
 * identity: that comes from `ctx.membership`, resolved from trusted rows. Asking for
 * another organization's id therefore returns 404, not 403 — the caller learns nothing
 * about whether it exists (CLAUDE.md rule 5, and goal 1 made visible).
 *
 * There is deliberately no PATCH and no DELETE. See the header of `../route.ts`.
 */

import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { assertAuthorized } from '@/lib/auth/authorize';
import { resolveMembershipFor } from '@/lib/auth/roles';
import { OrganizationPathParamsSchema, OrganizationSchema } from '@shared/index';

const ORGANIZATION_COLUMNS = 'id, name, slug, status, created_at';

export const GET = withApiHandler({}, async (ctx) => {
  const { organizationId } = OrganizationPathParamsSchema.parse(ctx.params);

  // Membership in the *requested* organization, validated against the set the caller
  // actually holds. A non-member gets null here and never reaches the query.
  const membership = await resolveMembershipFor(ctx.session.userId, organizationId, ctx.supabase);
  if (!membership) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'not_a_member' } });
  }

  assertAuthorized(membership, 'read', { type: 'organization', organizationId });

  const { data, error } = await ctx.supabase
    .from('organizations')
    .select(ORGANIZATION_COLUMNS)
    .eq('id', organizationId)
    .maybeSingle();

  throwIfPostgresError(error);
  if (!data) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'organization_not_visible' } });
  }

  return ok(OrganizationSchema.parse(data), ctx.requestId);
});
