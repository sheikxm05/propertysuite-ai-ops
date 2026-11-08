# Parallel Execution Plan — 6 Agents, Zero Overlap

Companion to `implementation-plan.md`. That document states _what_ is built and why.
This one states _who builds which file_, so six agents can run concurrently without
ever touching the same path.

**Status: in execution.** Wave 0 stage 1 (`w0-l1`) and lanes `w0-l2`, `w0-l3`, `w0-l4`
are delivered and committed; `w0-l5` and `w0-l6` are in flight. Wave 0's gate is NOT
met: both migrations are unexecuted against a live Postgres because Docker is down,
and `w0-l6`'s isolation suite is the required proof. Freeze amendments are logged in
§5.8, carried-forward gaps in §5.9.

---

## 0. How non-overlap is actually achieved

Six agents editing one Next.js repo will collide on `package.json`, the nav shell, the
dashboard page and the shared schema files unless the plan removes those collisions by
construction. Five mechanisms do that:

1. **Exclusive path ownership.** Every file in the repo has exactly one owning lane per
   wave (§6 master map). An agent that needs a change in a path it does not own must
   stop and report it as a planning defect — it must never edit across the boundary.
2. **Interface freeze (§5).** Every cross-lane contract — dependency list, handler
   wrapper signature, error envelope, schema export names, SQL helper signatures, route
   paths — is fixed in writing _before_ fan-out. Agents code against this document, not
   against each other's output, so they do not need to wait or negotiate.
3. **Pre-stubbed integration points.** Wave 0 Lane 1 creates every shared file that
   would otherwise be a merge point — nav registry, dashboard widget slots, route group
   layouts — already populated with placeholder entries for all six features. Each
   feature lane then fills in only its own file.
4. **One mandatory handler wrapper.** `withApiHandler` (owned by W0-L5) injects
   authentication, authorization, validation, rate limiting, audit writing, logging and
   the error envelope. Cross-cutting concerns therefore live in one owned file instead of
   being threaded through sixty route handlers by a later lane.
5. **Mechanical enforcement.** `lanes.json` declares each lane's glob ownership;
   `scripts/check-lane-ownership.mjs` fails if a lane's diff touches a path it does not
   own. Run it in CI and as each agent's own pre-commit check.

**Pre-wave artifacts — already built, not owned by any lane.** Enforcement has to exist
before Wave 0 starts, so `lanes.json`, `scripts/check-lane-ownership.mjs` and
`agent-briefings.md` are delivered ahead of fan-out rather than assigned to W0-L1. No
agent creates or edits them. The validator runs with zero dependencies, so it works
before `npm install` has ever executed:

```
node scripts/check-lane-ownership.mjs --list       # every wave, lane and owned glob
node scripts/check-lane-ownership.mjs --overlaps   # static: no same-wave collisions
node scripts/check-lane-ownership.mjs --lane w1-l4 # working tree vs owned paths
node scripts/check-lane-ownership.mjs --lane w1-l4 --base main --orphans
```

`--overlaps` synthesises concrete paths from every glob and asserts no two lanes in one
wave can claim the same file — it proves the map itself is collision-free, independently
of what any agent does. Ready-to-paste prompts for all eighteen lanes are in
`agent-briefings.md`.

**Isolation:** one git branch per lane, named `lane/<id>`, ideally in its own git
worktree so agents cannot see each other's dirty trees. Merge order is wave order;
within a wave, merge order is irrelevant because the diffs are disjoint by construction.

**Waves are barriers.** Lanes inside a wave are fully parallel. A wave merges and its
gate passes before the next wave starts. Three waves, six lanes each, eighteen agent
tasks, ~112 subtasks.

**Correction found at pre-flight — W0-L1 runs solo first.** Wave 0 is parallel for
_authorship_ but not for _verification_: `w0-l4`, `w0-l5` and `w0-l6` can write code
against the §5 freeze without waiting for anyone, but none of them can execute
`npm test` until `w0-l1` has created `package.json` and installed the frozen dependency
list. Launching all six at once therefore yields three lanes that cannot prove their own
exit gates. Run `w0-l1` alone first — it is short, being scaffold and install — then
launch the remaining five concurrently. Execution is four stages, not three:
`w0-l1` → `w0-l2…l6` (5 parallel) → Wave 1 (6 parallel) → Wave 2 (6 parallel).

Separately, `git init` and the initial commit are **pre-wave** work: six lane branches
and worktrees cannot be created before the repository exists, so assigning `git init` to
a lane agent was a sequencing defect. The repository is initialized and the planning
artifacts are committed on `main`.

---

## 1. Wave overview

| Wave | Theme                                         | Lanes | Gate to exit                                                                 |
| ---- | --------------------------------------------- | ----- | ---------------------------------------------------------------------------- |
| 0    | Contracts, security core, test infrastructure | 6     | Migrations apply clean; RLS isolation suite passes; typecheck and lint green |
| 1    | Six feature verticals                         | 6     | Every feature's authorization and unit tests pass; ownership check clean     |
| 2    | Cross-cutting completion and demo             | 6     | Every release gate in `test-plan.md` green                                   |

No feature work exists in Wave 0, and no shared contract changes in Wave 1. That
separation is what keeps Wave 1 collision-free.

---

## 2. Wave 0 — Contracts and security core

### W0-L1 — Repository scaffold, tooling, integration stubs

