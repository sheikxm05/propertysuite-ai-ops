---
name: propertysuite-wave
description: Orchestration procedure for running a wave of PropertySuite lane agents in parallel - the standing background-agent dispatch rule (always delegate, 5-6 concurrently, disjoint paths), how to write a lane brief, pre-flight checks, resolving planning defects centrally, merge order, and verifying the wave exit gate. Use when asked to launch a wave, spin up or deploy agents, run work in parallel/in the background, run wave 0/1/2/3, merge lane branches, or check whether a wave can close. Also covers the hard prohibition on creating Artifacts.
---

# Orchestrating a wave

Lanes inside a wave are fully parallel; **waves are barriers.** A wave merges and its
gate passes before the next launches. `lanes.json` is the live count — read it rather
than trusting a number written here.

| Wave | Theme                                         | Gate                                                                                 |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| 0    | Contracts, security core, test infrastructure | Migrations clean and idempotent; RLS isolation suite green; typecheck and lint green |
| 1    | Six feature verticals                         | Every lane's tests green; ownership clean on every diff; RLS suite still green       |
| 2    | Cross-cutting completion and demo             | Every release gate in `docs/test-plan.md` green                                      |
| 3    | Agentic capabilities — RAG, webhooks, tools   | New surfaces reachable from the nav and live; isolation suite still green            |

Wave 3 earns a note the others do not. It adds tables, and **a new table is a new way to
leak.** Migration 0004 added five; every one of them had to be registered in the policy
parity harness, and four safety gates failed until they were. That failure was the
system working. The rule it leaves behind: _a migration that adds a table is not
finished when it applies — it is finished when the harness knows about the table._

Authoritative sources: `lanes.json` (ownership), `docs/parallel-execution-plan.md`
(plan, interface freeze, §5.8 amendment log, §5.9 carried gaps),
`docs/agent-briefings.md` (the per-lane prompts).

## Absolute prohibition

**Never create, publish or offer an Artifact** — not for wave status, progress
dashboards, merge reports, gate evidence or demo pages. No artifact pages, hosted
previews or shareable links, ever, for any part of this project. Status goes in the
terminal; durable records go in `docs/` as Markdown. No exceptions. Enforced in
`CLAUDE.md` and by `permissions.deny` in `.claude/settings.json`.

## Standing dispatch rule — delegate by default

**The user has asked for this explicitly and it does not expire: do the work through
background agents, 5–6 at a time, every time.** Treat "do X" as "dispatch X," not as
"start editing." You are an orchestrator; the keyboard is not yours.

Dispatch when the work decomposes into independent pieces — which is nearly always,
because this repo is _built_ to decompose. Do it yourself only when delegation is
genuinely worse:

- The interface freeze (§5 of the plan). Six agents build against it simultaneously, so
  a wrong freeze costs six re-dos. **Never delegate this.**
- Applying a migration to the live database. One writer, and it is you.
- Deciding a planning defect, amending `lanes.json`, merging, calling a gate.
- A single-file edit smaller than the brief that would describe it.

### Shape of a dispatch

Split the remaining work by **owned path**, not by topic. Paths are what collide;
topics are not. Before launching, say the path sets out loud and check they are
disjoint — two agents under one directory is a map defect you are creating by hand.

Launch **all of them in one message**, as several tool calls together. Launched one per
message, they run in sequence and you have gained nothing but overhead.

Size the fleet to the seams in the work, not to a number. Five or six is the usual
answer because that is how many disjoint path sets this repo tends to offer. Four real
seams beat six invented ones; do not manufacture a sixth lane to hit a quota.

### Writing the brief

A background agent sees none of your conversation. Everything it needs is in the brief
and in the files it can read. The briefs that work here share a shape:

1. **The one path it owns**, and "everything else is read-only," stated plainly.
2. **Who else is running right now** — so it does not fix a neighbour's file in passing.
3. **The failing output verbatim.** Paste the actual test failure or error. An agent
   given symptoms reproduces them; an agent given a paraphrase guesses.
4. **Why the thing is the way it is.** The reasoning this codebase is full of — RLS
   filters rows not columns; a proposal has no UPDATE path on purpose; an unmatched
   message refuses to guess. Without it an agent "fixes" a deliberate constraint.
5. **What must still be true afterwards** — name the property being protected, so the
   agent knows which direction it may not take. The most common bad outcome here is a
   safety gate weakened until it passes.
6. **Evidence to paste back**, verbatim, not summarised.
7. The prohibitions: no Artifact, no new dependency, no git commands, no writing outside
   the owned path.

Tell an agent to report a defect rather than reach outside its path — including when the
fix is one line in a neighbour's file. That report is the mechanism working, and it has
already caught collisions that would otherwise have surfaced on camera.

