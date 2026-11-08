/**
 * Compile-time drift guard between the hand-written constant tuples and the
 * database types.
 *
 * The constants in this folder exist so that the UI, the API handlers and the
 * tests share one vocabulary. The database types in `types/database.ts` are
 * what the Postgres enums actually are. If a migration adds, removes or renames
 * an enum member and only one of the two is updated, the two drift silently and
 * a runtime `invalid input value for enum` appears in production instead of in
 * CI.
 *
 * These assertions make that drift a type error. They have no runtime cost
 * beyond three `true` constants, and they fail `tsc --noEmit` — which is the
 * typecheck gate in CI — the moment the sets disagree in either direction.
 *
 * The file is re-exported from the package barrel so it is always part of the
 * compilation unit, even when no application module imports it.
 *
 * NOT COVERED, by construction: `MAINTENANCE_CATEGORIES` and everything in
 * `constants/statuses.ts`. Those columns are `text` with `check (... in (...))`
 * constraints rather than Postgres enum types, so the generator emits `string`
 * and there is no database type to compare against. Their lists are verified by
 * the unit tests in `__tests__/constants.test.ts` against the constraint
 * literals transcribed from the migration, which is the best a type system can
 * do for a check constraint.
 */
import type { MaintenanceCategory } from './categories';
import type { MemberRole } from './roles';
import type { TicketPriority, TicketStatus } from './ticket-status';
import type { Database } from '../types/database';

/** Mutual assignability. `never` on either side makes the annotation below fail. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

type DbMemberRole = Database['public']['Enums']['member_role'];
type DbTicketStatus = Database['public']['Enums']['ticket_status'];
type DbTicketPriority = Database['public']['Enums']['ticket_priority'];

/**
 * `MEMBER_ROLES` vs `public.member_role`.
 * A type error here means `constants/roles.ts` and the database enum disagree.
 */
export const MEMBER_ROLE_PARITY: Exactly<MemberRole, DbMemberRole> = true;

/**
 * `TICKET_STATUSES` vs `public.ticket_status`.
 * A type error here also invalidates `ALLOWED_TRANSITIONS`, whose keys are
 * `TicketStatus` — a new status with no transition row would not compile.
 */
export const TICKET_STATUS_PARITY: Exactly<TicketStatus, DbTicketStatus> = true;

/** `TICKET_PRIORITIES` vs `public.ticket_priority`. */
export const TICKET_PRIORITY_PARITY: Exactly<TicketPriority, DbTicketPriority> = true;

/**
 * Should `maintenance_tickets.category` ever become a Postgres enum
 * (`public.maintenance_category`), delete the `string` branch below and the
 * assertion starts guarding `MAINTENANCE_CATEGORIES` too. Until then this only
 * records that the column is deliberately `text`.
 */
export type MaintenanceCategoryColumn =
  Database['public']['Tables']['maintenance_tickets']['Row']['category'];

export const MAINTENANCE_CATEGORY_IS_TEXT_COLUMN: Exactly<MaintenanceCategoryColumn, string> = true;

/**
 * Every value in `MAINTENANCE_CATEGORIES` must still be a legal value for that
 * column, which is the one thing the type system can check here.
 */
export type MaintenanceCategoryAssignable = MaintenanceCategory extends MaintenanceCategoryColumn
  ? true
  : never;

export const MAINTENANCE_CATEGORY_ASSIGNABLE: MaintenanceCategoryAssignable = true;