**Depends on:** nothing. **Owns:**
`package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`,
`tailwind.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `.prettierrc`,
`.gitignore`, `.env.example`, `lanes.json`, `scripts/check-lane-ownership.mjs`,
`.github/workflows/ci.yml`, `app/layout.tsx`, `app/globals.css`,
`app/(dashboard)/layout.tsx`, `components/ui/**`, `components/shell/**`,
`config/nav.registry.ts`, `config/dashboard.slots.ts`

**Subtasks**

1. `git init`; initial commit; create `lane/*` branch scaffolding convention in the README.
2. Scaffold Next.js App Router + TypeScript strict; path aliases `@/*`.
3. Install the **entire** frozen dependency list from §5.1 in one pass. No other lane ever edits `package.json`.
4. Tailwind + shadcn/ui base; generate the primitive set listed in §5.6 so no feature lane runs a generator.
5. ESLint config including a `no-restricted-imports` rule banning `lib/supabase/service-role` outside `**/server-only/**`.
6. Wire the pre-built `check-lane-ownership.mjs` into CI (`--overlaps` plus a per-lane check). Do **not** create or edit `lanes.json` or the validator — they already exist.
7. Pre-stub integration points: `config/nav.registry.ts` importing six placeholder entries from `features/<f>/nav.ts`; `config/dashboard.slots.ts` importing six placeholder widgets from `features/<f>/widget.tsx`. Create the placeholder files as inert stubs so the build is green and each feature lane replaces exactly one file.
8. App shell: route group layouts, sidebar driven by the nav registry, theme, 404 and error pages.
9. CI workflow: typecheck, lint, unit, RLS suite, ownership check, client-bundle secret scan.

**Exit gate:** empty app builds; CI green; ownership validator rejects a deliberate cross-lane edit; no secret reachable from the client bundle.

---

### W0-L2 — Migration `0002`: RLS helpers and policy matrix

**Depends on:** nothing (frozen schema in `0001` plus the §4 matrix in `implementation-plan.md`).
**Owns:** `supabase/migrations/0002_rls_hardening.sql` — this file only.
**Reads:** `0001_initial_schema.sql`, `implementation-plan.md` §3–4.

**Subtasks**

1. `enable row level security` on `organizations` and `profiles` (currently missing — the two platform-wide leaks).
2. Drop all baseline `is_org_member`-only policies by name.
3. Create the six helper functions with the exact signatures in §5.3, all `stable security definer set search_path = ''`.
4. Write per-table, per-operation policies implementing the full §4 matrix, predicates wrapped as `(select ...)`.
5. Grant no `DELETE` on any tenant-scoped table.
6. `revoke update, delete on public.maintenance_activities from authenticated`.
7. Storage policies on the private bucket deriving organization from path segment 1.
8. `create extension if not exists vector` — unused, reserved for the deferred RAG slice.
9. Inline comment per policy naming the acceptance criterion it satisfies.

**Exit gate:** applies to a fresh database and is idempotent on re-run; W0-L6's suite turns green against it.

---

### W0-L3 — Migration `0003`: triggers, RPCs, schema fixes, job table

**Depends on:** nothing. Disjoint file from W0-L2 by design, so both run concurrently.
**Owns:** `supabase/migrations/0003_domain_integrity.sql` — this file only.

**Subtasks**

1. Immutability trigger blocking `UPDATE`/`DELETE` on `maintenance_activities`.
2. Ticket transition trigger enforcing the §4 state machine, raising `P0001` on an illegal transition.
3. Trigger asserting `assigned_provider_id` shares the ticket's `organization_id`.
4. `security definer` RPCs: `create_organization(name, slug)`, `invite_member(org, email, role)`, `accept_invitation(token)` — each validating the caller and writing an audit row.
5. Fix `properties.owner_member_id` to a composite foreign key including `organization_id`.
6. Add `documents.extracted_text text` (RAG seam; populated from W1-L6).
7. Create `jobs(id, type, payload jsonb, idempotency_key text unique, attempts int, next_run_at timestamptz, status, last_error, created_at)` with RLS denying all client access — service-role only.
8. `updated_at` touch triggers on `properties`, `maintenance_tickets`.
9. Audit-write helper `log_audit(action, entity_type, entity_id, metadata)`.

**Exit gate:** illegal transitions and activity mutations are rejected at the database level, proven by W0-L6 tests.

---

### W0-L4 — Shared contracts package

**Depends on:** nothing. **Owns:** `packages/shared/**` only —
`schemas/{organization,property,unit,tenant,tenancy,maintenance,document,ai}.ts`,
`constants/{roles,ticket-status,categories,errors}.ts`, `types/database.ts`, `index.ts`.

**Subtasks**

1. Zod schemas with the exact export names frozen in §5.4 — one file per domain, no barrel edits by other lanes.
2. Request and response schemas for every route in §5.5, matching `api-contracts.md`.
3. Enum constants mirroring the Postgres enums; a compile-time check that they stay in sync.
4. The error-code union and the `ApiError` envelope type from §5.2.
5. Ticket transition table as data (`ALLOWED_TRANSITIONS`) plus `canTransition(from, to, role)` as a pure function, so both the UI and the server import one rule set.
6. Deterministic priority policy function — the model only _suggests_ priority; this decides it.
7. Generated `types/database.ts` from the local schema; regeneration script documented.
8. Unit tests for every schema's accept and reject cases, and for `canTransition`.

**Exit gate:** `packages/shared` typechecks standalone; its unit tests pass; no feature lane needs to add an export to it.

---

### W0-L5 — Runtime security library and the handler wrapper

**Depends on:** W0-L4 contracts (by frozen signature, not by waiting). **Owns:** `lib/**` —
`supabase/{browser,server,service-role}.ts`, `auth/{session,roles,authorize}.ts`,
`api/{with-handler,errors,responses}.ts`, `audit/write.ts`, `rate-limit/index.ts`,
`observability/{logger,correlation}.ts`, `env.ts`, `middleware.ts`

**Subtasks**

1. Zod-parsed `env.ts` failing fast at boot; service-role key only readable in server-only modules.
2. Supabase browser client, server client (cookie-based, `@supabase/ssr`), and an isolated service-role client.
3. `getSession()` and `requireSession()`; Next.js middleware protecting the dashboard route group.
4. `resolveMembership(userId)` → profile, organization, role, derived from trusted database rows — never from client input.
5. `authorize(membership, action, resource)` policy functions mirroring the §4 matrix in application space.
6. **`withApiHandler`** implementing the §5.2 signature: authenticate → authorize → Zod-validate → rate-limit → execute → audit → typed envelope with `request_id`. Every feature route uses it; this is why Wave 2 needs no handler edits.
7. Audit writer and a correlation-ID-carrying structured logger with a redaction allowlist (never logs document text, tokens or PII).
8. Per-user, per-route token-bucket rate limiter with stricter defaults on AI routes.
9. Unit tests for `authorize`, redaction, and the wrapper's error mapping.

**Exit gate:** a throwaway probe route returns the exact frozen envelope for 401, 403, 404, 409, 422, 429 and 500.

---

### W0-L6 — Test infrastructure and the RLS isolation suite

**Depends on:** nothing — written **test-first** against the frozen §4 matrix, so it runs red until `0002`/`0003` merge.
**Owns:** `vitest.config.ts`, `playwright.config.ts`, `tests/_harness/**`, `tests/rls/**`,
`scripts/{supabase-local,reset-db,make-jwts}.mjs`

**Subtasks**

1. Local Supabase stack scripts: start, migrate, reset, teardown via Docker.
2. JWT factory creating real authenticated sessions for 10 principals — five roles × two organizations.
3. Fixture builder seeding two organizations with deliberately similar data through the service-role client.
4. Cross-organization suite: for every tenant-scoped table, assert `SELECT`, `INSERT`, `UPDATE`, `DELETE` all denied across the boundary.
5. Cross-role suite: tenant cannot read another tenant's row; provider sees exactly one assigned ticket and zero unassigned; owner sees only owned properties; only an admin reads `audit_logs`.
6. Negative-write suite: no `DELETE` succeeds anywhere; `maintenance_activities` rows cannot be updated or deleted; mismatched `organization_id` across related inserts is rejected.
7. State-machine suite driven by `ALLOWED_TRANSITIONS`, asserting database-level rejection of every illegal pair.
8. Storage suite: signed URL for another organization's object is refused; expiry is honoured.
9. Coverage report listing every policy exercised, so an unexercised policy is visible.

**Exit gate (hard, blocks all of Wave 1):** the full suite is green in CI and every policy in the matrix is exercised by at least one passing assertion.

---

## 3. Wave 1 — Six feature verticals, fully parallel

Every lane follows the same shape and touches nothing outside it:
`app/api/v1/<domain>/**`, `app/(dashboard)/<domain>/**`, `features/<domain>/**`
(including its own `nav.ts` and `widget.tsx` stubs), `tests/<domain>/**`.
All six **read** `packages/shared`, `lib`, and the migrations. None of them writes there.

### W1-L1 — Identity, organizations, invitations

**Owns:** `app/(auth)/**`, `app/api/v1/organizations/**`, `app/api/v1/members/**`, `features/organizations/**`, `tests/organizations/**`

1. Sign-in, sign-out, session refresh, auth error states.
2. Profile bootstrap on first sign-in.
3. Organization creation via the `create_organization` RPC.
4. Invitation issue, listing, revoke; acceptance flow via `accept_invitation`.
5. Member list with role changes, admin-only, audited.
6. Role-aware navigation entry and the organization summary widget.
7. Tests: invitation lifecycle; non-admin cannot invite; accepted member receives exactly their role's visibility.

### W1-L2 — Properties and units

**Owns:** `app/api/v1/properties/**`, `app/(dashboard)/properties/**`, `features/properties/**`, `tests/properties/**`

1. Property list with cursor pagination, detail, create, update, archive.
2. Unit create, list, update, status transitions.
3. Owner and manager association, organization-consistency enforced.
4. Forms sharing one Zod schema between client and server.
5. Owner-scoped read path verified against the matrix.
6. Nav entry and the portfolio-count widget.
7. Tests: manager can write, owner is read-only, tenant sees only leased property, provider sees only ticket-linked property.

### W1-L3 — Tenants and tenancies

**Owns:** `app/api/v1/tenants/**`, `app/api/v1/tenancies/**`, `app/(dashboard)/tenancies/**`, `features/tenants/**`, `features/tenancies/**`, `tests/tenancies/**`

1. Tenant records; optional linkage to an application user.
2. Tenancy create and update: date ordering, rent, currency, contract number.
3. Lifecycle transitions draft → active → expired/terminated, audited.
4. Unit occupancy kept consistent with active tenancy.
5. Tenant self-service view exposing only the caller's own tenancy.
6. Nav entry and the expiring-tenancies widget.
7. Tests: cross-tenant PII read denied; overlapping active tenancy on one unit rejected.

### W1-L4 — Maintenance workflow

**Owns:** `app/api/v1/maintenance/**`, `app/(dashboard)/maintenance/**`, `features/maintenance/**`, `tests/maintenance/**`

1. Ticket creation restricted to a unit the caller is authorized for.
2. List and detail views, role-filtered, with status and priority facets.
3. Manager triage: priority via the deterministic policy function, assignment within the organization.
4. Provider job list and the permitted status subset only.
5. Completion evidence upload through the frozen documents contract (no cross-lane code).
6. Completion confirmation by manager or reporting tenant.
7. Activity timeline rendered from the immutable table; one activity row per transition.
8. Nav entry and the open-tickets widget.
9. Tests: every illegal transition rejected; provider cannot read or touch unassigned work; every transition leaves exactly one activity row.

### W1-L5 — AI maintenance intake

**Owns:** `services/ai/**`, `app/api/v1/ai/**`, `features/ai-intake/**`, `tests/ai/**`, `evals/maintenance/**`

1. Provider-neutral adapter; `classify()` returns a validated object or throws. Model id from env, never hardcoded at a call site.
2. Versioned prompt and JSON schema in source, from `docs/ai-prompts/maintenance-classification.md`.
3. Untrusted-content fencing as the adapter's only input path — user and document text never enter the system role.
4. `POST /ai/maintenance/classify`: returns a draft, creates nothing, persists the conversation turn.
5. `POST /ai/maintenance/confirm`: creates the ticket through the normal domain service, re-validating authorization server-side.
6. Clarification UX when unit context is ambiguous; draft review and edit before confirm.
7. Strict output validation with a safe reject path; retry-once-then-fail on malformed JSON.
8. Token, latency and outcome logging with no message text logged.
9. Nav entry and the "report an issue" widget.
10. Eval set: HVAC correct, plumbing correct, missing context asks for clarification, prompt injection treated as inert data, malformed JSON rejected, model output provably unable to reach a privileged action.

### W1-L6 — Documents, extraction, job runner

**Owns:** `app/api/v1/documents/**`, `app/(dashboard)/documents/**`, `features/documents/**`, `services/workers/**`, `services/extraction/**`, `tests/documents/**`

1. `POST /documents/upload-url` issuing a 60-second signed URL on the frozen path convention.
2. MIME, extension, magic-byte and size validation; rejection paths.
3. Job runner over the `jobs` table: claim with `for update skip locked`, bounded exponential backoff, dead-letter status, idempotency key honoured.
4. PDF text extraction into `documents.extracted_text`.
5. Structured field extraction per `docs/ai-prompts/document-extraction.md`, through W1-L5's frozen adapter interface.
6. Fields persisted as `pending`; human verification UI showing proposed versus accepted values side by side.
7. `POST /documents/{id}/verify` writing verified fields only, with an audit row.
8. Nav entry and the pending-verification widget.
9. Tests: nothing is verified without a human action; a permanently failing job dead-letters instead of retrying forever; a duplicate enqueue is processed once.

**Wave 1 exit gate:** all six lanes merged; every lane's tests green; ownership validator clean on all six diffs; RLS suite still green.

---

## 4. Wave 2 — Cross-cutting completion

Feature lanes are closed. Ownership of feature paths transfers to W2-L3, which is the
**sole writer** on feature code during this wave; every other Wave 2 lane writes only
to the paths listed under it.

### W2-L1 — End-to-end suite

**Owns:** `tests/e2e/**`, `tests/_harness/e2e/**`

1. Page objects per role. 2. The ten-step scenario from `test-plan.md`. 3. The
   cross-organization denial beat as an assertion, not a screenshot. 4. AI intake happy
   path plus clarification path. 5. Document upload through verification. 6. CI smoke
   subset under five minutes.

### W2-L2 — Demo seed data and walkthrough

**Owns:** `scripts/seed-demo.mjs`, `fixtures/demo/**`, `docs/demo-walkthrough.md`

1. Two organizations with deliberately similar-looking portfolios. 2. One user per role
   per organization, documented credentials. 3. Realistic Dubai properties, units,
   tenancies in several lifecycle states. 4. Tickets across every status, with activity
   history. 5. Two sample tenancy PDFs, one verified and one pending. 6. Idempotent
   re-seed. 7. The scripted walkthrough with the §6 narrative of `implementation-plan.md`.

### W2-L3 — Security audit and remediation (sole feature-code writer)

**Owns:** `docs/security-audit.md` plus remediation edits anywhere in `app/`, `features/`, `services/`

1. Walk `security-checklist.md` item by item, recording evidence per line. 2. Confirm
   no service-role usage outside server-only modules. 3. Verify every mutation route is
   wrapped and audited. 4. Adversarial pass: IDOR attempts on every route, client-supplied
   `organization_id` injection, signed-URL replay after expiry. 5. Prompt-injection pass
   against both AI routes. 6. Log-redaction verification. 7. Remediate findings and
   re-run every suite.

### W2-L4 — Observability, performance, resilience

**Owns:** `lib/observability/**`, `lib/rate-limit/**`, `instrumentation.ts`, `app/api/health/**`, `docs/runbook.md`

1. Correlation IDs end to end, including into job records. 2. Request, error and
   AI-usage metrics. 3. Rate-limit tuning and 429 handling in the UI. 4. Health and
   readiness endpoints. 5. Index review against actual query plans. 6. Job dead-letter
   alerting. 7. Operations runbook.

### W2-L5 — Role dashboards and UX completion

**Owns:** `app/(dashboard)/page.tsx`, `app/(dashboard)/dashboard/**`, `components/shell/**`, `config/{nav.registry,dashboard.slots}.ts`

1. Compose the six widgets contributed in Wave 1 into five role-specific dashboards.
2. Empty, loading and error states for every surface. 3. Responsive and keyboard
   navigation pass. 4. Accessibility pass on forms and the ticket timeline. 5. Consistent
   toasts and optimistic-update behaviour. 6. Final nav polish per role.

### W2-L6 — Deployment and documentation close-out

**Owns:** `README.md`, `docs/{api-contracts,backlog,implementation-plan}.md`, `.github/workflows/deploy.yml`, `docs/deployment.md`

1. Vercel plus Supabase cloud configuration, or the local-only path if that is the
   chosen target. 2. Migration promotion procedure. 3. Secret handling and rotation notes.
2. Reconcile `api-contracts.md` with the routes as shipped. 5. Close out `backlog.md`.
3. README quick start verified from a clean clone. 7. Release-gate checklist evidence.

**Wave 2 exit gate:** every release gate in `test-plan.md` green; security audit
findings closed or explicitly accepted with rationale.

---

## 5. Interface freeze

Nothing in this section may change after fan-out without re-planning. These are the
contracts that let six agents work blind to each other.

### 5.1 Dependency list — installed once by W0-L1

Runtime: `next`, `react`, `react-dom`, `@supabase/supabase-js`, `@supabase/ssr`, `zod`,
`@anthropic-ai/sdk`, `pdf-parse`, `date-fns`, `lucide-react`, `clsx`, `tailwind-merge`,
`class-variance-authority`, and the Radix primitives in §5.6.
Dev: `typescript`, `@types/*`, `tailwindcss`, `postcss`, `autoprefixer`, `eslint`,
`eslint-config-next`, `prettier`, `vitest`, `@vitest/coverage-v8`, `@playwright/test`,
`tsx`, `dotenv`, `supabase`.
No lane other than W0-L1 edits `package.json`. A missing dependency is a planning defect:
report it, do not install it.

### 5.2 `withApiHandler` and the error envelope

```ts
withApiHandler({
  roles?: MemberRole[],
  bodySchema?: ZodSchema,
  querySchema?: ZodSchema,
  rateLimit?: { key: string; perMinute: number },
  audit?: { action: string; entityType: string },
}, async (ctx) => Response)
// ctx: { session, membership, body, query, supabase, serviceRole?, requestId, logger }
```

Error responses are always exactly:

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "The request is invalid.", "request_id": "..." }
}
```

Codes: `VALIDATION_ERROR`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`UNPROCESSABLE`, `RATE_LIMITED`, `INTERNAL_ERROR`. Status mapping per
`api-contracts.md`. No lane invents a code or shape.

### 5.3 SQL helper signatures — W0-L2

```sql
public.has_org_role(org uuid, roles public.member_role[]) returns boolean
public.is_org_staff(org uuid)                            returns boolean
public.current_tenant_id(org uuid)                       returns uuid
public.current_provider_id(org uuid)                     returns uuid
public.owns_property(org uuid, property_id uuid)         returns boolean
public.can_access_unit(org uuid, unit_id uuid)           returns boolean
```

### 5.4 Shared schema exports — W0-L4

`CreatePropertySchema`, `UpdatePropertySchema`, `CreateUnitSchema`, `UpdateUnitSchema`,
`CreateTenantSchema`, `CreateTenancySchema`, `UpdateTenancySchema`,
`CreateTicketSchema`, `UpdateTicketSchema`, `AssignTicketSchema`,
`CompleteTicketSchema`, `CreateActivitySchema`, `UploadUrlSchema`,
`VerifyDocumentSchema`, `ClassifyRequestSchema`, `ClassificationSchema`,
`ConfirmTicketSchema`, `InviteMemberSchema`, `CreateOrganizationSchema`.
Also `ALLOWED_TRANSITIONS`, `canTransition`, `resolvePriority`, `MEMBER_ROLES`,
`TICKET_STATUSES`, `TICKET_PRIORITIES`, `MAINTENANCE_CATEGORIES`, `ApiError`.

### 5.5 Route ownership

| Prefix                                     | Lane  |
| ------------------------------------------ | ----- |
| `/api/v1/organizations`, `/api/v1/members` | W1-L1 |
| `/api/v1/properties` (and nested units)    | W1-L2 |
| `/api/v1/tenants`, `/api/v1/tenancies`     | W1-L3 |
| `/api/v1/maintenance`                      | W1-L4 |
| `/api/v1/ai`                               | W1-L5 |
| `/api/v1/documents`                        | W1-L6 |
| `/api/health`                              | W2-L4 |

### 5.6 Pre-generated UI primitives — W0-L1

`button`, `input`, `textarea`, `select`, `label`, `form`, `card`, `table`, `badge`,
`dialog`, `dropdown-menu`, `tabs`, `toast`, `skeleton`, `alert`, `separator`, `avatar`,
`tooltip`, `sheet`, `pagination`. No feature lane runs a component generator.

### 5.7 Other frozen values

Storage path `{organization_id}/{entity}/{uuid}.pdf`; signed URL TTL 60 s; upload cap
10 MB; `application/pdf` only. AI model id read from `AI_MODEL` env, default
`claude-sonnet-5`, confirmed against the Claude API reference at implementation time.
Currency AED, locale `en-AE`. Cursor pagination, default limit 25, maximum 100.

### 5.8 Amendment log

The freeze may only change here, by the orchestrator, and every affected lane is
re-briefed when it does. Entries are append-only.

| #   | Amendment                                                                                                                                                                                                                                   | Raised by    | Reason                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `components/ui/form.tsx` is dependency-free (native `FormData` + `ZodError.flatten().fieldErrors`) rather than shadcn's `react-hook-form` build                                                                                             | w0-l1        | `react-hook-form` is not in §5.1 and no lane may install a dependency                                                                                                            |
| A2  | SQLSTATE → error-code mapping added: `P0001`→`CONFLICT` 409, `42501`→`FORBIDDEN` 403, `28000`→`UNAUTHENTICATED` 401, `22023`→`VALIDATION_ERROR` 400, `23505`→`CONFLICT` 409, `23503`/`23514`→`UNPROCESSABLE` 422, else `INTERNAL_ERROR` 500 | w0-l3        | §5.2 froze the eight codes but never said how Postgres errors reach them. Postgres also raises `42501` for an RLS denial, so a cross-organization write surfaces as 403, not 500 |
| A3  | `log_audit` gains a fifth defaulted parameter `p_organization_id uuid default null`                                                                                                                                                         | w0-l3        | `audit_logs.organization_id` is `NOT NULL` in 0001 and cannot be derived from the four briefed arguments                                                                         |
| A4  | New table `organization_invitations` (created in 0003, RLS on, admin SELECT) plus a fourth RPC `revoke_invitation`                                                                                                                          | w0-l3        | `organization_members.profile_id` is `NOT NULL`, so an invitee who has not signed up cannot be represented. An admin who can invite but never revoke is not a shippable flow     |
| A5  | Storage bucket id frozen as `documents`                                                                                                                                                                                                     | w0-l2        | §5.7 froze the path, TTL, MIME and size cap but not the bucket id                                                                                                                |
| A6  | Matrix: `profiles` gains self-scoped UPDATE; creation moves to an `auth.users` security-definer trigger                                                                                                                                     | w0-l2        | The matrix was read-only, so "create a profile on first sign-in" had no legal write path                                                                                         |
| A7  | Matrix: `service_provider` gains `documents` INSERT/SELECT scoped to assigned tickets; `documents.ticket_id` added with a composite FK                                                                                                      | w0-l2        | Provider completion evidence was impossible — and `documents` had no ticket foreign key, so the access could not even be scoped                                                  |
| A8  | Matrix: `organization_admin` gains INSERT on `maintenance_activities`                                                                                                                                                                       | w0-l2        | An admin has RW on tickets, so an admin transition could not write its activity row — "immutable history of every transition" silently excluded admin actions                    |
| A9  | State machine: new edge `awaiting_approval → in_progress` (rework), admin/manager only. Cancel: admin/manager from any non-terminal state; the reporting tenant only while `open`; never provider or owner                                  | w0-l3, w0-l4 | §4 was silent on both. Without rework, a manager rejecting completion evidence could only cancel, discarding real work                                                           |
| A10 | Validator gains `--shared-tree`; `git status` now uses `-uall`                                                                                                                                                                              | w0-l2, w0-l3 | Authorship is not attributable when lanes share one working directory, and untracked directories were being collapsed to `app/`                                                  |

| A11 | The two `service_provider` evidence policies on `documents` are created by `public.ensure_document_provider_policies()`, defined in 0002 and called by 0003 after `documents.ticket_id` exists | w0-l2 | 0002 applies before 0003, so it cannot reference a column 0003 adds. The guard fails **closed** — on a fresh apply the policies are skipped with a `raise warning` and a provider simply cannot upload evidence. 0002's self-check raises if the column exists while either policy is missing, so the gap cannot survive silently |
| A12 | Matrix: the reporting tenant gets a scoped `maintenance_tickets` UPDATE policy — own ticket, `open` only, `cancelled` only, and only while `assigned_provider_id is null` | w0-l2 | A9 granted tenants a cancel path in the state machine, but RLS had no tenant UPDATE policy at all, so the database would have blocked a transition the domain layer permits |

| A13 | `withApiHandler` ctx gains `params` (awaited, flattened) and `request` | w0-l5 | §5.2's ctx omitted route parameters, yet roughly half the §5.5 routes are dynamic — the frozen contract was unbuildable as written. `request` is needed for webhook signature verification over the raw body. Additive, so a lane coded against §5.2 as published still compiles |
| A14 | `withPrivilegedApiHandler` (`lib/api/server-only/privileged-handler.ts`) is the opt-in seam for `ctx.serviceRole` | w0-l5 | §5.2 declared `serviceRole?` but froze a config object with no way to request it. Populating it unconditionally would hand an RLS-bypassing client to every route. Critically, had `with-handler.ts` imported the service-role client directly, the `**/server-only/**` lint rule would be satisfied once and then bypassed by all ~30 routes importing the wrapper — dependency inversion keeps the boundary real rather than decorative |
| A15 | The canonical import specifier for the shared package is **`@shared/index`** | w0-l5 | §5.4 froze export names but never a module path, so five lanes had to guess. Two guessed identically and matched — luck, not contract |
| A16 | `server-only` added to §5.1 and installed | w0-l5 | Next ships `client-only` but not `server-only`. With it, importing a privileged module from a client component is a BUILD failure; without it the guard is lint plus a runtime assertion that fires after the bundle has already shipped |
| A17 | Auth route slugs frozen: `/sign-in`, `/sign-up`, `/forgot-password`, `/accept-invitation` | w0-l5 | `middleware.ts` must name them literally because `config.matcher` has to be statically analysable. A mismatch between middleware and w1-l1 would redirect every unauthenticated user to a 404 while the gate still looked green |

| A18 | The list response envelope is `{ data, page_info: { next_cursor, has_more, limit } }` from `packages/shared`. `paginated()` in `lib/api/responses.ts` is changed to emit it | w1-l2, w1-l3, w1-l4 | §5.2 froze only the ERROR envelope, so w0-l4 and w0-l5 each invented a success envelope and five list routes across four lanes diverged. The shared shape wins because `packages/shared` is the contract source and the per-domain `*ListResponseSchema` names are already built on it. `has_more` also carries information `next_cursor` alone cannot: on an RLS-filtered list a short page is normal, so a client otherwise cannot distinguish "no next page" from "the server omitted the cursor" |
| A19 | `ALLOWED_UNIT_TRANSITIONS`, `canTransitionUnit` and a shared `reconcileUnitStatus` added to `packages/shared` | w1-l2 | `packages/shared` carried transition graphs for tickets and tenancies but not for `property_units`. Both w1-l2 and w1-l3 write `property_units.status`, and `features/**` is in neither lane's readonly list, so the rule was implemented twice in two lanes — agreeing "by luck, not by contract", with nothing failing if one drifts |
| A20 | `CompleteTicketSchema.resolution_summary` lowered from 2000 to 1000 characters | w1-l4 | `maintenance_tickets` has no `resolution_summary` column, so the append-only activity timeline is its only durable home, and `CreateActivitySchema.description` caps at 1000. A 1001-2000 character summary was valid input with nowhere to go. Truncating was rejected because 0003's trigger forbids amending an activity row even for the table owner |
| A21 | `resolveMemberDisplayNames()` added to `lib/auth/roles.ts` | w1-l2 | `eslint.config.mjs` restricts reading `profiles` to that one module, and `lib/**` is read-only to feature lanes, so no lane could render a member name. The owner picker was labelling people "Member a1b2c3d4" |

### 5.9a Defects found only by executing against a live database

Static review passed all of these. Recorded because they argue for applying migrations
early rather than at the end of a wave.

| Defect                                                                                                                    | How it presented                                                                             | Why static review missed it                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Infinite policy recursion on ticket INSERT** — no authenticated user could create a ticket at all, breaking criterion 5 | `ERROR: infinite recursion detected in policy for relation "maintenance_tickets"`            | The cycle only closes on the INSERT path. A bare `SELECT` on either table works, so read-only smoke tests and every static check passed. Reading each policy in isolation shows nothing wrong — the defect is in the reference _graph_ between two files' worth of policies                                                |
| **`TRUNCATE` still granted to `authenticated` on `maintenance_activities`**                                               | `information_schema.role_table_grants` shows `INSERT, SELECT, TRUNCATE, REFERENCES, TRIGGER` | 0002 revokes UPDATE and DELETE explicitly; Supabase's default grants include TRUNCATE, which was never revoked. Fails closed only because 0003's trigger also covers TRUNCATE — verified rejecting it even as the table owner. Assigned to `w2-l3` for an explicit revoke                                                  |
| **Parameter shadowed by a same-named column** (caught before it shipped)                                                  | Would have been a silent no-op                                                               | In a SQL-language function a column name outranks a same-named parameter, so `where u.property_id = property_id` compares the column to itself and is always true. It passes review, passes `create function`, and passes any probe that happens to send a consistent pair. Only a deliberately mismatched pair reveals it |
| **Bare `$$` dollar-quoting collapses through a shell heredoc**                                                            | `as $$` silently became `as $`                                                               | Not a code defect but a toolchain hazard: any lane authoring SQL through a heredoc must use named tags (`$fn$`, `$ubp$`). Detected only by tallying dollar-tag counts before and after an edit                                                                                                                             |

### 5.9 Known gaps carried forward

Owner `w2-l3` in `supabase/migrations/0004_security_remediation.sql` unless stated.

| #   | Gap                                                                                                                                                                                                       | Raised by  | Why it matters                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `check (category in (...))` on `maintenance_tickets.category`                                                                                                                                             | w0-l4      | The column is `text`, not an enum, so a direct database write can set a category no application path would produce. Use the list in `packages/shared/constants/categories.ts`                                                                                                                                                                                                                                                 |
| G2  | `revoke truncate on public.maintenance_activities from authenticated`                                                                                                                                     | live apply | Supabase's default grants include TRUNCATE and 0002 revoked only UPDATE and DELETE, so the append-only audit trail is one statement from erasure. 0003's trigger does reject it — verified even as table owner — so it fails closed, but the privilege should not exist                                                                                                                                                       |
| G3  | `create unique index on public.tenants (organization_id, profile_id) where profile_id is not null`                                                                                                        | w1-l3      | `current_tenant_id(org)` in 0002 is `select ... limit 1` with no `ORDER BY`. Two `tenants` rows sharing a `profile_id` in one organization make it return an arbitrary one, and with it that person's entire RLS-visible row set — non-deterministically. It is the function both `tenancies_select_own` and `can_access_unit` resolve through. Enforced server-side today, so only a direct service-role insert can break it |
| G4  | Exclusion constraint on overlapping active tenancies (`exclude using gist` over `(organization_id, property_unit_id, daterange(start_date, end_date, '[]'))` where `status='active'`; needs `btree_gist`) | w1-l3      | The overlap rule is read-then-write with no transaction, so two concurrent POSTs can both see zero conflicts and both insert — two tenants holding one unit, the exact condition the rule exists to prevent. The check is correct and exhaustively unit-tested; it is just not atomic                                                                                                                                         |
| G5  | `maintenance_tickets.tenant_id` made nullable, plus an optional server-validated `tenant_id` on `CreateTicketSchema` (w0-l4)                                                                              | w1-l4      | `tenant_id` is NOT NULL and must be derived from the unit's active tenancy, so a unit with no active tenancy cannot carry a ticket at all. That excludes vacant-unit turnaround and common-area maintenance, both ordinary property operations. Not a demo blocker — the demo path is tenant-reported — but a real functional gap                                                                                             |
| G6  | `docs/api-contracts.md` is missing three shipped routes: property archive, `GET` unit detail, `PATCH` unit                                                                                                | w1-l2      | Owner `w2-l6`. The implementation is a superset of the contract document, which reads as divergence rather than as a documented gap                                                                                                                                                                                                                                                                                           |
| G7  | `/tenants` has no `FEATURE_KEYS` slot, so it is reachable by URL and from tenancy detail but has no nav entry                                                                                             | w1-l3      | Owner `w2-l5` (owns `config/**` in Wave 2). Accepted for now: `listTenants` refuses every non-staff caller before issuing a query, so the absent link was never the control                                                                                                                                                                                                                                                   |

Recorded during Wave 0, deliberately not fixed in it. Each has an owner.

| Gap                                                                                                                                                                                                                                                                                     | Owner                                      | Why deferred                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maintenance_tickets.category` is `text`, not a Postgres enum, so `MAINTENANCE_CATEGORIES` cannot be type-guarded against a generated type — it is asserted against the migration literals in tests instead. A direct database insert could therefore set an arbitrary category string. | `w2-l3` in `0004_security_remediation.sql` | A `check (category in (...))` constraint closes it at the database level more cheaply than a new enum type and a column migration. Server-side Zod validation and the AI prompt contract already constrain every application path, so the residual risk is a direct database write, which requires service-role. |
| Every other `check (... in (...))` list in `0001` has the same property and is likewise asserted in tests rather than typed.                                                                                                                                                            | `w2-l3`                                    | Same reasoning.                                                                                                                                                                                                                                                                                                  |

Two deliberate non-changes, recorded so a later lane does not "fix" them:

- **No `force row level security` anywhere.** `current_profile_id()` reads `public.profiles`; forcing RLS would make that security-definer helper recurse through the policy it is evaluating.
- **`organizations` is read-only for every role, including `organization_admin`.** There is no rename path in this build. Renaming would need a new RPC and is out of MVP scope.

---

## 6. Master path-ownership map

One owner per path per wave. This table is the source for `lanes.json`.

| Path glob                                                                                              | W0       | W1                  | W2                                                     |
| ------------------------------------------------------------------------------------------------------ | -------- | ------------------- | ------------------------------------------------------ |
| `package.json`, root configs, `.github/**`                                                             | L1       | —                   | L6 (deploy only)                                       |
| `app/layout.tsx`, `app/globals.css`, `components/ui/**`                                                | L1       | —                   | —                                                      |
| `components/shell/**`, `config/*.ts`                                                                   | L1       | —                   | L5                                                     |
| `scripts/check-lane-ownership.mjs`, `lanes.json`, `docs/agent-briefings.md`                            | pre-wave | pre-wave            | pre-wave                                               |
| `supabase/migrations/0002_*.sql`                                                                       | L2       | —                   | —                                                      |
| `supabase/migrations/0003_*.sql`                                                                       | L3       | —                   | —                                                      |
| `packages/shared/**`                                                                                   | L4       | —                   | —                                                      |
| `lib/**`                                                                                               | L5       | —                   | L4 (observability, rate-limit only)                    |
| `vitest.config.ts`, `playwright.config.ts`, `tests/_harness/**`, `tests/rls/**`                        | L6       | —                   | L1 (e2e harness only)                                  |
| `scripts/{supabase-local,reset-db,make-jwts}.mjs`                                                      | L6       | —                   | —                                                      |
| `app/(auth)/**`, `app/api/v1/{organizations,members}/**`, `features/organizations/**`                  | —        | L1                  | L3                                                     |
| `app/api/v1/properties/**`, `app/(dashboard)/properties/**`, `features/properties/**`                  | —        | L2                  | L3                                                     |
| `app/api/v1/{tenants,tenancies}/**`, `app/(dashboard)/tenancies/**`, `features/{tenants,tenancies}/**` | —        | L3                  | L3                                                     |
| `app/api/v1/maintenance/**`, `app/(dashboard)/maintenance/**`, `features/maintenance/**`               | —        | L4                  | L3                                                     |
| `services/ai/**`, `app/api/v1/ai/**`, `features/ai-intake/**`, `evals/**`                              | —        | L5                  | L3                                                     |
| `app/api/v1/documents/**`, `services/{workers,extraction}/**`, `features/documents/**`                 | —        | L6                  | L3                                                     |
| `tests/<domain>/**`                                                                                    | —        | owning feature lane | —                                                      |
| `tests/e2e/**`                                                                                         | —        | —                   | L1                                                     |
| `scripts/seed-demo.mjs`, `fixtures/demo/**`                                                            | —        | —                   | L2                                                     |
| `app/(dashboard)/page.tsx`, `app/(dashboard)/dashboard/**`                                             | —        | —                   | L5                                                     |
| `app/api/health/**`, `instrumentation.ts`                                                              | —        | —                   | L4                                                     |
| `README.md`, `docs/**`                                                                                 | —        | —                   | L6 (except L2's walkthrough, L3's audit, L4's runbook) |

---

## 7. Agent briefing template

Each agent receives exactly this, and nothing about the other lanes:

```
Lane: <id> — <title>
Branch: lane/<id>   (own git worktree)
Read first: docs/implementation-plan.md, docs/parallel-execution-plan.md §5, your lane in §2–4
You own ONLY: <glob list>
You may read but NEVER write: packages/shared, lib, supabase/migrations, config
Subtasks: <numbered list from this document>
Exit gate: <lane gate>

Rules
- Never create or edit a file outside your owned globs. If you need such a change,
  STOP and report it as a planning defect. Do not work around it.
- Code against the §5 interface freeze, not against another lane's output. If a frozen
  interface is wrong, report it; do not redefine it locally.
- Every route handler uses withApiHandler. Every mutation writes an audit row.
- Every schema comes from packages/shared. Never define a local duplicate.
- Run `node scripts/check-lane-ownership.mjs --lane <id>` before every commit.
- Done means validation, authorization, error handling, audit, tests, docs.
```

---

## 8. Parallelism honestly stated

Wave 0 is the only real serialization, and it is six-way parallel internally: the two
migration lanes own separate files, contracts and the runtime library are separate
trees, and the RLS suite is written test-first against the frozen matrix rather than
against delivered code. Wave 1 is six genuinely independent verticals. Wave 2 is five
parallel lanes plus one sole-writer remediation lane.

Residual risk is concentrated in one place: if the §5 freeze is wrong, several lanes
build against a bad contract at once. That is the trade for parallelism, and it is why
§5 exists as a document rather than as a conversation between agents.
