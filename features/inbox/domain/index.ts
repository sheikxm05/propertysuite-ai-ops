/**
 * The inbox domain, as one import.
 *
 * Route handlers and server components reach the domain through this barrel so that the
 * internal file layout can change without a route being edited. Client components do
 * NOT import it: it pulls in `lib/env`, the Supabase client types and `node:buffer`, and
 * a client component that imported it would drag server configuration towards the
 * browser bundle. They import `../components/api-client` and the pure view helpers
 * instead.
 */

export {
  CommitTicketSchema,
  ListInboxQuerySchema,
  SimulateMessageSchema,
  WhatsAppIdentifierSchema,
  type CommitTicketInput,
  type ListInboxQuery,
  type SimulateMessageInput,
} from './contracts';

export {
  decodeCursor,
  encodeCursor,
  inboxContextFrom,
  linkMessageToTicket,
  listMessages,
  markClassified,
  organizationUnits,
  readMessage,
  senderDirectory,
  tenantDirectory,
  type InboxContext,
  type MessagePage,
} from './repository';

export {
  audienceFor,
  mayCommitTicket,
  mayDecideProposal,
  maySimulate,
  type InboxAudience,
} from './scope';

export {
  CHANNEL_STYLE,
  UNMATCHED,
  channelOf,
  formatReceivedAt,
  indexByPhone,
  maskIdentifier,
  matchSender,
  messageStatusStyle,
  phoneKey,
  toMessageDetailView,
  toMessageView,
  type ChannelStyle,
  type InboxChannel,
  type InboxMessageDetailView,
  type InboxMessageView,
  type SenderMatch,
  type TenantDirectoryEntry,
} from './view';

export {
  SIMULATED_PROVIDER,
  WEBHOOK_PATH,
  buildWhatsAppPayload,
  deliverToWebhook,
  newExternalMessageId,
  observeDelivery,
  writeDirectly,
  type IngestionPath,
  type SimulatedDelivery,
  type WebhookOutcome,
} from './ingestion';

export {
  AGENT_RUN_PATH,
  STEP_OUTCOME_LABEL,
  STOP_REASON_LABEL,
  isReadStep,
  parseAgentRun,
  type AgentProposal,
  type AgentRun,
  type AgentStep,
} from './agent';

export { INBOX_SCENARIOS, UNKNOWN_SENDER, scenarioByKey, type InboxScenario } from './scenarios';

export {
  INBOUND_MESSAGE_STATUSES,
  waveThree,
  type InboundMessageRow,
  type InboundMessageStatus,
} from './wave-three';
