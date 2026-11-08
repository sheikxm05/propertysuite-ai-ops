/**
 * The two lines every maintenance route repeats, written once.
 *
 * `ctx.params` arrives from `withApiHandler` as `Record<string, string>` (amendment
 * A13): already awaited and flattened, but still request data. A route segment is as
 * untrusted as a body field, so it is parsed with the shared `TicketPathParamsSchema`
 * rather than passed into a query as a string. Without that, `/tickets/foo` reaches
 * PostgREST and comes back as a `22P02` invalid-input-syntax error — a 500 for what is
 * plainly a 400.
 *
 * `maintenanceContextFrom` exists so no route constructs a `MaintenanceContext` by hand
 * and quietly substitutes something other than `ctx.membership` or `ctx.supabase`. The
 * service's whole security model rests on those two being the wrapper's, which are
 * derived from a verified session and carry RLS.
 */

import { TicketPathParamsSchema } from '@shared/index';

import { validationError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { Logger } from '@/lib/observability/logger';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import type { MaintenanceContext } from './service';

/** The subset of `ApiHandlerContext` the service needs. Structural, so routes just pass `ctx`. */
export interface RouteContextLike {
  membership: Membership;
  supabase: AppSupabaseClient;
  logger: Logger;
  params: Record<string, string>;
}

export function maintenanceContextFrom(ctx: RouteContextLike): MaintenanceContext {
  return {
    supabase: ctx.supabase,
    membership: ctx.membership,
    logger: ctx.logger,
  };
}

/** The `{ticketId}` segment, validated as a UUID. Throws `VALIDATION_ERROR` (400). */
export function ticketIdFrom(params: Record<string, string>): string {
  const parsed = TicketPathParamsSchema.safeParse({ ticketId: params.ticketId ?? '' });
  if (!parsed.success) {
    throw validationError({
      message: 'The ticket identifier is not valid.',
      logFields: { reason: 'ticket_id_path_param_invalid' },
    });
  }
  return parsed.data.ticketId;
}
