/**
 * `POST /api/v1/inbox/messages/{messageId}/agent` — run the agent over one message.
 *
 * A thin, deliberately boring forwarder to `POST /api/v1/ai/agent/run` (lane w3-l4). It
 * exists for three reasons, none of them cosmetic:
 *
 *  1. **The message text never leaves the server.** The browser posts a message *id*.
 *     This route reads the row through the caller's own credentials and hands the text
 *     to the agent. A client that could post arbitrary text into the agent run would be
 *     a client that could run the agent over text it never received.
 *  2. **Authorization happens before the model does.** A message the caller may not see
 *     produces no agent run, checked here rather than inferred from the agent refusing
 *     later. The role gate matches the upstream route's `STAFF_ROLES` exactly, so a
 *     refusal is the same refusal wherever it is noticed.
 *  3. **An absent agent is a state, not a crash.** If the agent run is unreachable the
 *     response is `available: false` with a reason, and the UI renders a sentence
 *     explaining it. A red toast in the middle of a recording says "something broke";
 *     the truth is "that capability did not answer", and those are different claims.
 *
 * The caller's cookie is forwarded, so the agent re-authenticates as the operator and
 * its read-only tools run under the operator's RLS. The base URL comes from validated
 * configuration, never from a request header — deriving it from `Host` would turn this
 * into a server-side request forgery with the operator's session attached.
 *
 * NOTHING IS MUTATED HERE, and the run itself mutates nothing: `AgentRunDataSchema`
 * carries `executed: false` as a literal. Acting on a proposal is
 * `…/proposals/{id}/decision`, which is a different route, a different button and an
 * explicit human decision.
 */

import { ApiRouteError } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { withApiHandler } from '@/lib/api/with-handler';
import { serverEnv } from '@/lib/env';
import { REQUEST_ID_HEADER } from '@/lib/observability/correlation';
import { STAFF_ROLES, UuidSchema } from '@shared/index';
import {
  AGENT_RUN_PATH,
  inboxContextFrom,
  parseAgentRun,
  readMessage,
} from '@/features/inbox/domain';

const AGENT_RATE_LIMIT = { key: 'inbox:agent-run', perMinute: 6 } as const;
const AGENT_TIMEOUT_MS = 30_000;

export const POST = withApiHandler(
  {
    // The same gate `/api/v1/ai/agent/run` applies. Declaring it here stops the request
    // before a row is read rather than after a round trip that was always going to 403.
    roles: STAFF_ROLES,
    rateLimit: AGENT_RATE_LIMIT,
    audit: { action: 'inbound_message_agent_run', entityType: 'inbound_message' },
  },
  async (ctx) => {
    const { logger } = ctx;

    const messageId = UuidSchema.safeParse(ctx.params.messageId);
    if (!messageId.success) {
      throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'message_id_not_a_uuid' } });
    }

    const row = await readMessage(inboxContextFrom(ctx), messageId.data);
    if (!row) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'inbound_message_not_visible' },
      });
    }

    const text = row.body?.trim() ?? '';
    if (text.length === 0) {
      throw new ApiRouteError('UNPROCESSABLE', {
        message: 'This message carries no text, so there is nothing for the agent to read.',
        logFields: { reason: 'inbound_message_has_no_text' },
      });
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [REQUEST_ID_HEADER]: ctx.requestId,
    };
    const cookie = ctx.request.headers.get('cookie');
    if (cookie) headers.cookie = cookie;
    const authorization = ctx.request.headers.get('authorization');
    if (authorization) headers.authorization = authorization;

    let response: Response;
    try {
      response = await fetch(new URL(AGENT_RUN_PATH, serverEnv().APP_BASE_URL).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: text }),
        cache: 'no-store',
        signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
      });
    } catch {
      logger.warn('agent run unreachable', { reason: 'agent_unreachable', message_id: row.id });
      return unavailable(ctx.requestId, 'agent_unreachable', null);
    }

    if (!response.ok) {
      // A refusal upstream is a refusal here. It is NOT laundered into a success, and the
      // status is reported so the operator can tell "you may not" from "it broke".
      logger.warn('agent run refused', {
        reason: response.status === 404 ? 'agent_absent' : 'agent_refused',
        status_code: response.status,
        message_id: row.id,
      });
      return unavailable(
        ctx.requestId,
        response.status === 404 ? 'agent_absent' : 'agent_refused',
        response.status,
      );
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    // Parsed against `AgentRunResponseSchema` — the upstream lane's own contract, not a
    // second opinion about it. A body that does not satisfy it is contract drift between
    // two lanes, reported as such rather than rendered half-understood.
    const run = parseAgentRun(payload);
    if (!run) {
      logger.warn('agent run body not recognised', {
        reason: 'agent_contract_mismatch',
        status_code: response.status,
      });
      return unavailable(ctx.requestId, 'agent_contract_mismatch', response.status);
    }

    logger.info('agent run completed', {
      message_id: row.id,
      status_code: response.status,
      // Counts and enums, never content.
      count: run.steps.length,
      status: run.stop_reason,
      model: run.model,
      version: run.prompt_version,
      outcome: 'ok',
    });

    ctx.audit({
      entityId: row.id,
      metadata: {
        run_id: run.run_id,
        steps: run.steps.length,
        proposals: run.proposals.length,
        stop_reason: run.stop_reason,
        executed: run.executed,
      },
    });

    return ok(
      { available: true, reason: null, upstream_status: response.status, run },
      ctx.requestId,
    );
  },
);

/** A capability that did not answer. 200 with a reason, because nothing went wrong here. */
function unavailable(requestId: string, reason: string, status: number | null): Response {
  return ok({ available: false, reason, upstream_status: status, run: null }, requestId);
}
