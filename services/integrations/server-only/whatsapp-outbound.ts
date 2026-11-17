/**
 * Configuration-driven selection of the outbound sink, and the process-wide adapter.
 *
 * `services/integrations/whatsapp/outbound.ts` holds the logic and knows nothing about
 * the environment; this module reads the two credentials and decides which sink that
 * implies. The split keeps the adapter unit-testable without any environment at all,
 * and keeps the "which mode are we in?" decision in one readable function rather than
 * distributed through the send path.
 *
 *     WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID   →  http (real Graph API call)
 *     either absent                                       →  simulated (records the
 *                                                            request that would have
 *                                                            been issued)
 *
 * There is no flag that forces the simulated sink while credentials are present, for
 * the same reason `mode.ts` has none on the inbound side.
 *
 * The adapter is a module singleton so its idempotency store survives across requests
 * within one process — a per-call adapter would have an empty store every time, which
 * is the same as having none. The store's real limits are documented on
 * `InMemoryIdempotencyStore`; a durable `outbound_messages` table is in this lane's
 * planning-defect report.
 */

import 'server-only';

import {
  WhatsAppOutboundAdapter,
  createHttpSink,
  createSimulatedSink,
  type OutboundSink,
  type SimulatedSink,
} from '../whatsapp/outbound';
import { whatsappAccessToken, whatsappPhoneNumberId } from './whatsapp-secrets';

let adapter: WhatsAppOutboundAdapter | null = null;
let simulated: SimulatedSink | null = null;

/** Builds the sink the current configuration implies. */
function createConfiguredSink(): OutboundSink {
  const accessToken = whatsappAccessToken();
  const phoneNumberId = whatsappPhoneNumberId();

  if (accessToken && phoneNumberId) {
    return createHttpSink({ accessToken, phoneNumberId });
  }

  simulated = createSimulatedSink(phoneNumberId ?? 'simulated-phone-number-id');
  return simulated;
}

/** The process-wide adapter. Created on first use so an import costs no configuration read. */
export function whatsappOutbound(): WhatsAppOutboundAdapter {
  if (!adapter) adapter = new WhatsAppOutboundAdapter({ sink: createConfiguredSink() });
  return adapter;
}

/**
 * The recording sink, when one is in force.
 *
 * `null` under real credentials — there is nothing to inspect, because the messages
 * went to Meta. This is what a demo surface reads to show "here is the exact request
 * that would have been sent".
 */
export function whatsappSimulatedSends(): SimulatedSink | null {
  whatsappOutbound();
  return simulated;
}

/** Test and boot seam: rebuild the adapter after the environment changes. */
export function resetWhatsAppOutbound(): void {
  adapter = null;
  simulated = null;
}
