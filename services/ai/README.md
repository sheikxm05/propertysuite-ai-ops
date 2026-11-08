# `services/ai` — AI maintenance intake

Lane **w1-l5**. Provider-neutral AI layer plus the two `/api/v1/ai/*` routes.

## The one rule

**The model drafts, a human commits.** Nothing exported from here mutates anything.

- `POST /api/v1/ai/maintenance/classify` returns a draft. `ClassifyResponseSchema` carries
  `created: false` as a Zod literal, so the route cannot claim otherwise even by accident.
- `POST /api/v1/ai/maintenance/confirm` creates the ticket, and only after
  `ConfirmTicketSchema`'s `confirmed: true` literal — an absent, `false` or
  truthy-but-not-`true` value is a 400.
- Creation goes through lane w1-l4's domain service (see "Ticket creation" below). This
  lane never writes `maintenance_tickets` or `maintenance_activities`; the only tables it
  writes are `ai_conversations` and `ai_messages`, and only by insert.
  `tests/ai/no-privileged-action.test.ts` enumerates every table write in the lane and
  asserts that set exactly.

## Layout

| Path | What it is |
| --- | --- |
| `providers/types.ts` | The frozen adapter interface. **No system-prompt parameter.** |
| `providers/transport.ts` | The one-model-call seam. Replaced offline by the eval set. |
| `providers/classification-provider.ts` | Provider-neutral core: prompt, fence, validate, one retry. |
| `providers/anthropic.ts` | The only file importing `@anthropic-ai/sdk`. |
| `providers/index.ts` | `getAiProvider()` — reads `AI_PROVIDER` and `AI_MODEL`. |
| `prompts/*.v1.ts`, `prompts/registry.ts` | The versioned, frozen prompt and its registry. |
| `fence.ts` | Untrusted-content fencing. The adapter's only input path. |
| `maintenance/intake.ts` | Unit resolution and the trusted priority facts. |
| `maintenance/draft.ts` | Clarification overlay and editable suggestions. Client-safe. |
| `maintenance/transcript.ts` | Conversation evidence. |
| `maintenance/ticket-creation.ts` | The seam to w1-l4's domain service. |

## Untrusted-content fencing

Tenant messages and document text are wrapped in a nonce-tagged envelope and placed in the
**user** role. A caller cannot contribute to the system role because the interface has no
parameter for it — read `providers/types.ts` and the argument is simply not there.

The nonce comes from a CSPRNG per request, so hostile text cannot forge a closing marker;
`sanitise` additionally neutralises any marker-shaped substring. No semantic filtering is
attempted: there is no reliable filter for "ignore previous instructions", so the defence is
architectural in three layers — the content is labelled as data, the system instruction says
instructions inside the fence are to be ignored, and a fully obeyed injection still has
nowhere to put itself (the output schema has no field for a provider, a status or a cost).

## Output validation

`ClassificationSchema` (from `packages/shared`, `.strict()`) is applied to every reply. On
rejection: exactly one retry, with the rejected reply fenced back as
`previous_invalid_model_output`. On a second rejection: `AiOutputInvalidError`, which the
routes render as `422 UNPROCESSABLE` with a user-facing message. The result object is
constructed only after a complete successful parse, so there is no partial-apply path.

A `max_tokens` stop is rejected **before** parsing: a truncated reply can still parse, and
believing it would mean accepting silently clipped fields.

## Priority

`resolvePriority()` decides; the model only suggests. `suggested_priority` is never written
to a ticket. The confirm route re-runs the policy server-side and ignores anything the body
says about priority.

One interaction worth knowing: the policy's guarantee is that a model suggestion *alone*
cannot produce `urgent`, and it holds — but a suggestion does raise the starting rank
(capped at `high`), and a trusted out-of-hours escalation then adds a step from there. So an
injected "URGENT" in a weekend message on an occupied safety-sensitive unit does reach
`urgent`, where the same message midweek reaches `high`. That is the frozen policy behaving
as written; it is pinned by a test in `tests/ai/routes.test.ts` and flagged for the Wave 2
security audit. Nothing is created either way.

## Ticket creation

`maintenance/ticket-creation.ts` delegates to `POST /api/v1/maintenance/tickets` using only
frozen contracts (§5.5 route, `CreateTicketSchema` body, `TicketResponseSchema` response,
§5.2 error envelope), forwarding the caller's own cookies. The real handler therefore runs:
its authorization, its state machine, its activity row, its audit row. RLS applies as the
caller, so a confirmation cannot create a ticket the tenant could not have created manually,
and an upstream refusal propagates under its own frozen code.

`registerTicketCreationService()` lets the orchestrator bind w1-l4's in-process service
later without touching either route.

## Logging

Token counts, latency, attempts, outcome, model, prompt version and resource ids — all
through `lib/observability/logger`, whose allowlist drops anything not named. Message text,
document text and model replies are never logged, never attached to an error and never put
in an audit row.

## Configuration

`AI_PROVIDER` and `AI_MODEL` come from `lib/env.ts`; `ANTHROPIC_API_KEY` from
`lib/server-only/secrets.ts`. No model id appears at a call site — asserted by test.

**`ANTHROPIC_API_KEY` is blank in this checkout, so no live call has ever been made.** The
adapter is built and the eval set runs offline against synthesised fixtures; the live path is
unverified. See `evals/README.md`.
