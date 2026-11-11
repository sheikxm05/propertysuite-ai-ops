# RLS isolation suite

Lane `w0-l6`. This suite is the project's central claim, in executable form:
**organization A provably cannot reach organization B's data, and a role inside an
organization cannot exceed its grant.** Wave 1 is gated on it.

## Two execution drivers

The suite asserts RLS behaviour, and RLS lives in Postgres. How a statement reaches
Postgres is a transport detail, so there are two transports and the tests cannot tell
which one they are running on.

| | `supabase` (default) | `pg` |
| --- | --- | --- |
| Transport | PostgREST over HTTPS | `psql` straight to Postgres |
| Identity | a real Supabase Auth JWT per principal | `set local role authenticated` plus `request.jwt.claims` |
| Needs | anon + service-role keys, a reachable API | a connection string, nothing else |
| Fixtures written by | the service-role client | the table owner |
| Per-case transaction | no (PostgREST cannot roll back) | yes — every operation is rolled back |
| Storage | HTTP: signed URLs, expiry, MIME | policy level: `storage.objects` RLS |

`auth.uid()` reads `request.jwt.claims->>'sub'`, so the `pg` driver exercises the same
code path a real JWT takes — it sets the same claim PostgREST would. What differs is
only who carries the claim there.

```bash
# default: supabase-js when the stack keys are present
npm run test:rls

# direct Postgres, for a database reachable only by connection string
PS_RLS_DRIVER=pg npm run test:rls
```

Selection is automatic when `PS_RLS_DRIVER` is unset: supabase-js if the anon and
service-role keys resolve, otherwise `pg`. If neither can run, the suite fails with both
reasons printed — it never skips.

### Why the `pg` driver wraps and rolls back every operation

It runs against a real cloud project, not a disposable container, so no assertion may
leave a row behind. Each operation is one transaction:

```sql
begin;
set local role authenticated;                      -- RLS now applies to us
select set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}', true);
<the statement, errors caught in a PL/pgSQL handler>
rollback;                                          -- the database is left as found
```

Two consequences worth knowing before reading the tests:

- An **allowed** write is proven by its own `RETURNING` clause, inside the transaction,
  not by a follow-up read. A follow-up read would see the pre-write value, because the
  write was deliberately undone. What is asserted is that the write was *accepted*.
- The whole batch is sent as ONE round trip, joined with psql's `\;`. On the live
  pooler a round trip costs ~0.3 s and a process spawn ~3.2 s, so the obvious shape —
  one `psql -c` per assertion — would have taken over half an hour and produced a gate
  nobody would run.

Errors are caught server-side in a PL/pgSQL exception handler and returned as part of
the result payload, rather than scraped from stderr. psql writes errors to a separate
pipe with no ordering guarantee against stdout, so correlating "which of 1,600
operations produced this error" would be guesswork — and this suite checks exact
SQLSTATEs.

`pg` is not in the frozen dependency list (§5.1) and no lane may install one, which is
why the transport is the `psql` binary rather than a Node client.

## Running it

The suite needs a real Postgres with RLS active. There is no mock mode and there must
never be one — a mock does not enforce a policy, so a mocked suite is green by
construction.

```bash
node scripts/supabase-local.mjs doctor   # preflight: Docker, CLI, config.toml, migrations
npm run db:start                         # start the local stack and apply migrations
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

## What a live run actually produced

Until 2026-11-12 this suite had never been executed end to end. It has now run against
the real Supabase project over the Supavisor session pooler, `PS_RLS_DRIVER=pg`, all
three migrations applied:

```
Test Files  7 (912 cases)
Tests       901 passed | 8 skipped | 3 failed
Duration    1714 s

RLS POLICY COVERAGE
matrix cells        : 320
assertions recorded : 932
policies in SQL     : 70
policies exercised  : 70
coverage gaps       : 0
```

The eight skips are `storage.test.ts`'s HTTP cases — signed-URL minting, expiry and
signature-vs-path — which PostgREST is not in play to serve on the `pg` driver. They
report as skipped rather than passing, which is the point.

The three failures, named rather than summarised:

| Case                                                                                      | Verdict                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `role-scoping > a service provider … sees the tenant's name but not their email or phone` | **A real defect**, reproducible on every run. See "Open finding" below. Not this lane's to fix and deliberately left failing.                                                                                                       |
| `cross-organization > filtering by the other organization_id returns nothing, for every role` | A 60 s **timeout**, not a denial that failed. One `it` makes 2 x 5 x 14 = 140 sequential round trips; at 0.45 s each that is 63 s. `testTimeout` for the RLS suite is now 300 s, which measures policies instead of the network. |
| `cross-role > ai_messages > service_provider cannot UPDATE`                               | The same timeout, from a single ~70 s pooler stall between two neighbours that took 0.5 s and 1.2 s. Same fix.                                                                                                                      |

A timeout reads exactly like an isolation failure in a report and is not one, so neither
was left to be re-interpreted later.

The database was left byte-for-byte as it was found — ticket, activity, audit, property
and document counts were identical before and after, because every assertion runs inside
a transaction that is rolled back.

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
   times two organizations. Two extra secondary tenants exist so "a tenant cannot read
   another tenant's row" is asserted from a second real session rather than inferred
   from the first one's result.
