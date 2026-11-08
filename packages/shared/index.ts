/**
 * `packages/shared` — the cross-lane contract surface.
 *
 * Every schema, enum, type and error code the application shares comes from
 * here. Nothing in this package imports from `app/`, `lib/`, `features/` or
 * `services/`: it depends only on `zod`, so it is safe to import from a client
 * component, a server route handler, a test and a script alike.
 *
 * Its public surface is frozen in `docs/parallel-execution-plan.md` §5.4. Five
 * other lanes import from it and cannot add to it, so the set must be complete
 * on first delivery.
 *
 * Layout:
 *
 *   constants/   enums mirroring the database, the error contract, the ticket
 *                state machine, and the frozen §5.7 values
 *   policy/      pure decision functions (the deterministic priority policy)
 *   schemas/     one file per domain; request and response schemas per route
 *   types/       database row types (regenerate — see `types/database.ts`)
 *
 * Import either from the barrel (`@shared/index`) or from the specific module
 * (`@shared/constants/ticket-status`). The barrel is re-exported in full so a
 * deep import is never required to reach a name.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export * from './constants/roles';
export * from './constants/ticket-status';
export * from './constants/categories';
export * from './constants/statuses';
export * from './constants/errors';
export * from './constants/pagination';
export * from './constants/storage';
export * from './constants/locale';

/**
 * Compile-time drift guard between the constant tuples and the database enums.
 * Exported so the file is always part of the compilation unit — if the two ever
 * disagree, `tsc --noEmit` fails here rather than Postgres failing in
 * production.
 */
export * from './constants/enum-parity';

/* -------------------------------------------------------------------------- */
/* Policy                                                                     */
/* -------------------------------------------------------------------------- */

export * from './policy/priority';

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

export * from './schemas/primitives';
export * from './schemas/organization';
export * from './schemas/property';
export * from './schemas/unit';
export * from './schemas/tenant';
export * from './schemas/tenancy';
export * from './schemas/service-provider';
export * from './schemas/maintenance';
export * from './schemas/document';
export * from './schemas/ai';
export * from './schemas/system';

/* -------------------------------------------------------------------------- */
/* Database types                                                             */
/* -------------------------------------------------------------------------- */

export type {
  Database,
  Json,
  PublicSchema,
  Tables,
  TablesInsert,
  TablesUpdate,
  Enums,
  DbFunctions,
  OrganizationRow,
  ProfileRow,
  OrganizationMemberRow,
  PropertyRow,
  PropertyUnitRow,
  TenantRow,
  TenancyRow,
  ServiceProviderRow,
  MaintenanceTicketRow,
  MaintenanceActivityRow,
  DocumentRow,
  AiConversationRow,
  AiMessageRow,
  NotificationRow,
  AuditLogRow,
  JobRow,
} from './types/database';
