---
name: propertysuite-wave
description: Orchestration procedure for running a wave of six PropertySuite lane agents in parallel - pre-flight checks, launching all six with their briefings, resolving planning defects centrally, merge order, and verifying the wave exit gate before the next wave starts. Use when asked to launch a wave, spin up the agents, run wave 0/1/2, merge lane branches, or check whether a wave can close. Also covers the hard prohibition on creating Artifacts.
---

# Orchestrating a wave of six

Three waves, six lanes each, eighteen agent tasks. Lanes inside a wave are fully
parallel; **waves are barriers.** A wave merges and its gate passes before the next
launches.

| Wave | Theme                                         | Gate                                                                                 |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| 0    | Contracts, security core, test infrastructure | Migrations clean and idempotent; RLS isolation suite green; typecheck and lint green |
| 1    | Six feature verticals                         | Every lane's tests green; ownership clean on all six diffs; RLS suite still green    |
| 2    | Cross-cutting completion and demo             | Every release gate in `docs/test-plan.md` green                                      |

Authoritative sources: `lanes.json` (ownership), `docs/parallel-execution-plan.md`
(plan and interface freeze), `docs/agent-briefings.md` (the eighteen prompts).

## Absolute prohibition

**Never create, publish or offer an Artifact** — not for wave status, progress
dashboards, merge reports, gate evidence or demo pages. No artifact pages, hosted
previews or shareable links, ever, for any part of this project. Status goes in the
terminal; durable records go in `docs/` as Markdown. No exceptions. Enforced in
`CLAUDE.md` and by `permissions.deny` in `.claude/settings.json`.

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

For each of the six lanes in the wave:

1. Take the **Common Preamble** from `docs/agent-briefings.md`.
2. Append that lane's briefing block. Nothing else.
3. Launch on branch `lane/<id>`, in its own git worktree so agents cannot see each
   other's dirty trees.
4. Set `CLAUDE_LANE=<id>` in the agent's environment to activate the PreToolUse
   ownership guard.

Launch all six in one go so they actually run concurrently.

**Give each agent only its own lane.** Do not paste the other five briefings "for
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