### While they run

Do not read a background agent's transcript file to peek at progress — it is the full
JSONL and it will flood your context. Wait for the completion notification.

Keep working while they do: the live database, the deployment, the next wave's freeze.
Idling until all six return wastes the parallelism you just paid for.

Never predict or report a running agent's results. If asked, say it is still running.

### When they come back

Verify; do not take a self-report at face value. Re-run the check yourself if the
evidence pasted back is thin or absent — a confident summary is not a passing test.
Then report what is actually true, including what is still broken.

## Pre-flight — before Wave 0 only

1. **Read §5 of the plan yourself.** It is the single point of failure: if a frozen
   interface is wrong, six agents build against it simultaneously, and the fix is six
   re-dos. This is the one task you must not delegate.
2. `node scripts/check-lane-ownership.mjs --overlaps` — must pass.
3. Docker Desktop running (the local Supabase stack and the RLS suite need it).
4. `ANTHROPIC_API_KEY` in `.env.local` before Wave 1 (lane `w1-l5` needs it; nothing
   earlier does).
5. Confirm the deployment target — Vercel plus Supabase cloud, or local-only. Affects
   `w2-l6` only, but decide now.

## Launching a wave

For each lane in the wave:

1. Take the **Common Preamble** from `docs/agent-briefings.md`.
2. Append that lane's briefing block. Nothing else.
3. Launch as a background agent. Branch-per-lane in a separate worktree is the ideal;
   in practice these agents run **in the shared tree**, which works only because the
   path sets are disjoint. That makes step 1's disjointness check load-bearing rather
   than ceremonial.
4. Set `CLAUDE_LANE=<id>` in the agent's environment to activate the PreToolUse
   ownership guard.

Launch all of them in one message so they actually run concurrently.

When lanes share a tree, authorship of a given change is unattributable by git alone —
use `node scripts/check-lane-ownership.mjs --shared-tree` (it exists for exactly this)
rather than `--lane <id> --base main`, which assumes a branch per lane.

**Give each agent only its own lane.** Do not paste the other briefings "for
context" — that is how an agent decides to be helpful in someone else's territory.

## While the wave runs

- **Agents never talk to each other.** All coordination routes through you. If two
  agents negotiate an interface directly, the freeze is dead and so is the merge.
- Expect `w0-l6`'s RLS suite to run **red** until `w0-l2` and `w0-l3` merge. That is
  correct — it is written test-first against the policy matrix. Do not "fix" it.
- A lane reporting a **planning defect** is working correctly, not failing. Handle it
  centrally:
  1. Decide which lane should own the change.
  2. If it is an interface-freeze change, amend §5 and re-brief **every** affected lane
     — never just the one that reported it.
  3. If it is an ownership change, amend `lanes.json`, then re-run `--overlaps`.
  4. Never tell an agent to "just edit it anyway."
- Do not accept a lane's self-report at face value. Verify the validator output and the
  test output it pasted; re-run them yourself if anything is missing.

## Merging

Within a wave, merge order is irrelevant — the diffs are disjoint by construction. If
git reports a content conflict between two lanes in the same wave, that is a **map
defect**, not a merge problem: stop, find why two lanes touched one file, fix
`lanes.json`, and re-run `--overlaps` before merging further.

For each lane branch, before merging:

```bash
node scripts/check-lane-ownership.mjs --lane <id> --base main --orphans
```

After all six merge, on the trunk:

```bash
npm run typecheck && npm run lint && npm test
node scripts/check-lane-ownership.mjs --overlaps
```

## Closing a wave

Check every item, then state plainly which are met and which are not:

- [ ] All six branches merged.
- [ ] Per-lane ownership check clean against `main`.
- [ ] Each lane's own exit gate in `lanes.json` satisfied, with evidence.
- [ ] The wave gate satisfied.
- [ ] Full suite green on the merged trunk.
- [ ] Every planning defect either resolved or explicitly deferred with a rationale.

**Wave 0's gate is hard.** `w0-l6`'s isolation suite must be green and every policy in
the §4 matrix exercised by at least one passing assertion. Launching Wave 1 over a
partly-green isolation suite defeats the project's entire premise — six feature lanes
would then be built on unproven isolation.

Never report a wave closed when a gate is unmet. Say which gate, what is missing, and
what it would take. Scaling the work down is the user's call, not yours.

## Wave 2's special rule

`w2-l3` (security audit and remediation) is the **sole writer on feature code** in Wave 2. The other five lanes stay strictly inside their own paths. `lanes.json` encodes this
with negated globs — `w2-l3` owns `app/**` and `lib/**` _minus_ what `w2-l4` and
`w2-l5` hold. Verify with `--overlaps` before launching, and brief `w2-l3` that four
agents are working beside it.
