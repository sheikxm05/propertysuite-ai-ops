/**
 * The shape of `documents.extracted_data` — and the gate that lives inside it.
 *
 * `documents` has exactly one `jsonb` column for extraction output and no column for
 * verified values, so both have to live here. That makes the layout a security
 * question rather than a formatting one, and the answer is two sibling blocks that are
 * written by different actors and can never be confused:
 *
 *     {
 *       "version": "document-extraction@v1",   written by the worker
 *       "extracted_at": "...",                 written by the worker
 *       "extractor_id": "...",                 written by the worker
 *       "text": { ... },                       written by the worker
 *       "proposed": { ...seven fields... },    written by the worker  — A PROPOSAL
 *       "excerpts": { ... },                   written by the worker
 *       "notes": [ ... ],                      written by the worker
 *       "verification": null | { ... }         written ONLY by POST .../verify — THE TRUTH
 *     }
 *
 * The rules, enforced by the functions below rather than by convention:
 *
 *  1. The worker calls `buildPendingEnvelope`, which **cannot** produce a non-null
 *     `verification`. There is no parameter for it. A model-driven path to a verified
 *     state does not exist in the type system, let alone in the code.
 *  2. The verify route calls `applyHumanVerification` / `applyHumanRejection`, which
 *     require an actor profile id. There is no way to record a verification without
 *     naming the human who performed it.
 *  3. `proposedFieldsFor` returns the *proposal*, and its name says so. Nothing reads
 *     `proposed` expecting a fact.
 *  4. Re-extraction preserves an existing `verification` block — see
 *     `buildPendingEnvelope`'s `previous` argument — so a second pass of the worker can
 *     never erase a human decision. (The worker additionally refuses to run on a
 *     document that is not `pending`; this is the second layer.)
 *
 * `verification_status` on the row is the authoritative state. This envelope mirrors
 * it, never replaces it: `isEnvelopeVerified` exists for rendering, and every
 * authorization decision reads the column.
 */

import { z } from 'zod';

import {
  DocumentExtractionSchema,
  VerifiedDocumentFieldsSchema,
  type DocumentExtraction,
  type VerifiedDocumentFields,
} from '@shared/index';

import { EXCERPTABLE_FIELDS, type ExcerptableField, type FieldExcerpts } from './excerpts';

/** Longest confidence note retained. Model-authored text, so it is bounded. */
const MAX_NOTE_CHARS = 300;
const MAX_NOTES = 20;

/* ---------------------------------------------------------------- schemas -- */

const FieldExcerptSchema = z.object({
  excerpt: z.string().max(400).nullable(),
  found: z.boolean(),
  line: z.number().int().min(1).nullable(),
});

const TextStatsSchema = z.object({
  /** Characters retained in `documents.extracted_text`. A count, never the text. */
  character_count: z.number().int().min(0),
  page_count: z.number().int().min(0),
  truncated: z.boolean(),
});

/**
 * The human decision.
 *
 * `fields` is present on a verification and absent on a rejection, mirroring
 * `VerifyDocumentSchema`'s discriminated union in `packages/shared`: a rejection
 * records no values, because a reviewer who rejects a document has not asserted
 * anything about its contents.
 */
const VerificationBlockSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  /** `profiles.id` of the human who decided. Required — see rule 2 in the header. */
  verified_by: z.string().uuid(),
  verified_at: z.string(),
  fields: VerifiedDocumentFieldsSchema.nullable(),
  note: z.string().max(2000).nullable(),
  reason: z.string().max(500).nullable(),
});

export const DocumentExtractionEnvelopeSchema = z.object({
  version: z.string().max(80),
  extracted_at: z.string(),
  extractor_id: z.string().max(120).nullable(),
  text: TextStatsSchema,
  proposed: DocumentExtractionSchema.nullable(),
  excerpts: z.record(FieldExcerptSchema).default({}),
  notes: z.array(z.string().max(MAX_NOTE_CHARS)).max(MAX_NOTES).default([]),
  verification: VerificationBlockSchema.nullable(),
});

export type DocumentExtractionEnvelope = z.infer<typeof DocumentExtractionEnvelopeSchema>;
export type VerificationBlock = z.infer<typeof VerificationBlockSchema>;

/* ----------------------------------------------------------------- build -- */

export interface TextStats {
  readonly characterCount: number;
  readonly pageCount: number;
  readonly truncated: boolean;
}

export interface BuildEnvelopeInput {
  readonly version: string;
  readonly extractorId: string | null;
  readonly text: TextStats;
  readonly proposed: DocumentExtraction | null;
  readonly excerpts: FieldExcerpts;
  readonly notes?: readonly string[];
  /**
   * The envelope already on the row, if any. Its `verification` block is carried
   * forward unchanged — a re-extraction proposes new values but cannot un-decide a
   * human decision.
   */
  readonly previous?: DocumentExtractionEnvelope | null;
  readonly now?: () => Date;
}

/**
 * The envelope the worker writes.
 *
 * Note the absence of any way to set `verification` to a non-null value from an
 * extraction: the only non-null it can produce is one copied from `previous`, which was
 * written by a human in an earlier request.
 */
