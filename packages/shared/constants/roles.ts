/**
 * Organization member roles.
 *
 * Mirrors the Postgres enum `public.member_role` declared in
 * `supabase/migrations/0001_initial_schema.sql`. The order below is the
 * declaration order in SQL and must not be reordered: `types/database.ts`
 * mirrors it and `constants/enum-parity.ts` fails the build if the two drift.
 */
export const MEMBER_ROLES = [
  'organization_admin',
  'property_owner',
  'property_manager',
  'tenant',
  'service_provider',
] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Roles that administer an organization's operational data.
 *
 * `is_org_staff(org)` in `docs/parallel-execution-plan.md` §5.3 resolves to
 * exactly this set, so the application-space check and the SQL predicate agree.
 */
export const STAFF_ROLES = [
  'organization_admin',
  'property_manager',
] as const satisfies readonly MemberRole[];

export type StaffRole = (typeof STAFF_ROLES)[number];

/** Human-readable labels. UI only; never used as an identifier or key. */
export const MEMBER_ROLE_LABELS: Readonly<Record<MemberRole, string>> = Object.freeze({
  organization_admin: 'Organization administrator',
  property_owner: 'Property owner',
  property_manager: 'Property manager',
  tenant: 'Tenant',
  service_provider: 'Service provider',
});

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value);
}

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === 'string' && (STAFF_ROLES as readonly string[]).includes(value);
}
