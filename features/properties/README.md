# Properties and units — lane `w1-l2`

Owned paths: `app/api/v1/properties/**`, `app/(dashboard)/properties/**`,
`features/properties/**`, `tests/properties/**`.

`docs/**` is read-only to this lane, so these notes live here rather than under `docs/`.

## Routes

| Method  | Path                                               | Roles  | Notes                                 |
| ------- | -------------------------------------------------- | ------ | ------------------------------------- |
| `GET`   | `/api/v1/properties?cursor=&limit=&status=&q=`     | any    | Cursor page, default 25, maximum 100  |
| `POST`  | `/api/v1/properties`                               | staff  | `201` + `Location`                    |
| `GET`   | `/api/v1/properties/{propertyId}`                  | any    | `404` for anything unreachable        |
| `PATCH` | `/api/v1/properties/{propertyId}`                  | staff  | `status: 'archived'` archives         |
| `POST`  | `/api/v1/properties/{propertyId}/archive`          | staff  | Idempotent. The only removal path     |
| `GET`   | `/api/v1/properties/{propertyId}/units?cursor=`    | any    | `404` if the property is unreachable  |
| `POST`  | `/api/v1/properties/{propertyId}/units`            | staff  | `409` on a duplicate `unit_number`    |
| `GET`   | `/api/v1/properties/{propertyId}/units/{unitId}`   | any    | `404` unless the pair is true         |
| `PATCH` | `/api/v1/properties/{propertyId}/units/{unitId}`   | staff  | Carries the unit status machine       |

"staff" is `STAFF_ROLES` from `packages/shared` — `organization_admin`,
`property_manager` — the same set `is_org_staff()` resolves to in SQL.

The six routes in `docs/api-contracts.md` are all present. `archive`, the unit detail read
and the unit update are additions, required by tasks 1 and 2 of the briefing and absent
from `api-contracts.md`; the unit update path is the one `UpdateUnitSchema` documents in
`packages/shared`.

**There is no `DELETE`, anywhere.** `authenticated` holds the DELETE privilege on no table
in this database, so a delete would fail with `42501` rather than matching zero rows.
Removal is `properties.status = 'archived'` and `property_units.status = 'inactive'`.
`tests/properties/routes.test.ts` asserts that no route module exports a `DELETE`.

## Shapes

Request and response schemas all come from `@shared/index` and are never redefined:
`CreatePropertySchema`, `UpdatePropertySchema`, `ListPropertiesQuerySchema`,
`PropertyPathParamsSchema`, `CreateUnitSchema`, `UpdateUnitSchema`, `ListUnitsQuerySchema`,
`UnitPathParamsSchema`. The browser forms validate the *same objects* the route handlers
pass to `withApiHandler` as `bodySchema`.

Single-resource success bodies are `{ data }`, from `lib/api/responses.ts`. Failures are
the frozen `{ error: { code, message, request_id } }`.

**List bodies are `{ data, page_info: { next_cursor, has_more, limit } }` — ruling A18.**
Wave 0 shipped two incompatible list envelopes: `listResponseSchema` /
`PropertyListResponseSchema` in `packages/shared` (w0-l4) produce `{ data, page_info }`,
while `paginated()` in `lib/api/responses.ts` (w0-l5) produces a flat
`{ data, next_cursor }`. A18 ruled for the `packages/shared` shape: the contract package
wins over an implementation helper, and `has_more` carries information a cursor alone
cannot — on an RLS-filtered list a short page is normal, so without it a client cannot tell
"no next page" from "the server forgot the cursor".

`pageInfo()` in `cursor.ts` returns the frozen `PageInfo` type (`z.infer<typeof
PageInfoSchema>`), so the envelope is bound to the schema at compile time instead of being
restated. The bodies are emitted through `jsonResponse`, the single JSON writer, so
`X-Request-Id` and `cache-control: no-store` still apply; when w0-l5 updates `paginated()`
to this shape, each call site becomes a one-line change back to it.
`tests/properties/routes.test.ts` validates both real responses against
`PropertyListResponseSchema` and `UnitListResponseSchema`, and asserts the pre-A18 flat
shape is rejected, so a regression cannot pass quietly.

