/**
 * Server-only secrets.
 *
 * This module exists so that reading a secret is statically distinguishable from
 * reading configuration. It sits under `server-only/`, which `eslint.config.mjs`
 * forbids importing from anywhere that is not itself server-side code:
 *
 *     no-restricted-imports → group ['**\/server-only/**']
 *
 * So a client component that tries to reach `SUPABASE_SERVICE_ROLE_KEY` fails lint
 * before it ever fails review. Belt and braces: every accessor also calls
 * `assertServerRuntime`, because lint cannot see a value handed from a server component
 * to a client one at runtime, and Next.js replaces non-`NEXT_PUBLIC_` variables with
 * `undefined` in the client bundle anyway.
 *
 * Nothing here is ever logged. `lib/observability/logger.ts` works from an allowlist,
 * and no secret field name appears on it. See CLAUDE.md rule 8.
 */

import { z } from 'zod';

import { assertServerRuntime, parseEnvOrThrow } from '@/lib/env';

const SecretsSchema = z.object({
  /**
   * Bypasses Row Level Security entirely. Only `lib/supabase/server-only/service-role.ts`
   * should ever read this.
   */
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(20, 'SUPABASE_SERVICE_ROLE_KEY looks too short to be a real key'),
});

type Secrets = z.infer<typeof SecretsSchema>;

const OptionalSecretsSchema = z.object({
  /** Absent in environments that do not exercise the AI lane (for example CI unit runs). */
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
});

type OptionalSecrets = z.infer<typeof OptionalSecretsSchema>;

let secretsCache: Secrets | null = null;
let optionalSecretsCache: OptionalSecrets | null = null;

/**
 * The Supabase service-role key. Required: a deployment without it cannot write audit
 * rows or run background jobs, and silently degrading would hide that.
 */
export function supabaseServiceRoleKey(): string {
  assertServerRuntime('supabaseServiceRoleKey()');
  if (!secretsCache) {
    secretsCache = parseEnvOrThrow(SecretsSchema, {
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    });
  }
  return secretsCache.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * The Anthropic API key, or `null` when the AI features are not configured. Callers in
 * `services/ai/**` decide whether absence is fatal for their path; a unit-test run of
 * the rest of the application must not require a model credential.
 */
export function anthropicApiKey(): string | null {
  assertServerRuntime('anthropicApiKey()');
  if (!optionalSecretsCache) {
    optionalSecretsCache = parseEnvOrThrow(OptionalSecretsSchema, {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    });
  }
  return optionalSecretsCache.ANTHROPIC_API_KEY ?? null;
}

/** Whether a service-role credential is present, without revealing or caching it. */
export function hasServiceRoleCredential(): boolean {
  if (typeof window !== 'undefined') return false;
  const value = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return typeof value === 'string' && value.length >= 20;
}
