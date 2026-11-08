/**
 * Environment access — the single place in the application that reads `process.env`.
 *
 * Three rules shape this file:
 *
 *  1. **Zod-validated.** Nothing is read raw. A missing or malformed value produces a
 *     named, actionable error instead of `undefined` propagating into a Supabase client.
 *  2. **Fail fast.** The public schema is parsed eagerly at module load, so a
 *     misconfigured deployment dies at boot rather than on a user's first request. The
 *     server schema is parsed on first use and memoised, because this module is also
 *     imported by edge middleware and by client components (which may only ever see
 *     `NEXT_PUBLIC_*`).
 *  3. **Secrets are not here.** `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` are
 *     deliberately absent from both schemas below. They are surfaced only by
 *     `lib/server-only/secrets.ts`, which the `server-only` import boundary in
 *     `eslint.config.mjs` prevents any client module from importing. Keeping them out
 *     of this module means "read the env" and "read a secret" are different, separately
 *     guarded acts.
 *
 * Variable names are frozen in `.env.example`. Do not add one without adding it there.
 */

import { z } from 'zod';

/* ------------------------------------------------------------- primitives -- */

/** Thrown when environment validation fails. Never includes a value, only a name. */
export class EnvironmentError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Environment validation failed for: ${missing.join(', ')}. ` +
        'See .env.example and copy it to .env.local.',
    );
    this.name = 'EnvironmentError';
    this.missing = missing;
  }
}

/**
 * Guard used by every server-only accessor. Checked at runtime because a static lint
 * rule cannot see through a value passed from a server component into a client one.
 */
export function assertServerRuntime(accessor: string): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      `${accessor} is server-only and was called in a browser. ` +
        'Move the call to a server component, route handler or server-only module.',
    );
  }
}

/**
 * Parses and, on failure, throws an error naming only the offending variables. The
 * values themselves are never interpolated into the message — a malformed secret must
 * not end up in a log line or a stack trace. See CLAUDE.md rule 8.
 */
export function parseEnvOrThrow<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const names = result.error.issues.map((issue) => String(issue.path[0] ?? '(root)'));
  throw new EnvironmentError(Array.from(new Set(names)));
}

/* ------------------------------------------------------------------ public -- */

/**
 * Values that are safe in a browser bundle. Next.js inlines `NEXT_PUBLIC_*` at build
 * time, so these must be referenced as static property accesses — never
 * `process.env[name]` — or the inliner cannot see them.
 */
const PublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, 'NEXT_PUBLIC_SUPABASE_ANON_KEY looks too short to be a real key'),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;

/**
 * Parsed eagerly. Importing this module at all asserts that the browser-visible
 * configuration is present and well formed.
 */
export const publicEnv: PublicEnv = parseEnvOrThrow(PublicEnvSchema, {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

/* ------------------------------------------------------------------ server -- */

/**
 * Non-secret server configuration. Safe to read from any server module; still useless
 * to a browser, so the accessor refuses to run in one.
 */
const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_BASE_URL: z.string().url('APP_BASE_URL must be a URL').default('http://localhost:3000'),
  AI_PROVIDER: z.enum(['anthropic']).default('anthropic'),
  AI_MODEL: z.string().min(1).default('claude-sonnet-5'),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let serverEnvCache: ServerEnv | null = null;

/**
 * Non-secret server configuration, parsed once. Throws if called in a browser, which
 * catches the mistake of reaching for server config from a client component.
 */
export function serverEnv(): ServerEnv {
  assertServerRuntime('serverEnv()');
  if (serverEnvCache) return serverEnvCache;
  serverEnvCache = parseEnvOrThrow(ServerEnvSchema, {
    NODE_ENV: process.env.NODE_ENV,
    APP_BASE_URL: process.env.APP_BASE_URL,
    AI_PROVIDER: process.env.AI_PROVIDER,
    AI_MODEL: process.env.AI_MODEL,
  });
  return serverEnvCache;
}

/**
 * Explicit boot-time assertion. `instrumentation.ts` (owned by a later lane) can call
 * this to turn a missing server variable into a startup failure rather than a
 * first-request failure. Secrets are intentionally not touched here — see
 * `lib/server-only/secrets.ts`.
 */
export function assertEnvAtBoot(): void {
  serverEnv();
}

/** True in production, by the validated value rather than a raw `process.env` read. */
export function isProduction(): boolean {
  return serverEnv().NODE_ENV === 'production';
}
