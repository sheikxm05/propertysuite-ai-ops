# `packages/shared` — cross-lane contracts

Owned by lane **w0-l4**. Every schema, enum, type and error code the application
shares comes from here. Nothing else may define a local copy of one.

The public surface is frozen in `docs/parallel-execution-plan.md` §5.4. Five other
lanes import from this package and cannot add to it, so the set is complete on first
delivery.

Depends only on `zod`. Safe to import from a client component, a server route handler,
a test or a script.

## Layout

| Path          | Holds                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| `constants/`  | Database enums, the error contract, the ticket state machine, frozen §5.7 values |
| `policy/`     | Pure decision functions — the deterministic priority policy                  |
| `schemas/`    | One file per domain; request and response schemas for every route            |
| `types/`      | Database row types                                                           |
| `__tests__/`  | Accept/reject cases, the full transition matrix, the priority policy          |

Import from the barrel (`@shared/index`) or from the module
(`@shared/constants/ticket-status`). Both reach every name.

## The three rules this package encodes

**1. The ticket state machine lives in one place.**
`ALLOWED_TRANSITIONS` is the status graph; `TRANSITION_ROLES` is who may drive each
edge. `public.enforce_ticket_transition()` in `0003` enforces the same table, so the UI,
the API and the database cannot disagree. Two questions, two status codes:

```ts
if (!isAllowedTransition(from, to)) return 409; // CONFLICT — the edge does not exist
if (!canTransition(from, to, role)) return 403; // FORBIDDEN — not for this role
```

`canTransition` answers the *role* question only. Ownership — "is this the reporting
tenant", "is this the assigned provider" — is a separate check the caller must also
make; the function is pure and sees no row. RLS enforces it independently.

Two sibling graphs follow the same naming, in `constants/statuses.ts`:
`ALLOWED_TENANCY_TRANSITIONS` / `canTransitionTenancy`, and
`ALLOWED_UNIT_TRANSITIONS` / `canTransitionUnit`. Neither has a database trigger
behind it — both are enforced server-side.

For units the shared rule is not really the edge set but
`reconcileUnitStatus(hasActiveTenancy, current)`: "what should this unit's status be,
given its tenancy state". Properties and tenancies are separate lanes that both write
`property_units.status`, so they must get the same answer. `inactive` is sticky — a
staff decision that a unit is not lettable is never cleared by an automated reconcile,
and the result is always either the current status or a legal transition from it, so
callers can apply it without a second check.

**2. The model suggests; policy decides.**
`resolvePriority(classification, context)` decides a ticket's priority.
`suggested_priority` is one bounded input: a suggestion alone can never produce
`urgent`, and can never exceed one step above the category baseline or rise above
`high`. Reaching `urgent` requires a trusted, server-derived signal. Every field of
`PriorityContext` must come from database rows or the server clock — never from a
request body, never from model output.

**3. Request schemas are `.strict()`.**
Unknown keys are rejected, not stripped. A body carrying `organization_id`,
`status`, `tenant_id` or `role` into a create route gets a 400 instead of being
silently ignored, so a mass-assignment attempt is visible. Server-derived columns
appear in no request schema at all.

Related conventions: money is a canonical decimal string plus an ISO currency code
(`MoneyAmountSchema`, never a float — use `moneyToMinorUnits` for arithmetic); dates
are ISO 8601 and impossible dates such as `2026-02-31` are rejected before Postgres
sees them; every mutation reachable from model output carries
`confirmed: ConfirmationSchema`, a `z.literal(true)`.

## Regenerating `types/database.ts`

Hand-written, because Docker was unavailable when this lane ran. It is transcribed
column by column from `0001`, `0002` and `0003`, including `documents.ticket_id`, the
`jobs` and `organization_invitations` tables, and every RPC signature. With the local
stack up:

```bash
npx supabase gen types typescript --local --schema public \
  > packages/shared/types/database.ts
```

It is deliberately faithful to the generator rather than to the domain — a `text`
column with a check constraint is typed `string`, as the generator emits it, so a
regeneration is a no-op rather than a breaking change. The narrow unions live in
`constants/statuses.ts` and are applied by the Zod response schemas, which are what
application code should read rows through.

## Drift protection

`constants/enum-parity.ts` asserts at compile time that `MEMBER_ROLES`,
`TICKET_STATUSES` and `TICKET_PRIORITIES` match the Postgres enums in
`types/database.ts`. If a migration changes an enum and the constant is not updated,
`tsc --noEmit` fails there rather than Postgres failing in production.

`maintenance_tickets.category` is `text` with no Postgres enum, so no type-level
assertion is possible; `MAINTENANCE_CATEGORIES` and every list in
`constants/statuses.ts` are asserted against the migration's check-constraint literals
in `__tests__/constants.test.ts` instead.

## Tests

```bash
npx vitest run packages/shared
```

The transition suite enumerates all 6 x 6 x 5 = 180 `(from, to, role)` triples against
a table transcribed independently from the specification prose, so a misplaced role
fails a named test rather than passing by self-agreement.
