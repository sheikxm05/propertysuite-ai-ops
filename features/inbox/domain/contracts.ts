/**
 * Request contracts for `/api/v1/inbox/*`.
 *
 * `packages/shared` is the home of every cross-lane contract and these are not
 * cross-lane: `/api/v1/inbox/*` is owned, served and consumed entirely by this lane, and
 * `packages/shared/**` is read-only in Wave 3 so there is no way to put them there even
 * if another lane wanted them. They are built FROM the shared primitives rather than
 * beside them — `UuidSchema`, `TitleSchema`, `DescriptionSchema`,
 * `MaintenanceCategorySchema`, `TicketPrioritySchema`, `ConfirmationSchema` and
 * `AiMessageContentSchema` all come from there, so the inbox cannot disagree with the
 * rest of the application about what a title or a category is (CLAUDE.md rule 4).
 *
 * Note which field is absent from every schema below: `organization_id`. The server
 * derives it from `ctx.membership` on every one of these routes (rule 5), so there is
 * nowhere for a client to put one.
 */

import { z } from 'zod';

import {
  AiMessageContentSchema,
  ConfirmationSchema,
  DescriptionSchema,
  MaintenanceCategorySchema,
  PaginationQuerySchema,
  TicketPrioritySchema,
  TitleSchema,
  UuidSchema,
} from '@shared/index';

/** `GET /api/v1/inbox/messages` — the standard `?cursor=&limit=` page. */
export const ListInboxQuerySchema = PaginationQuerySchema;
export type ListInboxQuery = z.infer<typeof ListInboxQuerySchema>;

/**
 * A WhatsApp sender, as Meta reports it: digits, no `+`, no separators.
 *
 * Normalised on the way in so `+971 50 123 4567` and `00971501234567` become the same
 * string before anything tries to match them. Bounded at 7–15 digits, which is E.164's
 * own range.
 */
export const WhatsAppIdentifierSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\D/g, '').replace(/^00/, ''))
  .pipe(z.string().min(7).max(15));

/**
 * `POST /api/v1/inbox/simulate`
 *
 * Either name a tenant in your own organization — whose number is then looked up from
 * their row rather than taken from the request — or supply a raw number, which is how
 * the unmatched-sender case is demonstrated. Supplying neither is rejected: a message
 * from nobody has no story to tell.
 */
export const SimulateMessageSchema = z
  .object({
    body: AiMessageContentSchema,
    tenant_id: UuidSchema.optional(),
    from: WhatsAppIdentifierSchema.optional(),
    /** Which scripted scenario this came from, for the audit row. Never trusted. */
    scenario: z.string().trim().max(64).optional(),
    /**
     * Re-send a delivery under an id the webhook has already seen.
     *
     * This is the duplicate-suppression demonstration, and it is a *real* duplicate: the
     * same `wamid` goes back over the same signed path, Postgres raises `23505` on
     * `webhook_events`'s `unique (provider, event_id)` index, and the endpoint answers
     * 200 with `duplicates: 1`. Nothing in application code notices the repeat — the
     * constraint does — which is the only version of this claim worth making.
     */
    replay_of: z.string().trim().min(8).max(200).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.tenant_id) || Boolean(value.from), {
    message: 'Name a tenant to send as, or supply a number.',
    path: ['from'],
  });

export type SimulateMessageInput = z.infer<typeof SimulateMessageSchema>;

/**
 * `POST /api/v1/inbox/messages/{messageId}/ticket` — the human confirmation.
 *
 * `confirmed: true` is `ConfirmationSchema`, a Zod *literal*. An absent, false or merely
 * truthy value is a 400, so a replayed or default-valued body is not a decision. This is
 * the same gate `ConfirmTicketSchema` applies on the AI intake path and it is here for
 * the same reason: this is the one route in the lane where model output can end up
 * inside a row, and a person has to put it there.
 *
 * `title` and `description` are the operator's words, pre-filled from the draft and
 * editable before submission. The edit is the point of the gate.
 */
export const CommitTicketSchema = z
  .object({
    property_unit_id: UuidSchema,
    title: TitleSchema,
    description: DescriptionSchema,
    category: MaintenanceCategorySchema.default('unknown'),
    priority: TicketPrioritySchema.optional(),
    confirmed: ConfirmationSchema,
  })
  .strict();

export type CommitTicketInput = z.infer<typeof CommitTicketSchema>;

/*
 * There is deliberately NO proposal-decision schema here.
 *
 * Lane w3-l4 ships `POST /api/v1/ai/agent/proposals/{id}/approve` and `/reject`, both
 * gated on `STAFF_ROLES`, both backed by their security-definer RPC, both writing their
 * own audit row. An inbox-flavoured wrapper around them would be a second implementation
 * of a state-machine entry point — two sets of rules for one decision — so the inbox
 * calls those endpoints directly. The only thing this lane keeps is `mayDecideProposal()`
 * in `scope.ts`, which decides whether to render the buttons; the server refuses
 * independently either way.
 */
