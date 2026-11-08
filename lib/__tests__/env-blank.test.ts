/**
 * A present-but-blank environment variable must read as absent.
 *
 * `.env.local` really does ship `ANTHROPIC_API_KEY=` — the name set, the value empty.
 * Zod's `.optional()` accepts `undefined` but *rejects* `''`, so "I have not configured
 * the AI yet" used to raise a boot-shaped `EnvironmentError` and every AI route answered
 * 500 instead of taking the clean "AI unavailable" path.
 *
 * The same trap has two other shapes, both also live in `.env.local` today, and both are
 * covered below: a blank **required** value used to fail as "looks too short" rather than
 * as missing, and a blank value on a variable with a `.default()` used to fail its enum
 * or URL check instead of taking the default, because Zod only defaults `undefined`.
 *
 * The modules are imported dynamically after `vi.stubEnv`, because `lib/env.ts` parses
 * its public schema eagerly at module load — which is the fail-fast behaviour we want in
 * production and simply has to be worked with in a test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `lib/server-only/secrets.ts` carries `import 'server-only'`, which throws outside
// React's `react-server` condition. Neutralised here so the module can be exercised at
// all; the guard itself is what stops a client component importing it in a real build.
vi.mock('server-only', () => ({}));

const VALID_URL = 'https://example.supabase.co';
const VALID_KEY = 'a'.repeat(40);

/** A minimal valid environment, so only the variable under test is interesting. */
function baseEnv(): void {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', VALID_URL);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', VALID_KEY);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('blankAsAbsent', () => {
  it('turns an empty string into undefined', async () => {
    baseEnv();
    const { blankAsAbsent } = await import('../env');
    expect(blankAsAbsent('')).toBeUndefined();
  });

  it('turns a whitespace-only string into undefined', async () => {
    baseEnv();
    const { blankAsAbsent } = await import('../env');
    expect(blankAsAbsent('   ')).toBeUndefined();
    expect(blankAsAbsent('\t\n')).toBeUndefined();
  });

  it('trims a real value', async () => {
    baseEnv();
    const { blankAsAbsent } = await import('../env');
    expect(blankAsAbsent('  sk-value  ')).toBe('sk-value');
  });

  it('passes a non-string through untouched', async () => {
    baseEnv();
    const { blankAsAbsent } = await import('../env');
    expect(blankAsAbsent(undefined)).toBeUndefined();
    expect(blankAsAbsent(42)).toBe(42);
  });
});

describe('an optional secret', () => {
  it('reads a blank ANTHROPIC_API_KEY as null instead of throwing', async () => {
    baseEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', VALID_KEY);
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const { anthropicApiKey } = await import('../server-only/secrets');
    expect(anthropicApiKey()).toBeNull();
  });

  it('reads a whitespace-only key as null', async () => {
    baseEnv();
    vi.stubEnv('ANTHROPIC_API_KEY', '   ');
    const { anthropicApiKey } = await import('../server-only/secrets');
    expect(anthropicApiKey()).toBeNull();
  });

  it('reads an absent key as null', async () => {
    baseEnv();
    vi.stubEnv('ANTHROPIC_API_KEY', undefined);
    const { anthropicApiKey } = await import('../server-only/secrets');
    expect(anthropicApiKey()).toBeNull();
  });

  it('returns a configured key, trimmed', async () => {
    baseEnv();
    vi.stubEnv('ANTHROPIC_API_KEY', '  sk-ant-api03-abcdefghijkl  ');
    const { anthropicApiKey } = await import('../server-only/secrets');
    expect(anthropicApiKey()).toBe('sk-ant-api03-abcdefghijkl');
  });

  it('still rejects a key that is present but implausibly short', async () => {
    baseEnv();
    vi.stubEnv('ANTHROPIC_API_KEY', 'abc');
    const { anthropicApiKey } = await import('../server-only/secrets');
    expect(() => anthropicApiKey()).toThrow();
  });
});

describe('a blank required secret', () => {
  it('reports SUPABASE_SERVICE_ROLE_KEY as missing, not as too short', async () => {
    baseEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');

    const { supabaseServiceRoleKey } = await import('../server-only/secrets');
    const { EnvironmentError } = await import('../env');

    try {
      supabaseServiceRoleKey();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      const failure = error as InstanceType<typeof EnvironmentError>;
      expect(failure.missing).toEqual(['SUPABASE_SERVICE_ROLE_KEY']);
      expect(failure.message).not.toContain('too short');
    }
  });

  it('is not reported as a usable credential', async () => {
    baseEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const { hasServiceRoleCredential } = await import('../server-only/secrets');
    expect(hasServiceRoleCredential()).toBe(false);
  });

  it('is reported as usable once set', async () => {
    baseEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', VALID_KEY);
    const { hasServiceRoleCredential } = await import('../server-only/secrets');
    expect(hasServiceRoleCredential()).toBe(true);
  });

  it('never puts the value in the error message', async () => {
    baseEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'short-but-present');
    const { supabaseServiceRoleKey } = await import('../server-only/secrets');
    try {
      supabaseServiceRoleKey();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('short-but-present');
    }
  });
});

describe('a blank required public value', () => {
  it('fails at import, naming the variable', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', VALID_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');

    await expect(import('../env')).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });

  it('fails at import for a blank URL too', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', VALID_KEY);

    await expect(import('../env')).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it('succeeds when both are set', async () => {
    baseEnv();
    const { publicEnv } = await import('../env');
    expect(publicEnv.NEXT_PUBLIC_SUPABASE_URL).toBe(VALID_URL);
  });
});

describe('a blank value on a variable with a default', () => {
  it('takes the default rather than failing the enum check', async () => {
    baseEnv();
    vi.stubEnv('AI_PROVIDER', '');
    vi.stubEnv('AI_MODEL', '');

    const { serverEnv } = await import('../env');
    const env = serverEnv();
    expect(env.AI_PROVIDER).toBe('anthropic');
    expect(env.AI_MODEL).toBe('claude-sonnet-5');
  });

  it('takes the default rather than failing the URL check', async () => {
    baseEnv();
    vi.stubEnv('APP_BASE_URL', '');

    const { serverEnv } = await import('../env');
    expect(serverEnv().APP_BASE_URL).toBe('http://localhost:3000');
  });

  it('honours a configured value', async () => {
    baseEnv();
    vi.stubEnv('APP_BASE_URL', 'https://app.example.com');
    vi.stubEnv('AI_MODEL', 'claude-opus-4');

    const { serverEnv } = await import('../env');
    expect(serverEnv().APP_BASE_URL).toBe('https://app.example.com');
    expect(serverEnv().AI_MODEL).toBe('claude-opus-4');
  });

  it('still rejects a non-blank but invalid value', async () => {
    baseEnv();
    vi.stubEnv('APP_BASE_URL', 'not-a-url');

    const { serverEnv } = await import('../env');
    expect(() => serverEnv()).toThrow(/APP_BASE_URL/);
  });
});