export function buildPendingEnvelope(input: BuildEnvelopeInput): DocumentExtractionEnvelope {
  const now = input.now ?? (() => new Date());
  const notes = (input.proposed?.confidence_notes ?? [])
    .concat(input.notes ?? [])
    .map((note) => note.slice(0, MAX_NOTE_CHARS))
    .filter((note) => note.trim().length > 0)
    .slice(0, MAX_NOTES);

  return {
    version: input.version,
    extracted_at: now().toISOString(),
    extractor_id: input.extractorId,
    text: {
      character_count: input.text.characterCount,
      page_count: input.text.pageCount,
      truncated: input.text.truncated,
    },
    proposed: input.proposed,
    excerpts: toExcerptRecord(input.excerpts),
    notes,
    verification: input.previous?.verification ?? null,
  };
}

function toExcerptRecord(excerpts: FieldExcerpts): DocumentExtractionEnvelope['excerpts'] {
  const record: DocumentExtractionEnvelope['excerpts'] = {};
  for (const field of EXCERPTABLE_FIELDS) {
    const excerpt = excerpts[field];
    if (excerpt) record[field] = excerpt;
  }
  return record;
}

/* ------------------------------------------------------------ verification -- */

export interface HumanDecision {
  /** `profiles.id` from the verified session. Never from a request body. */
  readonly verifiedBy: string;
  readonly now?: () => Date;
}

/**
 * Records an authorized human verification.
 *
 * `fields` is the reviewer's submission, not the model's proposal. They may be
 * identical — the reviewer read the document and agreed — but the value stored is the
 * one the human sent, because that is what they are accountable for.
 */
export function applyHumanVerification(
  envelope: DocumentExtractionEnvelope | null,
  decision: HumanDecision & { fields: VerifiedDocumentFields; note?: string | null },
): DocumentExtractionEnvelope {
  const base = envelope ?? emptyEnvelope(decision.now);
  const now = decision.now ?? (() => new Date());

  return {
    ...base,
    verification: {
      status: 'verified',
      verified_by: decision.verifiedBy,
      verified_at: now().toISOString(),
      fields: decision.fields,
      note: decision.note ?? null,
      reason: null,
    },
  };
}

/** Records an authorized human rejection. No field values are stored. */
export function applyHumanRejection(
  envelope: DocumentExtractionEnvelope | null,
  decision: HumanDecision & { reason: string },
): DocumentExtractionEnvelope {
  const base = envelope ?? emptyEnvelope(decision.now);
  const now = decision.now ?? (() => new Date());

  return {
    ...base,
    verification: {
      status: 'rejected',
      verified_by: decision.verifiedBy,
      verified_at: now().toISOString(),
      fields: null,
      note: null,
      reason: decision.reason,
    },
  };
}

/**
 * An envelope for a document that was verified without ever being processed.
 *
 * A legitimate case: staff upload a contract and key the fields in by hand rather than
 * waiting for extraction. The gate is unchanged — a human still submitted every value.
 */
function emptyEnvelope(now?: () => Date): DocumentExtractionEnvelope {
  const clock = now ?? (() => new Date());
  return {
    version: 'manual-entry@v1',
    extracted_at: clock().toISOString(),
    extractor_id: null,
    text: { character_count: 0, page_count: 0, truncated: false },
    proposed: null,
    excerpts: {},
    notes: [],
    verification: null,
  };
}

/* ------------------------------------------------------------------ reads -- */

/**
 * Parses a stored envelope, or returns `null`.
 *
 * Tolerant by design. `extracted_data` is `jsonb` and may hold an older envelope, a
 * shape from a future version, or — because nothing stops a service-role script — any
 * JSON at all. A parse failure must degrade to "no proposal available" and leave the
 * document verifiable by hand, not throw on the detail page.
 */
export function readEnvelope(value: unknown): DocumentExtractionEnvelope | null {
  if (value === null || typeof value !== 'object') return null;
  const parsed = DocumentExtractionEnvelopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The seven verifiable fields, projected out of the model's proposal.
 *
 * `confidence_notes` and `requires_human_review` are dropped: they are the model
 * talking about itself, not values a human confirms. In particular
 * `requires_human_review` must never be mistaken for a decision — see the prompt.
 */
export function proposedFieldsFor(
  envelope: DocumentExtractionEnvelope | null,
): VerifiedDocumentFields | null {
  const proposed = envelope?.proposed;
  if (!proposed) return null;

  return {
    tenant_name: proposed.tenant_name,
    contract_number: proposed.contract_number,
    property_address: proposed.property_address,
    start_date: proposed.start_date,
    end_date: proposed.end_date,
    rent_amount: proposed.rent_amount,
    currency: proposed.currency,
  };
}

/** The accepted values, or `null` when no human has verified the document. */
export function verifiedFieldsFor(
  envelope: DocumentExtractionEnvelope | null,
): VerifiedDocumentFields | null {
  const verification = envelope?.verification;
  if (!verification || verification.status !== 'verified') return null;
  return verification.fields;
}

/** Rendering helper. Authorization reads `documents.verification_status`, never this. */
export function isEnvelopeVerified(envelope: DocumentExtractionEnvelope | null): boolean {
  return envelope?.verification?.status === 'verified';
}

/** Excerpt for one field, for the side-by-side verification view. */
export function excerptFor(
  envelope: DocumentExtractionEnvelope | null,
  field: ExcerptableField,
): { excerpt: string | null; found: boolean; line: number | null } | null {
  return envelope?.excerpts[field] ?? null;
}
