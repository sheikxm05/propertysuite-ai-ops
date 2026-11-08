# Maintenance workflow — lane `w1-l4`

The spine of the demo: a tenant reports an issue, a manager triages and assigns it, a
provider does the work, a human confirms completion, and every step leaves one
immutable timeline entry.

## Layout

| Path | What lives there |
| --- | --- |
| `domain/transitions.ts` | the state machine, third enforcement point |
| `domain/scope.ts` | role filtering for reads (`ticketListScope`) |
| `domain/field-policy.ts` | which columns each role may write; which activity types a client may post |
| `domain/activities.ts` | activity-row planning — "exactly one row per transition" |
| `domain/business-hours.ts` | the clock reader `resolvePriority()` takes as a trusted input |
| `domain/cursor.ts` | keyset cursors for both list routes |
| `domain/repository.ts` | every database statement this lane issues |
| `domain/service.ts` | the single authorization choke point |
| `domain/view.ts` | rows to the shared `Ticket` / `Activity` / `TicketDetail` shapes |
| `components/**` | the list, the detail, the timeline, the action forms |
| `server-context.ts` | session and membership resolution for the pages |
| `nav.ts`, `widget.tsx` | the w0-l1 registry slots, now enabled |

Routes are thin adapters in `app/api/v1/maintenance/tickets/**`; pages are in
`app/(dashboard)/maintenance/**`. Neither queries a table directly.

### Pages

| Route | What it is |
| --- | --- |
| `/maintenance` | the list — one screen that is five different screens |
| `/maintenance/new` | the deterministic create form |
| `/maintenance/[ticketId]` | detail, timeline, and the caller's available actions |
| `/maintenance/report` | **hosts lane w1-l5's `ReportIssuePanel`** — tenants only |

`/maintenance/report` exists because `features/ai-intake/nav.ts` reserves that href and
the route group belongs to this lane, so w1-l5 could not create it. The page is a shell
plus the panel: no form, no action, no fetch, and deliberately no shortcut to
`POST /maintenance/tickets` — the panel owns its own draft-then-confirm flow, and "AI
drafts, humans commit" only holds if no surface offers a way around the confirm.
`tests/maintenance/ui.test.ts` asserts every enabled nav link into `/maintenance/**` has
a page, so this cross-lane gap cannot silently reopen.

## The state machine lives in three places

```
open → assigned → in_progress → awaiting_approval → completed
                        ↑________________|            (rework, A9)
cancelled from any non-terminal status
```

1. `ALLOWED_TRANSITIONS` + `TRANSITION_ROLES` + `canTransition` in `packages/shared`
2. `public.enforce_ticket_transition()` in migration `0003`
3. `domain/transitions.ts` — **this lane owns only this one, and it owns it by
   importing the first.** There is no local `switch` on status and no local role list.

Status codes, in the order they are tested:

| Condition | Code | Database equivalent |
| --- | --- | --- |
| the edge is not in the graph | `409 CONFLICT` | `P0001 ticket_status_transition_invalid` |
| the edge exists, the role may not drive it | `403 FORBIDDEN` | `42501` |
| the role may drive it, the row is not theirs | `403 FORBIDDEN` | RLS: zero rows updated |

Testing them in the other order would leak the graph: a provider probing
`completed → open` would learn whether the edge exists from the status code.

## Rules this lane holds to

- **Nothing a request says about identity is believed.** `organization_id`,
  `property_id`, `tenant_id` and `tenancy_id` are all derived — a tenant names only a
  unit, so a mismatched `(property_id, property_unit_id)` pair is unconstructable.
- **Priority is decided, never requested.** `resolvePriority()` from
  `packages/shared` runs on creation, on a category change and at triage. A request
  alone can never produce `urgent`.
- **A provider sees only assigned work**, and only within `PROVIDER_JOB_STATUSES`,
  which is derived from `TRANSITION_ROLES` rather than listed.
- **Exactly one activity row per transition.** A transition row is one whose metadata
  carries `from_status` and `to_status`; the planner, the timeline component and the
  tests share that definition. Clients cannot post a transition type.
- **No DELETE, no UPDATE on the timeline.** A ticket is cancelled; a mistaken activity
  row is contradicted by a later one.
- **Completion is an explicit human act.** `confirmed: true` is a literal, and only a
  manager, an admin or the reporting tenant may close — never the provider who did the
  work.
- **Both list routes ship through their response contract.** `paginated()` with
  `TicketListResponseSchema` / `ActivityListResponseSchema` (§5.7 amendment A18). Both
  item schemas are `.strict()`, so an undeclared column is rejected — a loud 500 — rather
  than stripped. Third guard after the repository's explicit projections and `view.ts`'s
  narrow mappers, and the only one that survives someone widening a `select`.
- **Evidence is verified, not created.** Uploads go through lane w1-l6's
  `POST /api/v1/documents/upload-url`; completion checks every cited document is
  already attached to this ticket. This lane writes no code under
  `app/api/v1/documents`.

## Tests

`tests/maintenance/**`, 433 cases, no database required:

- `transitions.test.ts` — every ordered status pair × every role, derived from the
  shared tables rather than transcribed
- `scope.test.ts` — role filtering, including the three ways a provider sees nothing
- `activities.test.ts` — the one-row-per-transition invariant and metadata hygiene
- `priority.test.ts` — business hours and the escalations this lane supplies
- `cursor.test.ts` — round trip, and that a hostile cursor cannot become a filter
- `service.test.ts` — the domain service against a recording PostgREST double
- `routes.test.ts` — status codes, the frozen envelope, the audit row, and the A18
  output contract
- `ui.test.ts` — registry wiring, the nav-link-has-a-page guard, and the timeline's
  runtime status narrowing

The second enforcement layer — the RLS policies and the `0003` trigger — is proven
against a real database by `tests/rls/**` (lane w0-l6). See the header of
`tests/maintenance/_support/fake-postgrest.ts` for what this suite deliberately does
not claim.
