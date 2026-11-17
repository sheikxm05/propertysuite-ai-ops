# PropertySuite AI Operations Assistant

Multi-tenant Dubai property-operations application. Next.js App Router + TypeScript
(strict), Supabase (Auth, Postgres, Storage, RLS), Zod, Anthropic behind a
provider-neutral adapter. Modular monolith.

Independent portfolio project inspired by publicly described PropertySuite workflows.
Not PropertySuite source code, not an official assignment, no connection to their
production systems.

## Objective

Ship a production-grade minimum viable product that demonstrably enforces multi-tenant
isolation, built by **six agents working in parallel** with zero file overlap.

## Goal — how success is judged

Not "the features work." Success is:

1. **Organization A provably cannot reach Organization B's data** — enforced in
   Postgres RLS _and_ server-side, proven by adversarial tests, and visible on screen
   in the demo.
2. **Role boundaries hold inside an organization** — a tenant cannot see another
   tenant's personal data; a service provider sees only assigned jobs.
3. **AI drafts, humans commit** — no model output causes a state change without an
   explicit authenticated human confirmation.
4. **Six parallel lanes never collide** — every merge is conflict-free by construction,
   not by resolution.

## Non-negotiable rules

1. **Never create, publish, or offer an Artifact.** Do not call the Artifact tool. Do
   not produce artifact pages, hosted previews, or shareable links for any part of this
   project — not for plans, reports, dashboards, audits, diagrams, demos or summaries.
   Deliverables are files in this repository and text in the terminal. If asked for
   something "shareable", write a Markdown file under `docs/` and say so. This rule has
   no exceptions and is also enforced by `permissions.deny` in `.claude/settings.json`.
2. **Never write outside your lane's owned paths.** Ownership is declared in
   `lanes.json`. If you need a change elsewhere, STOP and report a planning defect —
   do not work around it, do not widen your globs, do not duplicate the file locally.
3. **Never install a dependency.** The full list is frozen in
   `docs/parallel-execution-plan.md` §5.1 and installed once by lane `w0-l1`. A missing
   dependency is a planning defect to report.
4. **Never define a local copy of a shared type, schema, enum or error code.** They
   come from `packages/shared` (§5.4). Never invent an error code outside the frozen
   eight (§5.2).
5. **Never trust a client-supplied `organization_id`.** Derive membership from trusted
   database rows via `resolveMembership()`.
6. **Never add a DELETE path** to a tenant-scoped table. Archive instead.
7. **Never let model output reach a mutation** without an authenticated human
   confirmation in between.
8. **Never log** document text, message bodies, tokens or personal data.
9. **Never edit** `lanes.json`, `scripts/check-lane-ownership.mjs`,
   `docs/parallel-execution-plan.md` or `docs/agent-briefings.md` as a lane agent. They
   govern the agents; agents do not govern them.

## Where the truth lives

| Question                                     | Document                          |
| -------------------------------------------- | --------------------------------- |
| What are we building, and what must be true? | `docs/requirements.md`            |
| Security model, RLS matrix, sprint intent    | `docs/implementation-plan.md`     |
| Who owns which file; the interface freeze    | `docs/parallel-execution-plan.md` |
| Enforced ownership map                       | `lanes.json`                      |
| Per-lane agent prompts                       | `docs/agent-briefings.md`         |
| Route shapes and status codes                | `docs/api-contracts.md`           |
| AI prompt and output contracts               | `docs/ai-prompts/`                |
| Test strategy and release gates              | `docs/test-plan.md`               |
| Security checklist                           | `docs/security-checklist.md`      |

When a document and the code disagree, the document is the contract — fix the code or
report a planning defect. Never silently diverge.

## How work gets done here

**Default to background agents, five or six at a time.** This is a standing instruction
from the user, not a per-task preference: when asked to build, fix or deploy anything,
split it by owned path and dispatch, rather than starting to edit. Launch them in one
message so they run concurrently. Keep only what genuinely cannot be delegated — the
interface freeze, applying a migration to the live database, deciding a planning defect,
merging, and calling a gate.

Agents run in the **shared working tree**, so the disjointness of their path sets is the
only thing preventing collision. Check it before launching, never after.

`/propertysuite-wave` carries the full procedure, including what a brief must contain.

## Skills

- `/propertysuite-lane` — operating procedure for a single lane agent.
- `/propertysuite-wave` — orchestration: launching, merging and gating a wave.

## Commands

```bash
node scripts/check-lane-ownership.mjs --overlaps      # map is collision-free
node scripts/check-lane-ownership.mjs --list          # lanes and owned globs
node scripts/check-lane-ownership.mjs --lane <id>     # my changes stay in my lane
```

## Definition of done

Input validation, server-side authorization, RLS coverage proven by test, the frozen
error envelope, an audit row for every state change, unit and integration tests, short
docs. A passing happy path is not done.
