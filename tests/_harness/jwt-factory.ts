/**
 * Typed facade over scripts/make-jwts.mjs. Lane w0-l6.
 *
 * The principal catalog, the credential resolver and the sign-in logic live in that
 * script so the CLI (`node scripts/make-jwts.mjs`) and this suite cannot drift apart.
 * The script is plain JavaScript, which TypeScript will not read with `allowJs: false`,
 * so it is loaded through a computed file URL and narrowed by the interface below. The
 * interface is checked against reality by tests/_harness/harness.test.ts — if the
 * script's exports change, that test fails rather than some assertion failing obscurely
 * twenty files later.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { MEMBER_ROLES } from '@shared/index';

export type OrgKey = 'A' | 'B';

/** Derived from the frozen shared enum — never re-declared locally (CLAUDE.md rule 4). */
export type MemberRole = (typeof MEMBER_ROLES)[number];

export interface PrincipalDescriptor {
  /** Stable handle, e.g. `a_manager`. */
  key: string;
  org: OrgKey;
  role: MemberRole;
  slot: string;
  /** True for the frozen ten (five roles x two organizations). */
  core: boolean;
  email: string;
  fullName: string;
  profileId: string;
  memberId: string;
}

export interface PrincipalSession extends PrincipalDescriptor {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
}

export interface StackCredentials {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

export interface OrganizationDescriptor {
  key: OrgKey;
  slug: string;
  name: string;
}

export interface JwtFactoryModule {
  TEST_PASSWORD: string;
  ORGANIZATIONS: Record<OrgKey, OrganizationDescriptor>;
  PRINCIPALS: PrincipalDescriptor[];
  CORE_PRINCIPALS: PrincipalDescriptor[];
  StackUnavailableError: new (message: string) => Error;
  fixtureId(key: string): string;
  principalByKey(key: string): PrincipalDescriptor;
  resolveStackCredentials(options?: {
    requireServiceRole?: boolean;
    allowStatusProbe?: boolean;
  }): StackCredentials;
  createServiceRoleClient(creds: StackCredentials): SupabaseClient;
  createAnonClient(creds: StackCredentials): SupabaseClient;
  createSessionClient(creds: StackCredentials, accessToken: string): SupabaseClient;
  ensureAuthUsers(
    creds: StackCredentials,
    principals?: PrincipalDescriptor[],
  ): Promise<Map<string, PrincipalDescriptor & { userId: string }>>;
  signIn(creds: StackCredentials, p: PrincipalDescriptor): Promise<PrincipalSession>;
  createSessions(
    creds: StackCredentials,
    principals?: PrincipalDescriptor[],
  ): Promise<Map<string, PrincipalSession>>;
}

const FACTORY_URL = new URL('../../scripts/make-jwts.mjs', import.meta.url).href;

let cached: JwtFactoryModule | undefined;

/** Loads the factory once per process. */
export async function loadJwtFactory(): Promise<JwtFactoryModule> {
  if (!cached) {
    const mod: unknown = await import(/* @vite-ignore */ FACTORY_URL);
    cached = mod as JwtFactoryModule;
  }
  return cached;
}

/** Every export the suite relies on. Asserted by the harness self-test. */
export const REQUIRED_FACTORY_EXPORTS = [
  'TEST_PASSWORD',
  'ORGANIZATIONS',
  'PRINCIPALS',
  'CORE_PRINCIPALS',
  'StackUnavailableError',
  'fixtureId',
  'principalByKey',
  'resolveStackCredentials',
  'createServiceRoleClient',
  'createAnonClient',
  'createSessionClient',
  'ensureAuthUsers',
  'signIn',
  'createSessions',
] as const;
