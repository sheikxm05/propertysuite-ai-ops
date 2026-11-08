/**
 * `GET /api/v1/properties` and `POST /api/v1/properties`
 *
 * Both routes are exactly as specified in `docs/api-contracts.md`, including the
 * create-property body, which is `CreatePropertySchema` from `@shared/index` — the same
 * schema `features/properties/property-form.tsx` validates against in the browser. There
 * is no second definition of it anywhere (CLAUDE.md rule 4).
 *
 * `withApiHandler` supplies authentication, the coarse role gate, Zod validation, rate
 * limiting, the audit row and the frozen error envelope. Nothing in this file re-does any
 * of that. The resource-level decision — which properties this role may see, and whether
 * it may write — is `features/properties/service.ts` plus `authorize()`, because the
 * wrapper cannot make it: it has not read the row.
 *
 * There is no `DELETE` export, and there is no route that could be given one.
 * `authenticated` holds the DELETE privilege on no table in this database, so a delete
 * would fail at the privilege level rather than at the policy level. Removal is
 * `POST /api/v1/properties/{propertyId}/archive`.
 */

import { created, jsonResponse } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { pageInfo } from '@/features/properties/cursor';
import { createProperty, listProperties } from '@/features/properties/service';
import {
  CreatePropertySchema,
  ListPropertiesQuerySchema,
  STAFF_ROLES,
  type CreatePropertyInput,
  type ListPropertiesQuery,
} from '@shared/index';

/**
 * List accessible properties, cursor-paginated.
 *
 * No `roles` gate: every role has *some* property read in the §4 matrix, and what differs
 * is the visible set, not the right to ask. `resolveVisibilityScope` narrows the
 * statement and `authorize()` re-checks every row that comes back, so a tenant's list is
 * their leased property and a provider's is their assigned job's property — enforced here
 * as well as by RLS.
 */
export const GET = withApiHandler<undefined, ListPropertiesQuery>(
  { querySchema: ListPropertiesQuerySchema },
  async (ctx) => {
    const page = await listProperties(ctx.supabase, ctx.membership, ctx.query);

    // RULING A18: the list envelope is `{ data, page_info }`, as `listResponseSchema` and
    // `PropertyListResponseSchema` in `packages/shared` define it. `pageInfo()` returns the
    // frozen `PageInfo` type, so the shape is bound to the schema at compile time rather
    // than restated here.
    //
    // Emitted through `jsonResponse` — the single JSON writer, so `X-Request-Id` and
    // `cache-control: no-store` still apply — and NOT through `lib/api/responses.ts`'s
    // `paginated()`, which still returns the flat `{ data, next_cursor }` that A18
    // overruled. When w0-l5 updates `paginated()` to emit this shape, this call site
    // becomes a one-line change back to it.
    return jsonResponse({ data: page.rows, page_info: pageInfo(page) }, ctx.requestId);
  },
);

/**
 * Create a property.
 *
 * `roles: STAFF_ROLES` is the coarse gate — `['organization_admin','property_manager']`
 * from `packages/shared`, the same set `is_org_staff()` resolves to in SQL, so the gate
 * and the policy cannot drift. A `property_owner` is refused here before a statement is
 * built, and refused again by `authorize()`, and a third time by
 * `properties_insert_staff`.
 *
 * `organization_id` is not in the body schema and is taken from the resolved membership.
 */
export const POST = withApiHandler<CreatePropertyInput, undefined>(
  {
    roles: STAFF_ROLES,
    bodySchema: CreatePropertySchema,
    audit: { action: 'property_created', entityType: 'property' },
  },
  async (ctx) => {
    const property = await createProperty(ctx.supabase, ctx.membership, ctx.body);

    ctx.audit({
      entityId: property.id,
      metadata: { property_id: property.id, status: property.status },
    });

    return created(property, ctx.requestId, { location: `/api/v1/properties/${property.id}` });
  },
);
