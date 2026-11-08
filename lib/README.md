# `lib/` — runtime security library

Owned by lane **w0-l5**. Everything a route handler needs in order to be secure by
default, so that no feature lane has to remember to be.

## The one rule

Every API route goes through `withApiHandler`. Nothing else may construct an error
response, read `process.env`, build a Supabase client, or write an audit row.

```ts
import { throwIfPostgresError } from '@/lib/api/errors';
import { created } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { assertAuthorized } from '@/lib/auth/authorize';
import { CreatePropertySchema } from '@shared/index';

export const POST = withApiHandler(
  {
    roles: ['organization_admin', 'property_manager'],
    bodySchema: CreatePropertySchema,
    rateLimit: { key: 'properties:create', perMinute: 30 },
    audit: { action: 'property_created', entityType: 'property' },
  },
  async (ctx) => {
    assertAuthorized(ctx.membership, 'create', {
      type: 'property',
      organizationId: ctx.membership.organization.id,
    });

    const { data, error } = await ctx.supabase
      .from('properties')
      .insert({ ...ctx.body, organization_id: ctx.membership.organization.id })
      .select('id')
      .single();

    throwIfPostgresError(error);
    return created(data, ctx.requestId);
  },
);
```

## Layout

| Path                                    | What it is                                                      |
| --------------------------------------- | --------------------------------------------------------------- |
| `env.ts`                                | The only `process.env` reader. Public schema eager, server lazy |
| `server-only/secrets.ts`                | `SUPABASE_SERVICE_ROLE_KEY`; lint-guarded, browser-guarded      |
| `shared.ts`                             | The single import seam onto `packages/shared` (§5.4)            |
| `supabase/browser.ts`                   | Anon client for client components                               |
| `supabase/server.ts`                    | Cookie-based caller-scoped clients (RLS in force)               |
| `supabase/middleware.ts`                | Edge client that refreshes the session cookie                   |
| `supabase/server-only/service-role.ts`  | **Bypasses RLS.** Server-only, by lint and by assertion         |
| `auth/session.ts`                       | `getSession`, `requireSession` — verified, not decoded          |
| `auth/roles.ts`                         | `resolveMembership` — trusted rows only                         |
| `auth/authorize.ts`                     | The §4 matrix in application space, plus column projection      |
| `api/errors.ts`                         | The frozen eight, status mapping, SQLSTATE mapping              |
| `api/responses.ts`                      | The frozen envelope. The only response builder                  |
| `api/with-handler.ts`                   | `withApiHandler` (§5.2)                                         |
| `api/server-only/privileged-handler.ts` | `withPrivilegedApiHandler`, the opt-in to `ctx.serviceRole`     |
| `audit/write.ts`                        | Calls the `log_audit` RPC as the caller                         |
| `observability/logger.ts`               | Structured, correlated, redacting by allowlist                  |
| `observability/redaction.ts`            | The allowlist itself, plus the free-text scrubber               |
| `observability/correlation.ts`          | Request ids and low-cardinality route labels                    |
| `rate-limit/index.ts`                   | Per-user token bucket, stricter on `/api/v1/ai/*`               |
| `../middleware.ts`                      | Edge gate in front of the `(dashboard)` route group             |

## Decisions worth knowing before you edit

**Authorization is enforced twice.** `supabase/migrations/0002` encodes the §4 matrix in
Postgres; `auth/authorize.ts` encodes the same matrix in TypeScript. Each must deny on
the assumption the other has a bug. Do not "simplify" by deleting one.

**`authorize` also does column projection.** RLS is row-level and cannot hide a column,
so the matrix cell "service provider sees a tenant's name only" is enforced by
`decision.fields` / `projectionFor()`. A route that ignores it leaks tenant email and
phone while the RLS suite stays green.

**`ctx.serviceRole` is opt-in, not ambient.** `with-handler.ts` has no import path to a
privileged client. `api/server-only/privileged-handler.ts` injects one, and the
`**/server-only/**` ESLint rule means only server-side code can import it.

**Audit rows go through the `log_audit` RPC, as the caller.** `audit_logs` has writes
revoked from `authenticated`, and the security-definer function attributes the row to
`current_profile_id()` and refuses a caller who is not an active member. Using
service-role here would both skip that check and attribute every row to nobody.

**`packages/shared` owns the error _data_; this lane owns the error _behaviour_.** The
code union, the status table, the message table and the SQLSTATE table all live in
`packages/shared/constants/errors` and arrive through `lib/shared.ts`. `api/errors.ts`
adds the throwables, the normalisation and the rule that a 500 never describes itself.
Do not reintroduce a second copy of any of those four tables.

**Redaction is an allowlist, not a denylist.** Adding a field to a log call does nothing
until its name is added to `LOGGABLE_FIELDS`. That is the intended friction: the failure
mode of forgetting is a missing diagnostic, not a leaked phone number.

**`getSession` calls `getUser`.** The Supabase `getSession()` decodes a cookie and trusts
it. On the server only the verified call is acceptable.

**The rate limiter is process-local.** Exact on one server, up to N× the stated limit
across N serverless instances. Adequate for blunting a runaway client and capping AI
spend; not a standalone security control. Swapping the store is a change inside
`rate-limit/` only.

## Running this lane's tests

`vitest.config.ts` is owned by lane w0-l6. The suites here are plain `vitest` unit tests
under `lib/**/__tests__/` and need only path-alias resolution (`@/*`, `@shared/*`), which
that config supplies through `vite-tsconfig-paths`.

```bash
npx vitest run lib
```
