/**
 * The maintenance domain's public surface.
 *
 * Routes, pages and tests import from here. The individual modules stay importable for
 * a focused unit test, but nothing outside `features/maintenance/**` should need to know
 * how the domain is split up.
 *
 * Deliberately NOT re-exported: nothing from `repository.ts` beyond its row types. Every
 * database statement in this lane goes through `service.ts`, which is where
 * authorization happens; exporting the repository would create a path that skips it.
 */

export {
  BUSINESS_DAYS,
  BUSINESS_HOUR_CLOSE,
  BUSINESS_HOUR_OPEN,
  GULF_STANDARD_TIME_OFFSET_HOURS,
  isOutsideBusinessHours,
  isWithinBusinessHours,
  toGulfStandardTime,
} from './business-hours';

export { decodeTicketCursor, encodeTicketCursor, nextCursorFor, type TicketCursor } from './cursor';

export {
  PROVIDER_JOB_STATUSES,
  TICKET_ASSIGN_ROLES,
  TICKET_COMPLETE_ROLES,
  TICKET_TRANSITION_ROLES,
  allowedTransitionsFor,
  assertTicketTransition,
  availableTransitions,
  canTransition,
  classifyTicketTransition,
  classifyTransition,
  isAllowedTransition,
  transitionActivityType,
  type TransitionSubject,
  type TransitionVerdict,
} from './transitions';

export { ticketListScope, type TicketQueryScope } from './scope';

export {
  CLIENT_ACTIVITY_TYPES,
  SERVER_WRITTEN_ACTIVITY_TYPES,
  isClientPostableActivityType,
  writableTicketFields,
  type TicketField,
} from './field-policy';

export {
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  countTransitionActivities,
  isTransitionActivity,
  planAssignmentActivity,
  planClientActivity,
  planCompletionActivity,
  planCreationActivity,
  planPriorityActivity,
  planTransitionActivity,
  type PlannedActivity,
} from './activities';

export {
  appendActivity,
  assignTicket,
  completeTicket,
  countOpenByPriority,
  createTicket,
  getTicketDetail,
  listAssignableProviders,
  listReportableUnits,
  listTicketActivities,
  listTicketPage,
  patchTicket,
  type ActivityPageResult,
  type MaintenanceContext,
  type ProviderOption,
  type TicketMutation,
  type TicketPageResult,
  type UnitOption,
} from './service';

export {
  asPageInfoInput,
  maintenanceContextFrom,
  ticketIdFrom,
  type RouteContextLike,
} from './route-support';

export {
  normaliseCategory,
  toActivity,
  toTicket,
  toTicketDetail,
  type TicketDetailContext,
} from './view';

export type {
  ActivityRow,
  PropertyRow,
  ProviderRow,
  TenancyRow,
  TenantNameRow,
  TicketRow,
  UnitRow,
} from './repository';
