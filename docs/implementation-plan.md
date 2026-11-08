# Implementation Plan — Production-Grade MVP

Status: **planning complete, build not started.**
Scope decided: full MVP with fine-grained Row Level Security applied, built to a
production bar, optimised for a credible end-to-end demonstration.

Supersedes the generic sprint outline preserved in `implementation-plan.blueprint.md`.

**Parallel execution:** the nine sprints below are re-cut into three waves of six
non-overlapping agent lanes in `parallel-execution-plan.md`. That document holds the
path-ownership map and the interface freeze; this one holds scope, security model and
rationale. The two are consistent — read this first, then that one to execute.

---

## 1. Guiding principles

1. **Security is the feature.** Every acceptance criterion in `requirements.md` §6 is
   an authorization claim. Authorization is enforced twice — Postgres RLS as the
   floor, server-side checks in route handlers as the gate. A defect in one layer
   must not be exploitable because the other still holds.
2. **Isolation is proven before features are built on it.** The RLS test suite lands
   before the first CRUD screen, not after.
3. **AI is advisory, never consequential.** The model drafts; a human commits. No
   service-role credentials, no database tools, no privileged action reachable from
   model output.
4. **Done means done.** Validation, authorization, error handling, audit record,
   tests, docs. A working happy path is not a completed feature.
5. **No hard deletes.** Business records are archived. Financial and audit history is
   append-only.

---

## 2. Scope

### In scope — built to done

- Supabase Auth sign-in/out, organization onboarding, member invitations, five org roles
- Fine-grained RLS across all tenant-scoped tables, plus private Storage policies
- Property and unit management with archive
- Tenant records and tenancy lifecycle
- Full maintenance workflow with a deterministic state machine and immutable activity history
- Audit logging on every critical state change
- Role-specific dashboards for all five organization roles
- AI maintenance intake: schema-validated classification returned as a **draft**; ticket created only on explicit human confirmation
- Document intelligence: private PDF upload, asynchronous extraction, human verification gate
- Simple durable job runner (database-backed table, bounded retries, dead-letter state)
- In-app notifications

### Deferred — explicitly out of this build

- WhatsApp Cloud API, Stripe, Google Drive sync, outbound email delivery
- RAG over authorized documents (see §9)
- Platform-administrator console (service-role operations only)
- Market data synchronization, property valuation, listing marketplace

---

## 3. Security findings this plan closes

Defects and gaps in `supabase/migrations/0001_initial_schema.sql`, all addressed in
migration `0002`.

| #   | Finding                                                       | Impact                                                                                        | Fix                                                                            |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | `organizations` has no RLS enabled                            | Any authenticated user enumerates every tenant organization                                   | Enable RLS; read restricted to own memberships                                 |
| 2   | `profiles` has no RLS enabled                                 | Any authenticated user reads every user's name, email and phone, platform-wide                | Enable RLS; self plus same-org visibility; tenants and providers see self only |
| 3   | Policies only test `is_org_member()`                          | A tenant reads every other tenant's PII, every tenancy and every document in the organization | Role-, self- and assignment-scoped policies                                    |
| 4   | Service providers have organization-wide ticket read          | Violates acceptance criterion 7                                                               | Restrict to `assigned_provider_id` matching the caller                         |
| 5   | `for all` policies grant DELETE                               | Hard deletion of tenancy and financial records                                                | Remove DELETE grants; archive status instead                                   |
| 6   | `maintenance_activities` immutable only by omission of policy | "Immutable history" is not actually guaranteed                                                | Explicit revoke plus a block trigger on UPDATE/DELETE                          |
| 7   | `audit_logs` readable by any member                           | Audit trail visible to tenants and providers                                                  | Organization-admin read only                                                   |
| 8   | No INSERT policy on `organizations` / `organization_members`  | Onboarding and invitation impossible from the client                                          | Intentional: route through `security definer` RPCs                             |
| 9   | `properties.owner_member_id` FK omits `organization_id`       | Cross-organization owner assignment is structurally possible                                  | Composite foreign key                                                          |
| 10  | `documents` stores extracted fields but not source text       | Adding retrieval later would require reprocessing every document                              | Add `extracted_text` now                                                       |

