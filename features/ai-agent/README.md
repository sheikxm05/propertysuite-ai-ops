# `features/ai-agent` — the conversation and the approval gate

Lane **w3-l5**. Owns `features/ai-agent/**` and `app/(dashboard)/assistant/**`.

This directory renders one screen, `/assistant`, and that screen exists to make one
sentence visible: **AI drafts, humans commit** (CLAUDE.md rule 7). Everything else is in
service of it.

## The two classes of tool, on screen

`services/ai/agent/tools/**` classifies every tool as `read` or `propose` before the
model is allowed near it. The UI draws that line rather than inventing one.

| Class     | Tools                                                                     | Has it run?    | Colour      |
| --------- | ------------------------------------------------------------------------- | -------------- | ----------- |
| `read`    | `lookup_unit`, `lookup_tenancy`, `recent_tickets`, `list_providers`, `search_documents` | Yes, already   | `secondary` |
| `propose` | `create_ticket`, `assign_provider`, `set_priority`                        | **Never**      | `warning`   |

`warning` is not a decorative choice. `components/ui/status.ts` defines it as "a human
decision is outstanding — nobody has committed to this yet", which is exactly what a
pending proposal is. Same amber as an unverified document and a ticket awaiting approval.

## Files

| File                               | What it is                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `wire.ts`                          | Re-exports w3-l4's schemas; adds only the decision enum and the status tables  |
| `transport.ts`                     | The HTTP calls this lane makes, and the only ones it may make                  |
| `describe.ts`                      | Tool name + arguments → an English sentence. Pure, no React                    |
| `components/assistant-console.tsx` | Transcript, composer, decision state. Mounted by the page                      |
| `components/tool-trace.tsx`        | The steps the agent took, read and proposed, interleaved                       |
| `components/proposal-card.tsx`     | **The approval gate.** Approve / Reject                                        |
| `components/disclosure.tsx`        | Expandable raw JSON                                                            |
| `server-context.ts`                | Session + membership for the page, from trusted rows only                      |

`wire.ts` does **not** restate the contract. `services/ai/agent/schemas.ts` imports only
`zod` and `@shared/index`, so it is safe in a client bundle and is imported directly —
one definition, in the lane that owns it.

## Invariants this lane holds

1. **The browser never writes a proposal row.** The Supabase browser client is not
   imported anywhere in this directory. Migration 0004 revokes UPDATE on
   `agent_proposals` and declares no UPDATE policy, so the only route from `pending` to
   `approved` is the API route → `approve_agent_proposal(p_id)` → `is_org_staff()`.
2. **No optimistic state.** Clicking Approve does not move the card; the endpoint's own
   confirmation does. An optimistic success the server had refused is the one
   unaffordable bug on a screen whose job is to be an honest account of what happened.
3. **Approval is not execution, and the card says so.** `executed: false` is a Zod
   literal in the approval response. The success state reports what was recorded and
   does not invent a created ticket to link to.
4. **Role gating hides, it does not protect.** `canApprove` comes from `isStaffRole()`
   evaluated on the server against trusted membership rows and decides only whether a
   button is drawn. Forcing it true in a debugger changes nothing.
5. **Rejected proposals stay in the transcript.** The record of a refusal is evidence.
6. **No tool results reach this screen.** `AgentStepSchema` is metadata only, by design —
   a result can contain a resident's words. The trace says so rather than leaving the
   absence to look like an oversight.
7. **Nothing is logged.** No `console` call exists here (CLAUDE.md rule 8).

## What another lane must wire

1. **`POST /api/v1/ai/agent/proposals/{id}/reject` — lane w3-l4.** The RPC
   `public.reject_agent_proposal(uuid)` exists in migration 0004, added there precisely
   because with UPDATE revoked "a human who declines a proposal would have no way to say
   so". No route calls it. The Reject button posts to the URL above, mirroring the
   approve route; until that file exists the button returns 404.
2. **Sidebar entry — `config/**`.** `/assistant` has no nav link. `config/types.ts` must
   gain `'ai-agent'` in `FEATURE_KEYS` before a `nav.ts` here could typecheck, so no
   `nav.ts` was written. Suggested entry: label "Assistant", icon `Bot`, href
   `/assistant`, roles `['organization_admin', 'property_manager']`, order 60.
3. **`middleware.ts` — lane w0-l5.** `/assistant` is in neither `PROTECTED_PREFIXES` nor
   the matcher. `app/(dashboard)/layout.tsx` still redirects an unauthenticated visitor,
   so the page is not reachable without a session, but the edge gate should cover it.
