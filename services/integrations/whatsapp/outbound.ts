/**
 * The outbound adapter: send a text message back to a WhatsApp number.
 *
 * Two sinks behind one interface, chosen by configuration rather than by a flag:
 *
 *   http       a real `POST {graph}/{version}/{phoneNumberId}/messages` with a bearer
 *              token. Selected when `WHATSAPP_ACCESS_TOKEN` and
 *              `WHATSAPP_PHONE_NUMBER_ID` are both present.
 *   simulated  records what *would* have been sent — the exact URL, the exact JSON
 *              body, the idempotency key — and returns a synthetic message id.
 *              Selected when either credential is absent.
 *
 * The point of the split is that it is as thin as it can be. Everything above
 * `OutboundSink.deliver` — validation, canonicalisation of the destination number, the
 * idempotency guard, the result shape — runs identically either way, so a demo on the
 * simulated sink exercises all of it. The simulated sink does not stub out the logic;
 * it stubs out the network, which is the one thing no amount of code can make truthful
 * without a credential.
 *
 * **Idempotency.** `sendText` takes a required `idempotencyKey` and will not deliver
 * twice for one key: a retry returns the first result with `deduplicated: true`. The
 * natural key for a reply is the inbound `wamid` that prompted it, so a job that is
 * retried after a crash between "sent" and "recorded" does not message the tenant
 * twice. See the durability caveat on `InMemoryIdempotencyStore` — the store is
 * per-process, and the planning-defect report asks for a table.
 *
 * **Logging.** Never the body — it is a message to a tenant (CLAUDE.md rule 8) — and
 * never the destination number, which is personal data. Provider, idempotency outcome,
 * status code and duration only.
 */

import {
  MAX_OUTBOUND_TEXT_LENGTH,
  WHATSAPP_GRAPH_HOST,
  WHATSAPP_GRAPH_VERSION,
  WHATSAPP_PROVIDER,
} from './constants';
import { normalisePhone } from './phone';

/* ------------------------------------------------------------------ types -- */

export interface OutboundTextMessage {
  /** Destination number in any written form. Canonicalised before it is used. */
  readonly to: string;
  /** The text to send. Never logged. */
  readonly body: string;
  /** Required. A send without one is a send that can happen twice. */
  readonly idempotencyKey: string;
}

export type OutboundSinkKind = 'http' | 'simulated';

export interface OutboundResult {
  readonly provider: typeof WHATSAPP_PROVIDER;
  readonly sink: OutboundSinkKind;
  /** Provider message id, or a `simulated:` id from the simulated sink. */
  readonly messageId: string;
  /** True when this call returned a previously recorded result instead of sending. */
  readonly deduplicated: boolean;
  readonly idempotencyKey: string;
  readonly durationMs: number;
}

export class OutboundSendError extends Error {
  readonly reason: OutboundFailureReason;
  readonly statusCode: number | null;

  constructor(
    reason: OutboundFailureReason,
    options: { statusCode?: number | null; cause?: unknown } = {},
  ) {
    super(
      `whatsapp outbound failed: ${reason}`,
      options.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'OutboundSendError';
    this.reason = reason;
    this.statusCode = options.statusCode ?? null;
  }
}

/**
 * A closed list, for the same reason `services/workers/job-errors.ts` has one: the
 * obvious implementation puts the provider's response text into an error, and a Graph
 * API error echoes the request — including the message body it just refused to send.
 */
export type OutboundFailureReason =
  | 'destination_not_a_phone_number'
  | 'body_empty'
  | 'body_too_long'
  | 'idempotency_key_missing'
  | 'transport_failed'
  | 'provider_rejected'
  | 'provider_response_unreadable';

/** What a sink must do. The network is the only thing below this line. */
export interface OutboundSink {
  readonly kind: OutboundSinkKind;
  deliver(message: CanonicalOutboundMessage): Promise<{ messageId: string }>;
}

/** A validated message. A sink never sees an unvalidated one. */
export interface CanonicalOutboundMessage {
  /** Canonical digits, no `+`, as the Cloud API expects. */
  readonly to: string;
  readonly body: string;
  readonly idempotencyKey: string;
}

/* ------------------------------------------------------------ idempotency -- */

export interface IdempotencyStore {
  get(key: string): OutboundResult | undefined;
  set(key: string, result: OutboundResult): void;
}

/**
 * Process-local idempotency.
 *
 * Honest about its limits: this survives a retry inside one Node process and nothing
 * else. On a serverless platform two concurrent invocations have two maps, and a cold
 * start has an empty one. The durable version is a unique index — the same technique
 * the inbound path already uses through `webhook_events (provider, event_id)` — and an
 * `outbound_messages` table is in this lane's planning-defect report for exactly that
 * reason. It is not invented here because `supabase/migrations/**` belongs to w3-l1.
 *
 * Bounded so a long-lived process cannot grow one entry per message sent, ever.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, OutboundResult>();

  constructor(private readonly maxEntries = 10_000) {}

  get(key: string): OutboundResult | undefined {
    return this.entries.get(key);
  }

  set(key: string, result: OutboundResult): void {
    if (this.entries.size >= this.maxEntries) {
      // Insertion-ordered: the oldest key is the first one the iterator yields.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, result);
  }
}

/* ------------------------------------------------------------------ sinks -- */

export interface HttpSinkConfig {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds before the request is aborted. An un-timed-out send holds a job. */
  readonly timeoutMs?: number;
}

/** The real Cloud API call. */
export function createHttpSink(config: HttpSinkConfig): OutboundSink {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;

  return {
    kind: 'http',
    async deliver(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await doFetch(outboundUrl(config.phoneNumberId), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(graphRequestBody(message)),
          signal: controller.signal,
        });
      } catch (cause) {
        throw new OutboundSendError('transport_failed', { cause });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The response body is deliberately not read. A Graph API error echoes the
        // request it refused, which includes the message text.
        throw new OutboundSendError('provider_rejected', { statusCode: response.status });
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (cause) {
        throw new OutboundSendError('provider_response_unreadable', {
          statusCode: response.status,
          cause,
        });
      }

      const messageId = readMessageId(parsed);
      if (!messageId) {
        throw new OutboundSendError('provider_response_unreadable', {
          statusCode: response.status,
        });
      }
      return { messageId };
    },
  };
}

