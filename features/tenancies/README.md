# `features/tenancies` — the lease lifecycle

Lane **w1-l3**. Routes: `/api/v1/tenancies`, pages: `/tenancies`.

A tenancy links a tenant to a unit for a term, at a rent. It is where this lane's two
sensitive things meet: a person and a money figure.

## Four rules that exist only in this directory

No migration in this build expresses any of them, which makes
`server/tenancy-service.ts` the single enforcement point for each — and the reason the
tests here are not optional.

| Rule                                                                                     | Where                                  | Why there is no database check                                                                                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| No two **active** tenancies may overlap on one unit                                      | `occupancy.ts::findOverlappingTenancy` | `0001` declares no `tsrange` exclusion constraint and `0003` adds no trigger                                         |
| `draft → active → expired \| terminated`, plus `draft → terminated`                      | `lifecycle.ts`                         | `ALLOWED_TENANCY_TRANSITIONS` is explicitly "advisory only ... enforced server-side in the tenancy service"           |
| `property_units.status` follows the unit's active tenancy                                | `occupancy.ts::reconciledUnitStatus`   | The column is denormalized state; nothing derives it                                                                  |
| The embedded `tenant` on a tenancy read is authorized **separately** from the tenancy     | `server/tenancy-service.ts`            | The matrix gives `property_owner` `R owned` on `tenancies` and a dash on `tenants`. One read, two different cells |

That last row is the subtle one: embedding the tenant unconditionally would have handed
a property owner the contact details of every tenant in their building, through a route
that looks like it is only about leases. An absent `tenant` key on an owner's response
is the matrix being enforced, not a missing feature.

### Where the embedded tenant's `email` and `phone` come from

Not from a `select`. Migration `0004_agentic.sql` revoked `SELECT` on `tenants.email`
and `tenants.phone` from **every** role, staff included: row level security filters rows
and not columns, and all five application roles share the one Postgres role
`authenticated`, so no policy could express the matrix's "name only, via assignment" for
a `service_provider`. The columns now have a single read path — the `security definer`
RPC `tenant_contact(p_organization_id, p_tenant_id)`, which checks `is_org_staff()` and
raises `42501` otherwise.

`loadEmbeddedTenant()` therefore delegates to `getTenantById()` in
`features/tenants/server`, which already hydrates through that RPC — the hydration is
not copied into this lane. One call per request, with `p_tenant_id: null` meaning "every
tenant in this organization you may see", which is what lets a page of embeds resolve in
one round trip rather than one per row.

A caller the RPC refuses keeps `null` for both fields, and there is **no fallback**: a
`property_owner` is turned away by the projection gate before the RPC is reached, and a
`service_provider` is refused the tenancy itself. That is the point of the change.

## Lifecycle

```
draft ──▶ active ──▶ expired
  │          │
  └──────────┴────▶ terminated
```

`expired` and `terminated` are terminal. An illegal edge is **409**, per
`docs/api-contracts.md`. Every edge taken writes its own `tenancy_status_changed` audit
row carrying `from_status` and `to_status`, in addition to the wrapper's
`tenancy_updated` — the wrapper's action is fixed per route and a lifecycle event needs
its own entry.

## Money and dates

`rent_amount` is `numeric(12,2)` plus an ISO currency code, never a float. It is stored
and returned as the canonical decimal string `MoneyAmountSchema` produces
(`"120000.00"`), and the only place it becomes a `Number` is `format.ts`, for display,
after which no arithmetic happens.

`end_date >= start_date` is checked three times: in `CreateTenancySchema`, in
`updateTenancy` against the *effective* row (a partial PATCH carries only one of the two
dates, so the schema cannot compare the pair), and by `0001`'s `check` constraint. The
second one is what turns a date mistake into a useful 422 instead of a bare constraint
violation.

## Files

| Path                        | Purpose                                                                 |
| --------------------------- | ----------------------------------------------------------------------- |
| `lifecycle.ts`              | the edge set, terminal states, creatable statuses. Pure                  |
| `occupancy.ts`              | overlap predicate, unit-status reconciliation, expiry window. Pure       |
| `format.ts`                 | locale-pinned money and date formatting (`en-AE`, `AED`)                 |
| `server/tenancy-service.ts` | list, read, self-service, create, update, occupancy sync, lifecycle audit |
| `server/serialize.ts`       | `TenancySchema` / `TenancyDetailSchema` projection                       |
| `components/`               | register table, self-service card, expiring-tenancies panel              |
| `nav.ts`, `widget.tsx`      | the w0-l1 pre-stub slots, now filled and enabled                         |

## Read scope

`tenancyReadScope()` states the matrix's `tenancies` row as a query filter. The list path
narrows three times over: by role here, by RLS in Postgres, then row by row by
`authorize()` with ownership hydrated. A row that RLS returns and the third narrowing
rejects is logged as `authorization_layer_disagreement` — the layers are meant to agree,
so a disagreement is a defect in one of them and must be visible.

| Role                 | Scope                                       |
| -------------------- | ------------------------------------------- |
| `organization_admin` | the organization                            |
| `property_manager`   | the organization                            |
| `property_owner`     | leases on units of properties they own      |
| `tenant`             | their own, pinned to `membership.tenantId`  |
| `service_provider`   | denied — no cell on this table              |

## Tenant self-service

`listOwnTenancies(ctx)` takes **no identifier**. There is no parameter through which a
caller could ask about anybody else, which is the acceptance criterion "a signed-in
tenant sees their own tenancy and provably cannot read another's" expressed as a type
signature rather than as a check.

## Not here

No DELETE, and no archive column either: terminating or expiring a tenancy **is** the
removal path, and the row stays.
