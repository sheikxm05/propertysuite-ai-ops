# RLS isolation suite

Lane `w0-l6`. This suite is the project's central claim, in executable form:
**organization A provably cannot reach organization B's data, and a role inside an
organization cannot exceed its grant.** Wave 1 is gated on it.

## Running it

The suite needs a real Postgres with RLS active. There is no mock mode and there must
never be one — a mock does not enforce a policy, so a mocked suite is green by
construction.

```bash
node scripts/supabase-local.mjs doctor   # preflight: Docker, CLI, config.toml, migrations
npm run db:start                         # start the stack and apply migrations
npm run test:rls                         # the suite
```

`npm test` deliberately does **not** include it: `vitest.config.ts` discovers
`tests/rls/**` only when it is named on the command line (which `npm run test:rls`
does) or when `PS_RLS=1` is set. CI runs the two as separate jobs for the same reason.

Useful extras:

```bash
node scripts/make-jwts.mjs               # the ten principals, tokens redacted
node scripts/make-jwts.mjs --list        # catalog only, no network
node scripts/reset-db.mjs                # rebuild from migrations; fixtures re-seed
node scripts/supabase-local.mjs env      # export lines for .env.local
```

## What it asserts

| File                         | Claim                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cross-organization.test.ts` | For every tenant-scoped table, SELECT, INSERT, UPDATE and DELETE are all denied across the boundary, for every role, in both directions. Plus enumeration by `organization_id` filter, IDOR by known row id, and the anonymous caller.                                                               |
| `cross-role.test.ts`         | The §4 matrix, cell by cell, inside one organization — including the positive cases, so a database that denies everything cannot pass.                                                                                                                                                               |
| `role-scoping.test.ts`       | The acceptance criteria in their own words: a tenant cannot reach another tenant's PII, a provider sees exactly its assigned job, an owner sees only owned property, only an admin reads `audit_logs`, `profiles` leaks nothing across organizations.                                                |
| `negative-writes.test.ts`    | No DELETE anywhere; `maintenance_activities` immutable even to the service role; related rows cannot be stitched across organizations; provenance cannot be forged (assistant turns, notifications, `uploaded_by`, audit rows); the job queue is invisible; the invitation token hash is unreadable. |
| `state-machine.test.ts`      | The database rejects every illegal `(from, to)` pair and accepts every legal one, generated from `ALLOWED_TRANSITIONS` in `packages/shared`. Plus the role gates: a provider cannot approve its own work, a tenant withdraws only while `open`, an owner drives nothing.                             |
| `storage.test.ts`            | The bucket is private; a signed URL for another organization's object is refused; an expired URL is refused; a signature does not survive a path rewrite; nobody deletes an object; non-PDF content is refused.                                                                                      |

## Rules this suite holds itself to

1. **Every assertion runs as a real authenticated principal.** Ten of them: five roles
   times two organizations, signed in through Supabase Auth, holding real JWTs. Two
   extra secondary tenants exist so "a tenant cannot read another tenant's row" is
   asserted from a second real session rather than inferred from the first one's result.
2. **The service-role client never satisfies an assertion.** It seeds fixtures. It
   bypasses RLS, so an assertion made through it would pass against a database with no
   policies at all. The one deliberate exception is adversarial: proving that the
   `maintenance_activities` immutability trigger binds the service role too, which is a
   claim about the trigger rather than about access control.
3. **A denial must be denied for the right reason.** PostgREST returns an error for a
   missing column, a null violation and an RLS refusal alike. The helpers require the
   SQLSTATE to be an authorization refusal and fail loudly on anything else, naming the
   code they got. A test that accepts "some error happened" proves nothing while reading
   as if it proved everything.
4. **A filtered-out row is not an error.** An UPDATE or DELETE that RLS makes invisible
   returns HTTP 200 with zero rows. The write helpers assert zero affected rows _and_
   confirm through a second authenticated principal that the value did not change.
5. **Positive assertions are mandatory.** Where the matrix grants access, the suite
   proves the access works. Otherwise a broken migration that locks everyone out looks
   like perfect security.
6. **Tables come from the migrations, not from judgement.** `tests/_harness/tables.ts`
   parses `supabase/migrations/*.sql`; `tests/_harness/harness.test.ts` fails if any
   table carrying `organization_id` is missing from the registry, so a table added in a
   later sprint cannot slip through untested.
7. **The two organizations look identical.** Same property names, same unit numbers,
   same tenant names, same ticket titles, same contract numbers. A leak cannot be
   spotted by eye, so every assertion compares identifiers.

## The coverage gate

Green is not the gate. The gate is that **every policy in the §4 matrix is exercised by
at least one passing assertion**, which is a different claim — delete a test and a suite
stays green while its coverage quietly shrinks.

So every helper registers what it just proved, and the global teardown reconciles three
sets: the matrix cells, the assertions that passed, and every `create policy` parsed out
of the migrations. Three distinct failures become visible instead of one vague pass:

- a matrix cell no assertion covers — the suite has a hole;
- a policy in the SQL no exercised cell claims — something in the database is untested;
- a matrix cell no SQL policy implements — the migration does not meet the spec.

The first two fail the run. The third is reported loudly but does not fail it, because
this lane does not own the migrations.

Report: `test-results/policy-coverage/policy-coverage.md`, plus a summary on stdout.

## Fixture shape

Both organizations get the same structure. The asymmetries are load-bearing.

```
properties      P1 "Marina Heights Tower"            owned by the owner principal
                P2 "Downtown Boulevard Residences"   owned by nobody
units           P1/1204, P1/1808, P2/1204, P2/1808   same numbers in both buildings
tenants         T1 (tenant principal), T2 (secondary tenant principal)
tenancies       TC1 T1 -> P1/1204,  TC2 T2 -> P1/1808,  TC3 T2 -> P2/1204
providers       SP1 (provider principal), SP2
tickets         K1 P1/1204 T1 assigned to SP1   <- the provider's ONLY job
                K2 P1/1204 T1 open, unassigned  <- same unit, still invisible to SP1
                K3 P1/1808 T2 in_progress, SP2
                K4 P2/1204 T2 open              <- outside the owner's building
documents       D1 -> P1 + TC1    D2 -> P2 + TC3    evidence -> K1
```

Every row id is derived from a stable key, so seeding is an upsert and re-running the
suite without a database reset is idempotent. Anything that genuinely mutates state uses
a throwaway ticket from `tests/_harness/scratch.ts` instead of the shared fixture.

## Spec amendments this suite tracks

The §4 matrix has moved since it was first frozen; the suite asserts the current text
plus the `parallel-execution-plan.md` §5.8 amendment log, not the original:

- **A5** — bucket id `documents`. `storage.test.ts` uses it directly rather than guessing.
- **A6** — `profiles` gains self-scoped UPDATE; creation moved to an `auth.users` trigger,
  so no role has a client INSERT on `profiles`.
- **A7** — `service_provider` gains `documents` SELECT and INSERT scoped to an assigned
  ticket. This depends on `documents.ticket_id`: `0003` adds the column and then calls
  `ensure_document_provider_policies()`, which `0002` defines. The harness probes for the
  column, and `role-scoping.test.ts` fails with that chain named if it is absent — so a
  half-applied migration cannot look like an RLS finding.
- **A8** — `organization_admin` gains INSERT on `maintenance_activities`.
- **A9** — the rework edge `awaiting_approval -> in_progress` (staff only) and the cancel
  rules. Picked up automatically: `state-machine.test.ts` derives its legal and illegal
  edge sets from `ALLOWED_TRANSITIONS` and `TRANSITION_ROLES` in `packages/shared`.

Two deliberate non-changes the suite must NOT assert against: there is no
`force row level security` anywhere (`current_profile_id()` reads `public.profiles`, so
forcing it would make that security-definer helper recurse through the policy it is
evaluating), and `organizations` is read-only for every role including the admin.
