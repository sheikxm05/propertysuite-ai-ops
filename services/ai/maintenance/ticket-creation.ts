/**
 * The seam through which an AI-assisted confirmation creates a ticket.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Ticket creation is lane w1-l4's domain service: it derives `property_id`,
 * `tenancy_id` and `tenant_id` from the unit and the session, inserts the row as `open`
 * with a consistent `(property_id, property_unit_id)` pair, and writes the first
 * `maintenance_activities` row. This lane must not reimplement any of that — two
 * implementations of a state-machine entry point is two sets of rules, and the RLS
 * recursion defect recorded in §5.9a lived in exactly this INSERT path.
 *
 * But `features/maintenance/**` is w1-l4's territory and §5 freezes no in-process export
 * from it, so there is no symbol this lane may import. What §5 *does* freeze is the HTTP
 * contract: the route prefix (§5.5), the request body (`CreateTicketSchema`, §5.4), the
 * response envelope (`TicketResponseSchema`) and the error envelope (§5.2). All four are
 * contracts this lane may code against blind, which is the entire point of the freeze.
 *
 * So the default implementation delegates over that frozen contract, forwarding the
 * caller's own credentials. Three consequences worth stating, because they are why this
 * is not merely a workaround:
 *
 *  - The real handler runs. Its authorization, its state machine, its audit row, its
 *    activity row. Nothing is duplicated and nothing is skipped.
 *  - RLS applies as the *caller*, not as this service. The request carries the tenant's
 *    session, so a confirmation cannot create a ticket the tenant could not have created
 *    manually.
 *  - An upstream denial propagates faithfully. A 403 from w1-l4 is a 403 here, with the
 *    same frozen code, so the confirm endpoint cannot accidentally launder a refusal into
 *    a success.
 *
 * `registerTicketCreationService` exists so the orchestrator can bind w1-l4's in-process
 * service later without touching either route, and so the tests can bind a spy that
 * asserts what was asked for.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { serverEnv } from '@/lib/env';
import { REQUEST_ID_HEADER } from '@/lib/observability/correlation';
import {
  TicketResponseSchema,
  isErrorCode,
  type CreateTicketInput,
  type ErrorCode,
  type TicketDetail,
} from '@shared/index';

/** Frozen by §5.5 and `docs/api-contracts.md`. Not configurable. */
export const MAINTENANCE_TICKETS_PATH = '/api/v1/maintenance/tickets';

/** Deadline for the delegated call. Longer than a database write, shorter than a user's patience. */
const DELEGATE_TIMEOUT_MS = 10_000;

/**
 * The caller, as far as ticket creation is concerned.
 *
 * Headers, not a parsed session: the delegated handler re-authenticates from scratch, so
 * handing it a pre-digested identity would mean this lane deciding who the caller is.
 * There is deliberately no `organizationId` field — CLAUDE.md rule 5.
 */
export interface TicketCreationCaller {
  readonly requestId: string;
  readonly cookieHeader: string | null;
  readonly authorizationHeader: string | null;
}

export interface TicketCreationService {
  /** Stable id for logs: `http` for the delegate, something else for a bound service. */
  readonly id: string;
  createTicket(input: CreateTicketInput, caller: TicketCreationCaller): Promise<TicketDetail>;
}

let registered: TicketCreationService | null = null;

/**
 * Binds an in-process implementation, which then takes precedence over the HTTP
 * delegate. The intended future caller is the orchestrator, wiring w1-l4's domain
 * service once it exists.
 */
export function registerTicketCreationService(service: TicketCreationService): void {
  registered = service;
}

/** Restores the default HTTP delegate. */
export function resetTicketCreationService(): void {
  registered = null;
}

/** The bound service, or the HTTP delegate. */
export function getTicketCreationService(): TicketCreationService {
  return registered ?? createHttpTicketCreationService();
}

/**
 * The delegate.
 *
 * `fetch` against this application's own base URL. `APP_BASE_URL` comes from the
 * validated env rather than from a request header: deriving it from `Host` would let a
 * caller point the delegation somewhere else, which is a server-side request forgery with
 * the caller's session cookie attached.
 */
export function createHttpTicketCreationService(
  baseUrl: string = serverEnv().APP_BASE_URL,
): TicketCreationService {
  return {
    id: 'http',

    async createTicket(
      input: CreateTicketInput,
      caller: TicketCreationCaller,
    ): Promise<TicketDetail> {
      const url = new URL(MAINTENANCE_TICKETS_PATH, baseUrl).toString();

      const headers: Record<string, string> = {
        'content-type': 'application/json',
        [REQUEST_ID_HEADER]: caller.requestId,
      };
      if (caller.cookieHeader) headers.cookie = caller.cookieHeader;
      if (caller.authorizationHeader) headers.authorization = caller.authorizationHeader;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(input),
          cache: 'no-store',
          signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
        });
      } catch (error) {
        throw new ApiRouteError('INTERNAL_ERROR', {
          logFields: { reason: 'ticket_service_unreachable', route: MAINTENANCE_TICKETS_PATH },
          cause: error,
        });
      }

      const payload: unknown = await readJson(response);

      if (!response.ok) throw upstreamError(response.status, payload);

      const parsed = TicketResponseSchema.safeParse(payload);
      if (!parsed.success) {
        // The route answered 2xx with a body this lane does not recognise. That is a
        // contract drift between two lanes, and guessing at it would mean returning an
        // unvalidated object to the client as if it were a ticket.
        throw new ApiRouteError('INTERNAL_ERROR', {
          logFields: {
            reason: 'ticket_service_response_unrecognised',
            status_code: response.status,
          },
          cause: parsed.error,
        });
      }
      return parsed.data.data;
    },
  };
}

/**
 * Re-raises an upstream failure under its own frozen code.
 *
 * The delegated handler already chose the right code and the right client-safe message,
 * and both are part of the frozen envelope, so forwarding the code is faithful rather
 * than lossy. An unrecognised body becomes `INTERNAL_ERROR` — never a success.
 */
function upstreamError(status: number, payload: unknown): ApiRouteError {
  const code = readErrorCode(payload);
  if (code) {
    return new ApiRouteError(code, {
      logFields: { reason: 'ticket_service_refused', status_code: status, error_code: code },
    });
  }
  return new ApiRouteError('INTERNAL_ERROR', {
    logFields: { reason: 'ticket_service_failed', status_code: status },
  });
}

function readErrorCode(payload: unknown): ErrorCode | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const envelope = (payload as { error?: unknown }).error;
  if (typeof envelope !== 'object' || envelope === null) return null;
  const code = (envelope as { code?: unknown }).code;
  return typeof code === 'string' && isErrorCode(code) ? code : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
