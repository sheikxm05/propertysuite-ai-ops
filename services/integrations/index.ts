/**
 * `services/integrations` — lane w3-l6: the WhatsApp Cloud API channel.
 *
 *   whatsapp/constants    wire constants, the published simulated keys, the status list
 *   whatsapp/signature    HMAC-SHA256 over raw bytes, constant-time comparison
 *   whatsapp/mode         the live-versus-simulated decision table
 *   whatsapp/payload      the delivery envelope and its reduction to rows
 *   whatsapp/phone        canonicalisation, for exact tenant matching only
 *   whatsapp/outbound     the send adapter: HTTP sink, recording sink, idempotency
 *   whatsapp/acknowledgement  the fixed acknowledgement text and its reference
 *
 *   server-only/…         everything that touches a credential or the database
 *
 * **This barrel exports only the pure half.** Nothing under `server-only/` is
 * re-exported, and that is a boundary rather than tidiness: a barrel that pulled in the
 * service-role client, the environment accessors and the `server-only` package would
 * make every importer of `services/integrations` — including, one day, a client
 * component rendering an inbox — depend on all three. `services/workers/index.ts` keeps
 * `cli.ts` out of its own barrel for exactly this reason.
 *
 * Server-side callers import the module they need by name:
 *
 *     import { createWhatsAppInboundHandler } from '@/services/integrations/server-only/inbound-job';
 *     import { whatsappOutbound }             from '@/services/integrations/server-only/whatsapp-outbound';
 *
 * which `eslint.config.mjs` permits only from server-side code (`**\/server-only/**`).
 */

export * from './whatsapp/constants';
export * from './whatsapp/signature';
export * from './whatsapp/mode';
export * from './whatsapp/payload';
export * from './whatsapp/phone';
export * from './whatsapp/outbound';
export * from './whatsapp/acknowledgement';
