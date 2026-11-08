/**
 * `GET /api/v1/organizations` — the organizations the caller belongs to.
 * `POST /api/v1/organizations` — create one through the `create_organization` RPC.
 *
 * Route ownership: §5.5 assigns `/api/v1/organizations` to lane w1-l1.
 *
 * Why there is no PATCH here. `organizations` is read-only for every role including
 * `organization_admin`: `0002` revokes writes outright and §5.9 records the decision as a
 * deliberate non-change — "there is no rename path in this build". `UpdateOrganizationSchema`
 * exists in `packages/shared` for a future wave; building a route against it would
 * produce a guaranteed 403 at the database and a confusing 500 above it.
 *
 * Why there is no audit option on the POST. `create_organization` calls `log_audit()`
 * inside its own transaction, so the audit row and the organization are committed
 * together. Declaring `audit` on the wrapper as well would write a *second* row for one
 * state change, which makes "one audit row per state change" false in the other
 * direction. Every mutation in this file is audited exactly once, in Postgres.
 */

import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import { created, paginated } from '@/lib/api/responses';
import { assertAuthorized } from '@/lib/auth/authorize';
import { withApiHandler } from '@/lib/api/with-handler';
import { createOrganization, describeRpcFailure } from '@/features/organizations/rpc';
import {
  CreateOrganizationSchema,
  OrganizationListResponseSchema,
  type CreateOrganizationInput,
  type Organization,
} from '@shared/index';

/** The organization columns `OrganizationSchema` requires. Never a star select. */
const ORGANIZATION_COLUMNS = 'id, name, slug, status, created_at';

/**
 * The caller's organizations.
 *
 * Not paginated: a membership set is tiny by construction and bounded by how many
 * organizations one person has been invited to. RLS on `organizations` restricts the
 * result to organizations the caller is an active member of, so the query carries no
 * `organization_id` filter of its own — there is nothing for the caller to supply and
 * nothing to be trusted.
 */
export const GET = withApiHandler({}, async (ctx) => {
  assertAuthorized(ctx.membership, 'read', {
    type: 'organization',
    organizationId: ctx.membership.organization.id,
  });

  const { data, error } = await ctx.supabase
    .from('organizations')
    .select(ORGANIZATION_COLUMNS)
    .order('created_at', { ascending: true });

  throwIfPostgresError(error);

  // Amendment A18: the one list envelope, built by `paginated()` and validated against
  // the frozen `OrganizationListResponseSchema`.
  //
  // `next_cursor` is `null` and `has_more` is `false` because this list is complete by
  // construction, not because pagination was forgotten — which is exactly the
  // distinction `has_more` exists to make.
  const rows = data ?? [];
  return paginated(rows, { nextCursor: null, hasMore: false, limit: rows.length }, ctx.requestId, {
    schema: OrganizationListResponseSchema,
  });
});

/**
 * Creates an organization and the caller's `organization_admin` membership.
 *
 * **Who may call this.** Any authenticated member. There is no role gate, because the
 * act of creating an organization cannot require a role *inside* one — and the RPC makes
 * the caller its administrator, so no privilege is being escalated within an existing
 * organization.
 *
 * **The onboarding caveat.** A user who has just signed up holds no membership at all,
 * and `withApiHandler` resolves membership before the handler runs, answering `FORBIDDEN`
 * when there is none. So this route serves a caller who already belongs somewhere (an
 * administrator standing up a second organization); first-time onboarding goes through
 * the server action in `app/(auth)/actions.ts`, which calls the same
 * `createOrganization()` function. Reported as a planning defect — the two transports
 * share one implementation precisely so they cannot drift.
 */
export const POST = withApiHandler(
  {
    bodySchema: CreateOrganizationSchema,
    rateLimit: { key: 'organizations:create', perMinute: 5 },
  },
  async (ctx) => {
    const body: CreateOrganizationInput = ctx.body;

    let organization: Organization;
    try {
      organization = await createOrganization(ctx.supabase, body);
    } catch (error) {
      throw describeRpcFailure(error);
    }

    if (!organization.id) {
      throw new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'rpc_returned_no_id' } });
    }

    ctx.logger.info('organization created', { organization_id: organization.id });

    return created(organization, ctx.requestId, {
      location: `/api/v1/organizations/${organization.id}`,
    });
  },
);