---

## 4. Target RLS model

### Helper functions

`current_profile_id()` and `is_org_member()` already exist. Added in `0002`, all
declared `stable security definer set search_path = ''`:

- `has_org_role(org uuid, roles public.member_role[]) returns boolean`
- `is_org_staff(org uuid) returns boolean` — organization_admin or property_manager
- `current_tenant_id(org uuid) returns uuid`
- `current_provider_id(org uuid) returns uuid`
- `owns_property(org uuid, property_id uuid) returns boolean`
- `can_access_unit(org uuid, unit_id uuid) returns boolean` — active tenancy for the caller

All predicates are wrapped as `(select ...)` inside policy bodies so the planner
caches them per statement rather than evaluating per row.

### Policy matrix

`R` read, `W` write, `C` create, `U` update, `A` archive. No `DELETE` is granted on any
table. Onboarding and invitation writes go through RPCs, not direct policies.

| Table                              | organization_admin | property_manager  | property_owner    | tenant                     | service_provider                   |
| ---------------------------------- | ------------------ | ----------------- | ----------------- | -------------------------- | ---------------------------------- |
| `organizations`                    | R own              | R own             | R own             | R own                      | R own                              |
| `profiles`                         | R self + same-org  | R self + same-org | R self + same-org | R self only                | R self only                        |
| `organization_members`             | RW                 | R                 | R                 | R self                     | R self                             |
| `properties`                       | RWA                | RWA               | R owned           | R via tenancy              | R via assigned ticket              |
| `property_units`                   | RWA                | RWA               | R owned           | R leased                   | R via assigned ticket              |
| `tenants`                          | RW                 | RW                | —                 | R self only                | R name only, via assignment        |
| `tenancies`                        | RW                 | RW                | R owned           | R own                      | —                                  |
| `service_providers`                | RW                 | RW                | —                 | —                          | R self                             |
| `maintenance_tickets`              | RW                 | RW                | R owned           | CR own, confirm completion | R + U assigned only, status subset |
| `maintenance_activities`           | R                  | CR                | R owned           | CR own tickets             | CR assigned tickets                |
| `documents`                        | RW                 | RW                | R owned           | R own tenancy              | —                                  |
| `ai_conversations` / `ai_messages` | R                  | R                 | —                 | CR own                     | —                                  |
| `notifications`                    | R own              | R own             | R own             | R own                      | R own                              |
| `audit_logs`                       | R                  | —                 | —                 | —                          | —                                  |

### Storage

Single private bucket. Object path convention `{organization_id}/{entity}/{uuid}.pdf`;
storage policies derive the organization from the first path segment and require active
membership. Signed URLs expire in 60 seconds. No public bucket exists.

### Ticket state machine

`open → assigned → in_progress → awaiting_approval → completed`, with `cancelled`
reachable from any non-terminal state. Enforced in the domain service **and** by a
database trigger. Illegal transitions return `409`. A service provider may only drive
`assigned → in_progress → awaiting_approval`; only a manager or the reporting tenant
may close to `completed`.

---

## 5. Sprint plan

### Sprint 0 — Foundation

- `git init`, Next.js App Router + TypeScript (strict), Tailwind, shadcn/ui
- ESLint with a rule forbidding server-only imports from client modules
- Zod-parsed environment validation that fails fast at boot
- Supabase browser and server client helpers; service-role client isolated to a server-only module
- Local Supabase stack via Docker; `.env.local` gitignored before any secret exists
- CI: typecheck, lint, test, plus a scan asserting no secret appears in the client bundle

**Exit gate:** build and CI pass on an empty app; no secret reachable from the browser bundle.