## Authorization

Enforced three times, each written as though the others are broken.

1. `roles` on the route — a coarse gate, before validation, so a 403 does not depend on a
   well-formed body.
2. `authorize()` from `lib/auth/authorize.ts`, per row, with the row's own
   `organization_id` — see `authorization.ts` for how a tenant's and a provider's path to a
   property is *proved* before the matrix is consulted, and why copying
   `membership.tenantId` into the reference unconditionally would quietly reduce this to a
   single layer.
3. Postgres RLS (`properties_select_*`, `property_units_update_staff`, …) from `0002`.

What each role sees, enforced in layers 2 and 3 independently:

| Role                 | Properties                                 | Units                        | Writes |
| -------------------- | ------------------------------------------ | ---------------------------- | ------ |
| `organization_admin` | the organization's portfolio               | all                          | yes    |
| `property_manager`   | the organization's portfolio               | all                          | yes    |
| `property_owner`     | only `owner_member_id = their membership`  | units of owned properties    | **no** |
| `tenant`             | only property reached by an active tenancy | only the leased unit         | no     |
| `service_provider`   | only property behind an assigned ticket    | only the ticket's unit       | no     |

A denied **read** is `404`, never `403`: an inaccessible row must be indistinguishable
from an absent one. A denied **write** on a row the caller may legitimately see — a
property owner editing their own property — is `403`.

## Two state rules

- **Property.** An archived property accepts only a status change. Adding a unit to one is
  `409`.
- **Unit.** `available → occupied | inactive`, `occupied → available`,
  `inactive → available`. `occupied → inactive` and `inactive → occupied` are deliberately
  absent, with reasons in `unit-status.ts`. An illegal edge is `409`; a legal edge by the
  wrong role is `403` — the same convention `docs/implementation-plan.md` §4 sets for the
  ticket machine.

## Owner association

`properties.owner_member_id` is validated server-side before the insert — same
organization, active membership, and a role in `OWNER_ASSOCIABLE_ROLES`. A `tenant` or a
`service_provider` is refused with `422`, because `owns_property()` grants property-wide
`SELECT` to whoever is named there and checks only that the membership is active. The
composite foreign key `(organization_id, owner_member_id)` is the database half; a
violation surfaces as `UNPROCESSABLE` 422, not 500.

Owner **names** come from `resolveMemberDisplayNames` in `lib/auth/roles.ts`, added by
w0-l5 in response to this lane's planning defect — `eslint.config.mjs` restricts the
`profiles` table by name to that module. It degrades rather than throws, returning no entry
for a profile the §4 matrix says the caller may not read, so the picker and the detail page
fall back to a `Member a1b2c3d4` label. `tests/properties/owner-options.test.ts` asserts
both the resolved and the withheld path, including that a tenant gets no name for a
neighbour even when the database hands the row back.

## Pagination

Cursor only. The sort key is always `(created_at, id)` — properties newest-first, units in
creation order. A keyset predicate is sent to PostgREST as a filter *string* in which `,`
`(` `)` are structural, and both halves of this key are a validated ISO instant and a
validated UUID, so the expression cannot be broken out of by construction rather than by
escaping. `cursor.ts` records why `unit_number` is not the unit sort key. `?q=` is reduced
to a character allowlist for the same reason.

## Testing

`npx vitest run tests/properties` — 191 assertions, no external service.

`lib/auth/authorize.ts` and all of `features/properties/**` are the real implementations
throughout; only the Supabase transport is a fake, and it is used adversarially — it
returns cross-organization and out-of-scope rows a correct database never would, so the
assertions show the application layer denying *without* RLS. That is the only way to tell
a present application-space check from a missing one.

The RLS half of the proof is `tests/rls/**` (lane `w0-l6`), behind the `PS_RLS` gate. This
lane has no anon or service_role key and makes no claim to have exercised it.
