# `features/tenants` — tenant records

Lane **w1-l3**. Routes: `/api/v1/tenants`, pages: `/tenants`.

A `tenants` row is the organization's record **of** a person; a `profiles` row is that
person's own account. They are separate tables because a tenancy can exist before the
tenant ever signs in — `tenants.profile_id` is nullable, and linking it is what gives
that person their self-service view (`can_access_unit()` and `current_tenant_id()` both
resolve through it).

This is the most personal-data-dense table in the application.

## The one thing to understand before changing anything here

**Row Level Security cannot hide a column.** The §4 matrix grants a `service_provider`
a tenant's _name only, via assignment_. `0002`'s `tenants_select_provider_assigned`
correctly grants the **row** — the provider has to know whose door to knock on — and no
row-level policy can withhold `email` and `phone` from it.

So the column boundary lives in application space, in exactly three places:

| Where                                   | What it does                                       |
| --------------------------------------- | -------------------------------------------------- |
| `lib/auth/authorize.ts`                 | `PROVIDER_TENANT_FIELDS`, `projectionFor()`        |
| `features/tenants/server/serialize.ts`  | turns a projection into a `select` list and a shape |
| `features/tenants/server/tenant-service.ts` | applies it to every read                       |

`select *` appears nowhere on this table. If it ever does, a provider reads a tenant's
phone number and every RLS test still passes — which is exactly the failure mode
`tests/tenants/projection.test.ts` is written to catch.

## Files

| Path                           | Purpose                                                                |
| ------------------------------ | ---------------------------------------------------------------------- |
| `server/tenant-service.ts`     | list, read, create, update. Authorizes, projects, enforces linkage      |
| `server/serialize.ts`          | `TenantSchema` / `TenantNameSchema` projection and the `select` lists    |
| `server/cursor.ts`             | keyset cursor codec, shared with `features/tenancies` (see its header)   |
| `server/context.ts`            | `DataContext`, `Page`, search-term sanitisation                          |
| `server/viewer.ts`             | the server-component equivalent of `withApiHandler`'s auth stages        |
| `components/tenant-table.ts x` | staff directory table                                                   |

## List responses — amendment A18

Both list routes in this lane emit

```json
{ "data": [], "page_info": { "next_cursor": null, "has_more": false, "limit": 25 } }
```

built by `server/context.ts::pageBody()` and validated by `TenantListResponseSchema` /
`TenancyListResponseSchema` from `@shared/index`. **Not** `paginated()`'s
`{ data, next_cursor }`: A18 ruled for the contract package over the `lib/api` helper.
Emitted through `jsonResponse` so `cache-control: no-store` and `X-Request-Id` still
apply; no route in this lane constructs a `Response`.

`has_more` is load-bearing here specifically. A tenant's page is one or two rows out of
the organization's hundreds, and the owner path drops rows in application space after
the query returns, so a short page is the normal case — `next_cursor` alone cannot tell a
client "that was the last page" from "the server failed to issue a cursor".

## Invariants enforced here and nowhere else

1. **One tenant record per profile per organization.** `current_tenant_id(org)` is
   `select ... limit 1` with no ordering, so two rows sharing a `profile_id` would make a
   person's entire RLS-visible row set non-deterministic. There is no unique index behind
   this — see the planning defect in the lane report.
2. **A linked profile must be an active member of the caller's organization.**
   `tenants.profile_id` references `profiles(id)` with no organization component, so
   nothing else stops a staff member attaching a stranger's account.

## Not here

- No DELETE. `authenticated` has no DELETE privilege on `tenants`, and a record outlives
  the tenancy because the maintenance and audit history references it.
- No sidebar entry. `FEATURE_KEYS` in `config/types.ts` has six keys and `tenants` is not
  one of them; adding a seventh means editing `config/**`, which this lane does not own.
