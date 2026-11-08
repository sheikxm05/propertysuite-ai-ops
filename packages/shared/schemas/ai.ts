import { z } from 'zod';

import { AI_CHANNELS, AI_SENDER_TYPES } from '../constants/statuses';
import { MaintenanceCategorySchema, TicketPrioritySchema } from './maintenance';
import {
  ConfirmationSchema,
  CurrencyCodeSchema,
  DescriptionSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  TitleSchema,
  UuidSchema,
  boundedText,
  resourceResponseSchema,
} from './primitives';
import { TicketDetailSchema } from './maintenance';

/**
 * AI intake and document extraction contracts.
 *
 * Routes: `/api/v1/ai/*` (lane w1-l5).
 *
 * THE RULE THIS FILE ENFORCES: the model drafts, a human commits. Nothing in
 * here is a mutation. `ClassifyRequestSchema` produces a draft and creates
 * nothing; `ConfirmTicketSchema` is the authenticated human confirmation that
 * creates the ticket, and it carries `confirmed: true` as a literal so a
 * default-valued or replayed body cannot stand in for a decision.
 *
 * `ClassificationSchema` is also the model-output validator. It is applied to
 * the adapter's response before any of it is believed: a reply that is not
 * schema-valid is rejected rather than coerced, which is what makes "returns a
 * validated object or throws" true. Model output that fails this schema never
 * reaches a handler, let alone a database.
 *
 * Note what the classification does NOT contain: no unit id, no tenant id, no
 * provider, no cost and no status. The model cannot name the subject of the
 * ticket or who should do the work, because those are authorization decisions
 * and a free-text prompt is not an authorization input.
 */

export const AiChannelSchema = z.enum(AI_CHANNELS);
export const AiSenderTypeSchema = z.enum(AI_SENDER_TYPES);

/** The tenant's free-text message. Untrusted data — never logged, never placed in a system prompt. */
export const AiMessageContentSchema = z.string().trim().min(1).max(4000);

/* -------------------------------------------------------------------------- */
/* Maintenance classification                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/ai/maintenance/classify`
 *
 * `property_unit_id` is optional: when the caller holds exactly one tenancy the
 * server resolves the unit itself, and when it is ambiguous the response asks
 * for clarification. Supplying it is a hint that still gets authorized — a unit
 * the caller has no tenancy on is rejected.
 */
export const ClassifyRequestSchema = z
  .object({
    message: AiMessageContentSchema,
    conversation_id: UuidSchema.optional(),
    property_unit_id: UuidSchema.optional(),
  })
  .strict();

export type ClassifyRequestInput = z.infer<typeof ClassifyRequestSchema>;

/**
 * The model's structured output, exactly as specified in
 * `docs/ai-prompts/maintenance-classification.md`:
 *
 * ```json
 * {
 *   "category": "hvac",
 *   "summary": "Air conditioning is running but not cooling.",
 *   "reported_symptoms": ["AC running", "room not cooling"],
 *   "suggested_priority": "normal",
 *   "missing_information": [],
 *   "requires_clarification": false,
 *   "clarification_question": null
 * }
 * ```
 *
 * `suggested_priority` is named "suggested" in the contract and is treated that
 * way: `resolvePriority()` decides the stored value. The validation rule from
 * the prompt contract — "the model may suggest priority; deterministic
 * application policy decides final priority" — is implemented in
 * `policy/priority.ts`, not here.
 *
 * `.strict()` matters more than usual: an extra key in a model response means
 * the model is not following the contract, and silently stripping it would hide
 * that. Every field is bounded so a runaway generation cannot become a runaway
 * database row.
 */