### Sprint 1 — Migration `0002`: security hardening and fine-grained RLS

- Helper functions from §4
- Replace all baseline policies with the §4 matrix
- Immutability trigger and revokes on `maintenance_activities`
- Ticket transition trigger
- `security definer` RPCs: `create_organization`, `invite_member`, `accept_invitation`
- Composite foreign key fix on `properties.owner_member_id`; add `documents.extracted_text`
- `create extension if not exists vector` (unused; keeps migration history clean for §9)
- Job table: `jobs(id, type, payload, idempotency_key unique, attempts, next_run_at, status, last_error)`

**Exit gate:** migration applies cleanly to a fresh database and is idempotent on re-run.

### Sprint 2 — RLS test harness and isolation suite

- Vitest harness that signs in as each role in each of two organizations and holds real JWTs
- Assertions for SELECT, INSERT, UPDATE and DELETE denial across organizations and across roles
- Specific cases: tenant cannot read another tenant's PII; provider sees exactly one assigned job; owner sees only owned properties; cross-organization identifier mismatch rejected; activity rows cannot be updated or deleted

**Exit gate (hard):** the isolation suite passes and is wired into CI. No feature work begins before this gate is green.

### Sprint 3 — Identity and organizations

- Sign-in and sign-out, session handling, protected route middleware
- Organization creation through `create_organization`
- Invitation issue and acceptance flows
- Role resolution helper used by every handler; role-aware navigation shell

**Exit gate:** a second user can be invited, accept, and receive exactly their role's visibility.

### Sprint 4 — Properties and units

- Property and unit CRUD plus archive; owner and manager association
- Zod schemas shared between client form and server handler
- Audit record on every mutation
- Manager and owner dashboard views

**Exit gate:** the contracts in `api-contracts.md` implemented with the standard error envelope; authorization tests pass.

### Sprint 5 — Tenants and tenancies

- Tenant records, optional linkage to an application user
- Tenancy lifecycle: draft, active, expired, terminated; date and rent validation
- Tenant self-service view of own tenancy only

**Exit gate:** a signed-in tenant sees their own tenancy and provably cannot read another's.

### Sprint 6 — Maintenance workflow

- Ticket creation by a tenant for an authorized unit only
- Manager triage, prioritization and assignment within the organization
- Provider job list, status updates, completion evidence upload
- Completion confirmation by manager or tenant
- Activity history timeline rendered from the immutable table

**Exit gate:** the state machine rejects every illegal transition in tests; the provider view contains only assigned work.

### Sprint 7 — AI maintenance intake

- Provider-neutral AI adapter; `classify()` returns a validated object or throws
- Versioned prompt and JSON schema in source, per `docs/ai-prompts/maintenance-classification.md`
- Untrusted-content fencing as the adapter's only input path; user or document text never enters the system role
- `POST /ai/maintenance/classify` returns a draft and creates nothing
- `POST /ai/maintenance/confirm` creates the ticket through the normal domain service
- Clarification UX when unit context is ambiguous
- Per-user rate limiting; token, latency and outcome logging with no document text logged
- Evaluation set: correct HVAC and plumbing classification, missing-context clarification, prompt-injection attempt treated as data, malformed JSON rejected safely

**Requires:** `ANTHROPIC_API_KEY`. Every earlier sprint is unblocked without it.

**Exit gate:** the evaluation set passes; no model output path can reach a privileged action.

### Sprint 8 — Document intelligence

- Signed-URL upload to the private bucket; MIME, extension and size validation
- Job runner processing extraction with bounded exponential backoff and a dead-letter state
- Text and structured field extraction per `docs/ai-prompts/document-extraction.md`
- Fields persisted as `pending` and surfaced in a human verification UI
- Verified values written only on authorized confirmation, with an audit record

**Exit gate:** extraction is never treated as verified without a human action; a failing job lands in dead-letter rather than retrying forever.

### Sprint 9 — Hardening and demonstration