/** One recorded would-be send. The demo surface for the outbound half of the lane. */
export interface SimulatedSend {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly messageId: string;
  readonly at: string;
}

export interface SimulatedSink extends OutboundSink {
  readonly kind: 'simulated';
  /** Everything this sink has recorded, oldest first. */
  sent(): readonly SimulatedSend[];
  clear(): void;
}

/**
 * The simulated sink.
 *
 * It builds the **exact** request the HTTP sink would have issued — same URL, same JSON
 * body — and records it instead of sending it. That is what makes the demo evidence
 * rather than theatre: the recorded body is the artefact under review, and if the
 * request shape were wrong the recording would show it wrong.
 */
export function createSimulatedSink(phoneNumberId = 'simulated-phone-number-id'): SimulatedSink {
  const records: SimulatedSend[] = [];
  let counter = 0;

  return {
    kind: 'simulated',
    async deliver(message) {
      counter += 1;
      const messageId = `simulated:${WHATSAPP_PROVIDER}:${counter}:${message.idempotencyKey}`;
      records.push({
        url: outboundUrl(phoneNumberId),
        body: graphRequestBody(message),
        idempotencyKey: message.idempotencyKey,
        messageId,
        at: new Date().toISOString(),
      });
      return { messageId };
    },
    sent: () => [...records],
    clear: () => {
      records.length = 0;
    },
  };
}

/* ---------------------------------------------------------------- adapter -- */

export interface OutboundAdapterOptions {
  readonly sink: OutboundSink;
  readonly store?: IdempotencyStore;
  /** Injected in tests so a duration assertion is deterministic. */
  readonly now?: () => number;
}

/**
 * The adapter callers use. Validates, canonicalises, deduplicates, delegates.
 *
 * The in-flight map matters as much as the completed-result store: without it, two
 * concurrent calls with one key both miss the store and both reach the network. Here
 * the second awaits the first's promise and reports `deduplicated: true`.
 */
export class WhatsAppOutboundAdapter {
  private readonly sink: OutboundSink;
  private readonly store: IdempotencyStore;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<OutboundResult>>();

  constructor(options: OutboundAdapterOptions) {
    this.sink = options.sink;
    this.store = options.store ?? new InMemoryIdempotencyStore();
    this.now = options.now ?? (() => Date.now());
  }

  get sinkKind(): OutboundSinkKind {
    return this.sink.kind;
  }

  async sendText(message: OutboundTextMessage): Promise<OutboundResult> {
    const canonical = canonicalise(message);

    const recorded = this.store.get(canonical.idempotencyKey);
    if (recorded) return { ...recorded, deduplicated: true, durationMs: 0 };

    const pending = this.inFlight.get(canonical.idempotencyKey);
    if (pending) {
      const result = await pending;
      return { ...result, deduplicated: true, durationMs: 0 };
    }

    const startedAt = this.now();
    const attempt = this.sink
      .deliver(canonical)
      .then(({ messageId }) => {
        const result: OutboundResult = {
          provider: WHATSAPP_PROVIDER,
          sink: this.sink.kind,
          messageId,
          deduplicated: false,
          idempotencyKey: canonical.idempotencyKey,
          durationMs: this.now() - startedAt,
        };
        this.store.set(canonical.idempotencyKey, result);
        return result;
      })
      .finally(() => {
        // A failure is NOT recorded in the store: a send that did not happen must be
        // retryable. Only the in-flight entry is cleared.
        this.inFlight.delete(canonical.idempotencyKey);
      });

    this.inFlight.set(canonical.idempotencyKey, attempt);
    return attempt;
  }
}

/* ---------------------------------------------------------------- helpers -- */

function canonicalise(message: OutboundTextMessage): CanonicalOutboundMessage {
  if (typeof message.idempotencyKey !== 'string' || message.idempotencyKey.trim().length === 0) {
    throw new OutboundSendError('idempotency_key_missing');
  }

  const to = normalisePhone(message.to);
  if (!to) throw new OutboundSendError('destination_not_a_phone_number');

  const body = typeof message.body === 'string' ? message.body.trim() : '';
  if (body.length === 0) throw new OutboundSendError('body_empty');
  if (body.length > MAX_OUTBOUND_TEXT_LENGTH) throw new OutboundSendError('body_too_long');

  return { to, body, idempotencyKey: message.idempotencyKey.trim() };
}

function outboundUrl(phoneNumberId: string): string {
  return `${WHATSAPP_GRAPH_HOST}/${WHATSAPP_GRAPH_VERSION}/${encodeURIComponent(phoneNumberId)}/messages`;
}

/** The Cloud API send-message body. `preview_url` off: we do not unfurl tenant links. */
function graphRequestBody(message: CanonicalOutboundMessage): Record<string, unknown> {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: message.to,
    type: 'text',
    text: { preview_url: false, body: message.body },
  };
}

function readMessageId(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  if (typeof first !== 'object' || first === null) return null;
  const id = (first as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