export const ClassificationSchema = z
  .object({
    category: MaintenanceCategorySchema,
    summary: boundedText(3, 500),
    reported_symptoms: z.array(boundedText(1, 200)).max(20),
    suggested_priority: TicketPrioritySchema,
    missing_information: z.array(boundedText(1, 200)).max(20),
    requires_clarification: z.boolean(),
    clarification_question: boundedText(3, 300).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.requires_clarification
        ? value.clarification_question !== null
        : value.clarification_question === null,
    {
      message:
        'clarification_question must be present when requires_clarification is true, and null otherwise.',
      path: ['clarification_question'],
    },
  );

export type Classification = z.infer<typeof ClassificationSchema>;

/**
 * `POST /api/v1/ai/maintenance/classify` response.
 *
 * `created: false` is a literal, not a flag: this route cannot create anything,
 * and the response says so in a way a test can assert. `resolved_priority` is
 * the deterministic policy's answer, shown beside the model's suggestion so the
 * human confirming can see that the two may differ.
 */
export const ClassifyResponseSchema = resourceResponseSchema(
  z
    .object({
      draft: ClassificationSchema,
      /** `resolvePriority()`'s decision — what the ticket will actually get. */
      resolved_priority: TicketPrioritySchema,
      /** Stable reason codes behind that decision, for the UI and the audit row. */
      priority_reasons: z.array(z.string()).optional(),
      conversation_id: UuidSchema.nullable(),
      property_unit_id: UuidSchema.nullable(),
      created: z.literal(false),
    })
    .strict(),
);

/**
 * `POST /api/v1/ai/maintenance/confirm` — authorized ticket creation after
 * confirmation.
 *
 * The draft is sent back for confirmation rather than held server-side in a
 * session so the confirming human sees exactly what they are committing to. It
 * is re-validated against `ClassificationSchema` on arrival, and it is NOT
 * trusted: the server re-runs `resolvePriority()` and re-authorizes
 * `property_unit_id` against the caller's tenancies. A tampered draft can
 * therefore change the ticket's text, which the human is responsible for, but
 * cannot change who the ticket belongs to or escalate it past policy.
 *
 * `title` and `description` are separate from the draft because the human may
 * edit them before committing. That edit is the point of the gate.
 */
export const ConfirmTicketSchema = z
  .object({
    property_unit_id: UuidSchema,
    title: TitleSchema,
    description: DescriptionSchema,
    classification: ClassificationSchema,
    conversation_id: UuidSchema.optional(),
    confirmed: ConfirmationSchema,
  })
  .strict();

export type ConfirmTicketInput = z.infer<typeof ConfirmTicketSchema>;

/** `POST /api/v1/ai/maintenance/confirm` response — `201` with the created ticket. */
export const ConfirmTicketResponseSchema = resourceResponseSchema(TicketDetailSchema);

/* -------------------------------------------------------------------------- */
/* Document extraction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/ai/documents/extract` — enqueue extraction; results remain
 * unverified.
 */
export const ExtractDocumentRequestSchema = z
  .object({
    document_id: UuidSchema,
    idempotency_key: boundedText(8, 200).optional(),
  })
  .strict();

export type ExtractDocumentRequestInput = z.infer<typeof ExtractDocumentRequestSchema>;

/**
 * The model's document-extraction output, exactly as specified in
 * `docs/ai-prompts/document-extraction.md`.
 *
 * Every field is nullable because the contract says "use null for missing or
 * ambiguous fields" and "do not invent missing values". A null here is a
 * successful extraction reporting absence, not a failure.
 *
 * `requires_human_review` is the model's own assessment and is advisory only.
 * The document's `verification_status` is set to `pending` regardless of what
 * the model claims — no value of this field can shortcut the verification gate.
 */
export const DocumentExtractionSchema = z
  .object({
    tenant_name: boundedText(2, 120).nullable(),
    contract_number: boundedText(1, 60).nullable(),
    property_address: boundedText(3, 300).nullable(),
    start_date: IsoDateSchema.nullable(),
    end_date: IsoDateSchema.nullable(),
    /** Kept separate from `currency`, per the extraction contract's rules. */
    rent_amount: MoneyAmountSchema.nullable(),
    currency: CurrencyCodeSchema.nullable(),
    confidence_notes: z.array(boundedText(1, 300)).max(20),
    requires_human_review: z.boolean(),
  })
  .strict();

export type DocumentExtraction = z.infer<typeof DocumentExtractionSchema>;

/** `POST /api/v1/ai/documents/extract` response — `202 Accepted`. Nothing is verified. */
export const ExtractDocumentResponseSchema = resourceResponseSchema(
  z
    .object({
      document_id: UuidSchema,
      job_id: UuidSchema,
      verification_status: z.literal('pending'),
      created: z.literal(false),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- */
/* Conversations                                                              */
/* -------------------------------------------------------------------------- */

export const AiConversationSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    user_profile_id: UuidSchema.nullable(),
    channel: AiChannelSchema,
    external_conversation_id: boundedText(1, 200).nullable(),
    status: boundedText(1, 40),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type AiConversation = z.infer<typeof AiConversationSchema>;

/**
 * A stored message.
 *
 * `content` is a message body: it is returned to its own author and never
 * logged, per the project rule against logging message bodies.
 */
export const AiMessageSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    conversation_id: UuidSchema,
    sender_type: AiSenderTypeSchema,
    content: z.string(),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type AiMessage = z.infer<typeof AiMessageSchema>;

export const AiConversationResponseSchema = resourceResponseSchema(
  AiConversationSchema.extend({
    messages: z.array(AiMessageSchema).optional(),
  }).strict(),
);
