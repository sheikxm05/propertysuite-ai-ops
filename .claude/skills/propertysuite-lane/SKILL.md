---
name: propertysuite-lane
description: Operating procedure for a single PropertySuite lane agent working in parallel with five others. Use when assigned a lane id (w0-l1 … w2-l6), when told to build a wave-0/1/2 lane, or when any work in this repo must respect path ownership from lanes.json. Covers the read order, ownership enforcement, the interface freeze, security invariants, how to report a planning defect instead of working around it, and the hard prohibition on creating Artifacts.
---

# Working a PropertySuite lane

You are **one of six agents working in parallel on this repository right now.** Five
other agents are editing files beside you. Everything below exists so that none of your
work collides with theirs.

Your lane id looks like `w0-l4` or `w1-l2`. If you were not given one, stop and ask
which lane you are. Do not guess, and do not start work "generally" — there is no
unassigned work in this repo.

## Objective and goal

The objective is a production-grade MVP of a multi-tenant property-operations app, built
six-ways-parallel with zero file overlap.

Success is not "my feature works." It is:

1. Organization A provably cannot reach Organization B's data — in RLS _and_
   server-side, proven by adversarial tests.
2. Role boundaries hold inside an organization — no tenant sees another tenant's PII; no
   provider sees unassigned work.
3. AI drafts, humans commit.
4. Six lanes merge conflict-free **by construction**, not by resolution.

Your lane is complete when it advances all four without damaging any.

## Absolute prohibitions

1. **Never create, publish or offer an Artifact.** Do not call the Artifact tool. No
   artifact pages, hosted previews or shareable links — not for reports, dashboards,
   diagrams, audit write-ups, test summaries or demos. Deliverables are files in this
   repository and text in your final message. If something should be shareable, write
   Markdown under `docs/` **inside your owned paths** and say so. No exceptions.
2. **Never write outside your owned globs** in `lanes.json` — not even a one-line
   import or a typo fix.
3. **Never install a dependency.** The list is frozen (§5.1) and pre-installed.
4. **Never duplicate a shared schema, enum, type or error code** (§5.2, §5.4).
5. **Never edit** `lanes.json`, `scripts/check-lane-ownership.mjs`,
   `docs/parallel-execution-plan.md`, `docs/agent-briefings.md`, or another lane's
   migration file.

## Read in this order, before writing any code

1. `CLAUDE.md` — non-negotiable rules
2. `docs/requirements.md` — scope and the ten acceptance criteria
3. `docs/implementation-plan.md` — security model, the §4 RLS matrix
4. `docs/parallel-execution-plan.md` **§5 — the interface freeze.** The most important
   section in the project. Non-negotiable.
5. `docs/api-contracts.md` — route shapes and status codes
6. Your lane block in `docs/agent-briefings.md`

Code against §5, never against another agent's output. You cannot see their work in
progress, and you must not wait for it. If a frozen interface looks wrong, report it —
do not redefine it locally.

## Establish your boundary first

```bash
node scripts/check-lane-ownership.mjs --list          # confirm your globs
node scripts/check-lane-ownership.mjs --overlaps      # sanity: map is collision-free
```

Then, before **every** commit:

```bash
node scripts/check-lane-ownership.mjs --lane <your-id>
```

A violation is not a hurdle to clear. It means the plan assigned you work you cannot
legally do. Revert the offending path and report it (see below). Never widen a glob,
never edit `lanes.json`, never copy a file into your territory to get around it.

Optional belt-and-braces: `export CLAUDE_LANE=<your-id>` activates the PreToolUse guard
in `.claude/settings.json`, which blocks an out-of-lane write before it happens.

## Security invariants — the point of the project

- Authorization is enforced **twice**: Postgres RLS _and_ server-side checks. Never rely
  on one alone. Assume the other layer has a bug.
- Never trust a client-supplied `organization_id` in a body, query string, header or
  cookie. Derive membership from trusted rows via `resolveMembership()`.
- The service-role client is importable only from server-only modules. It bypasses RLS —
  never use it to satisfy an assertion in a test, or every test passes meaninglessly.
- No DELETE on any tenant-scoped table. Archive.
- `maintenance_activities` is immutable, including to service-role.
- AI output is advisory. If you are writing a path where model output reaches a mutation
  without an authenticated human confirmation in between, stop — that is the one thing
  this project must not do.
- Never log document text, message bodies, tokens or PII.

## Build conventions

- Every API route handler goes through `withApiHandler` (§5.2). It supplies
  authentication, authorization, Zod validation, rate limiting, audit writing, logging
  and the error envelope. Do not hand-roll any of those.
- Every mutation writes an audit row.
- Every error response uses the frozen envelope and one of the frozen eight codes.
- Every schema comes from `packages/shared`.
- Money is `numeric(12,2)` plus an ISO currency code — never a float.
- Cursor pagination: default 25, maximum 100.
- Match the surrounding code's naming, comment density and idiom.

## Reporting a planning defect

The correct response to any cross-boundary need. In your final output:

```
PLANNING DEFECT
  Lane: <your id>
  Needed: <exact path(s) and the change required>
  Owner: <lane id from the validator output>
  Why: <what your lane cannot complete without it>
  Workaround used: none / <the narrow, reversible stopgap, if any>
```

Then continue with everything in your lane that does **not** depend on it. Deliver the
rest in full; never stall the lane on one blocked item. The orchestrator resolves
defects centrally and re-briefs — agents never negotiate with each other directly.

## Definition of done — all seven

Input validation · server-side authorization · RLS coverage proven by test · the frozen
error envelope · an audit row for every state change · unit and integration tests ·
short docs.

A passing happy path is not done. Neither is "tests written but not run."

## Final output format

```
LANE: <id> — <title>
BUILT: <what you delivered, in two or three lines>
FILES: <created and modified, all inside owned globs>
OWNERSHIP CHECK: <paste the validator output verbatim>
TESTS: <command and result, verbatim, failures included>
EXIT GATE: met / not met — <evidence, or exactly what is missing>
PLANNING DEFECTS: none / <blocks as formatted above>
```

Report faithfully. If tests fail, show the output. If you skipped something, say so and
say why. A lane reported as complete when it is not corrupts the wave gate, and the next
six agents build on top of the gap.
