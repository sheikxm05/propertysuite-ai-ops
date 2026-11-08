/**
 * The single import seam between `lib/**` and the frozen contracts package.
 *
 * Why this file exists, and why it is not a duplicate of anything:
 *
 * `docs/parallel-execution-plan.md` §5.4 freezes the *export names* that
 * `packages/shared` must provide, but not the *module paths* they live at. W0-L4 is
 * writing that package concurrently with this lane, so `lib/**` cannot see it. Rather
 * than scatter a guess at the path across a dozen files — and risk a dozen edits when
 * W0-L4 lands — every `lib/**` module imports the contracts it needs from here, and
 * this file is the one place that names the shared package.
 *
 * It re-exports. It defines nothing. CLAUDE.md rule 4 forbids a local copy of a shared
 * type, schema, enum or error code, and there is none below.
 *
 * Both re-exports are **type-only** and therefore erased at compile time. That is
 * deliberate: it means `lib/**` has no runtime dependency on `packages/shared` at all,
 * so the unit tests in this lane run before W0-L4 has landed. Exhaustiveness over the
 * five roles is obtained from the type system — `Record<MemberRole, …>` in
 * `lib/auth/authorize.ts` — rather than from the `MEMBER_ROLES` array at runtime, which
 * is the stronger of the two checks anyway.
 *
 * `lib/**` depends on exactly two frozen names:
 *   - `MemberRole` — the role union, used in the `withApiHandler` signature (§5.2)
 *   - `ApiError`   — the error envelope type (§5.2, built by `lib/api/responses.ts`)
 */

export type { MemberRole, ApiError } from '@shared/index';