- Playwright end-to-end covering the ten-step scenario in `docs/test-plan.md`
- Full pass over `docs/security-checklist.md`, item by item
- Structured logging with correlation identifiers; error boundaries; rate limits reviewed
- Seed script: two organizations with deliberately similar-looking data, one user per role
- Scripted demo walkthrough, including the cross-organization denial beat
- Deployment

**Exit gate:** every release gate in `docs/test-plan.md` is green.

---

## 6. Demonstration narrative

The sequence the build is optimised for:

1. Sign in as a tenant and describe a broken air conditioner in plain language.
2. The assistant returns a structured draft — category, summary, symptoms, suggested priority.
3. The tenant confirms; only then does a ticket exist.
4. The manager sees it, prioritizes it and assigns a provider.
5. The provider signs in and sees exactly one job and nothing else.
6. The provider progresses and completes it with evidence; the manager confirms.
7. The activity timeline shows every transition, unalterable.
8. Sign in as the second organization's administrator — none of those records exist.

Step 8 is the point of the project and belongs in the demo, not merely in a test log.

---

## 7. Decisions and assumptions

| Area              | Decision                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| AI provider       | Anthropic by default, behind a swappable adapter                         |
| PDF text          | `pdf-parse`; no OCR in this build                                        |
| Queue             | Database-backed job table, not a hosted queue service                    |
| UI                | Tailwind plus shadcn/ui                                                  |
| Local environment | Supabase CLI stack on Docker; credentials generated locally              |
| Deployment        | Vercel plus Supabase cloud, or local-only demo — confirm before Sprint 9 |
| Locale            | AED, Dubai, `en-AE`                                                      |
| Deletion          | Archive only; no destructive endpoints                                   |

---

## 8. Inputs required

| Value                                                             | Needed by                    | Source                                                     |
| ----------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                               | Sprint 7                     | Written directly into `.env.local`, never pasted into chat |
| Cloud Supabase URL, anon key, service-role key, database password | Sprint 9, only if deployed   | Supabase dashboard                                         |
| `SUPABASE_ACCESS_TOKEN` and project reference                     | Sprint 9, only for `db push` | Supabase dashboard, or apply SQL manually                  |
| Demo organization and user names                                  | Sprint 9                     | Defaults available                                         |

Generated locally, not required from anyone: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_BASE_URL`, `AI_PROVIDER`.

Unused in this build, to be commented out of `.env.example` as later-phase:
`WHATSAPP_*`, `STRIPE_*`, `RESEND_API_KEY`, `GOOGLE_CLIENT_*`.

---

## 9. Retrieval-augmented generation — deferred, with seams

RAG over authorized documents stays out of the MVP, consistent with `requirements.md`
§4 and its P2 label in `backlog.md`. Rationale: it competes with the
intake-to-resolution narrative for attention, it concentrates the hardest
authorization problem in the project, and document intelligence already demonstrates
language-model work over private documents behind a verification gate.

Three low-cost seams are built now so adding it later is additive:

- `vector` extension enabled in `0002`, unused
- `documents.extracted_text` populated from Sprint 8, so the corpus accrues from the start
- Untrusted-content fencing and strict output validation built into the AI adapter in Sprint 7, which retrieval then inherits

Adding it later is scoped as: a `document_chunks` table keyed
`(organization_id, document_id, embedding)`; an embedding job on the existing job
table; a `security definer` retrieval function that scopes by organization and
authorized property **before** the similarity search; RLS tests for
cross-organization chunk denial; and a retrieval UI. Roughly two to three days as its
own slice, sequenced after Sprint 9 so it cannot destabilize the hardened build.

---

## 10. Definition of done

A feature is complete when it has input validation, server-side authorization, RLS
coverage proven by test, error handling with the standard envelope, an audit record
for state changes, unit and integration tests, and documentation. Critically:
isolation is demonstrated by a passing adversarial test, not asserted in prose.