2. **The privileged client never satisfies an assertion.** Service-role over HTTP, table
   owner over psql; both bypass RLS, so an assertion made through either would pass
   against a database with no policies at all. They seed the world and answer "did that
   write land?", never "was the caller allowed to?". The one deliberate exception is
   adversarial: proving the `maintenance_activities` immutability trigger binds the
   privileged client too, which is a claim about the trigger rather than about access
   control.
3. **A denial must be denied for the right reason.** A missing column, a null violation
   and an RLS refusal all produce "an error". The helpers require the SQLSTATE to be an
   authorization refusal and fail loudly on anything else, naming the code they got. A
   test that accepts "some error happened" proves nothing while reading as if it proved
   everything.
4. **A rejection must also be rejected for the right reason.** The mirror image, and the
   one that actually shipped: a recursive policy made every ticket INSERT fail with
   `42P17`, and the cross-role case only asserted that the tenant's insert *succeeds*.
   `ticket-creation.test.ts` now checks that code explicitly.
5. **A filtered-out row is not an error.** An UPDATE or DELETE that RLS makes invisible
   returns zero rows and no error. The write helpers assert zero affected rows *and*
   confirm through a second authenticated principal that the value did not change.
6. **Positive assertions are mandatory.** Where the matrix grants access, the suite
   proves the access works. Otherwise a broken migration that locks everyone out looks
   like perfect security.
7. **Tables come from the migrations, not from judgement.** `tests/_harness/tables.ts`
   parses `supabase/migrations/*.sql`; `tests/_harness/harness.test.ts` fails if any
   table carrying `organization_id` is missing from the registry, so a table added in a
   later sprint cannot slip through untested. That is how `organization_invitations`
   (amendment A4) arrived in the suite.
8. **The two organizations look identical.** Same property names, same unit numbers,
   same tenant names, same ticket titles, same contract numbers. A leak cannot be
   spotted by eye, so every assertion compares identifiers.
9. **Nothing is skipped silently.** A case outside the active driver's reach calls
   `ctx.skip()` and shows as skipped. A storage assertion that quietly passed would be
   indistinguishable from one proving the bucket is wide open.

## Seeding is idempotent, and a live database stays as it was found

Every fixture id is derived from a stable key, so seeding is an upsert. Two details are
load-bearing and were both learned by running it twice:

- **`maintenance_activities` is inserted with `on conflict do nothing`.** An upsert that
  updated an existing activity row would be refused by the immutability trigger — the
  guarantee `negative-writes.test.ts` asserts. Append-only means append-only, including
  for the harness.
- **Ticket `status` is not part of the upsert payload.** New rows take the column default
  (`open`, per §4) and `ensureTicketStatus` walks forward from wherever the row actually
  is. Writing `open` over a ticket already at `in_progress` is an illegal transition,
  correctly rejected, which would make the fixture un-reseedable.

Anything that genuinely mutates uses a throwaway ticket from `tests/_harness/scratch.ts`,
and the state-machine suite deletes those in `afterAll`. Scratch tickets are safe to
delete precisely because they have no activity rows: nothing auto-writes one, and an
activity row could not be removed afterwards.

The two fixture organizations themselves persist. That is not an oversight — their
activity rows are append-only by design, so a ticket that owns one can never be deleted
either. A live project therefore keeps the two fixture organizations once the suite has
run against it, and `fixtureObjectPaths` plus the deterministic ids make a re-run reuse
them rather than accumulate more.

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

### "Not evaluated" is a third answer, and the gate uses it

Run `npx vitest run` with no RLS filter and the gate stays silent: `tests/rls/**` is
excluded, the global setup is never registered, and nothing is reported. Run it with
`PS_RLS=1` but a filter that happens to match no RLS file and the teardown prints
`RLS POLICY COVERAGE — NOT EVALUATED` and exits 0.

Neither reports 754 coverage gaps, which is what an empty ledger literally measures. A
gate that cries wolf on somebody else's default command stops being read, and the first
thing a disbelieved gate loses is the one run where it was right.

### The ledger survives a concurrent run

Starting a second `PS_RLS=1` invocation while the suite was mid-flight used to delete
the running ledger: part files were scoped to a run id, but `resetCoverageDirectory()`
deleted every file that was not this run's. A 600-record ledger went to zero and the
suite then reported gaps for cells it had already proven. Parts from another run are now
left alone unless they are more than an hour stale.

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

## Open finding: a provider can read tenant email and phone

`role-scoping.test.ts > sees the tenant's name but not their email or phone` **fails
against the live database**, and the failure is correct.

The §4 matrix grants `service_provider` "R name only, via assignment" on `tenants`.
`tenants_select_provider_assigned` implements the *row* half of that correctly — a
provider reaches only the tenant of a ticket assigned to them — but there is no column
restriction, and Supabase's default grants give `authenticated` column-level SELECT on
every column:

```
information_schema.column_privileges, grantee 'authenticated', table 'tenants'
  SELECT:full_name, SELECT:email, SELECT:phone   <- all three

as the provider principal:
  select full_name, email, phone from public.tenants;
  Omar Haddad | omar.haddad@resident.test | +971500000101
```

RLS filters rows, not columns, so no policy can close this. It needs a column-level
grant, a name-only view, or a security-definer accessor — a decision for the lane that
owns `0002`, not for this one. Reported as a defect; the assertion stays as written.

Scope, stated plainly: a contractor assigned one job learns that tenant's direct contact
details. It is not a cross-organization leak and not a cross-tenant leak — the row is
one the provider is entitled to see — but it is more of that row than §4 grants.

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
