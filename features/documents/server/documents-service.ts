/**
 * Database and storage access for `/api/v1/documents/*`.
 *
 * Everything here takes an explicit client. Reads and writes of `documents` use the
 * **caller-scoped** client, so Row Level Security is the first enforcement layer and the
 * application checks in `authorization.ts` are the second. The only service-role use in
 * this lane is the job queue (`services/workers`), which has no caller to be scoped to.
 *
 * Three habits worth noticing, because they are the difference between this file and a
 * thin wrapper over PostgREST:
 *
 *  - **Absent and inaccessible are the same answer.** A row RLS hides comes back as
 *    zero rows, and so does a row that does not exist. Both become `NOT_FOUND`.
 *    Distinguishing them would let organization B confirm that one of organization A's
 *    document ids exists, which is a leak with no code defect anywhere.
 *  - **`extracted_text` is never selected.** `DOCUMENT_COLUMNS` omits it. The column
 *    holds the whole document body; it is read by exactly one code path (the extraction
 *    worker's own re-read, which does not use this module) and is never shipped to a
 *    client or put in a response. `DocumentSchema` in `packages/shared` has no field for
 *    it, by design.
 *  - **Writes name their columns and pin their preconditions.** The verification update
 *    carries `.eq('verification_status', 'pending')`, so two reviewers racing produce one
 *    decision and one `409`, not a last-write-wins overwrite of a human judgement.
 */

import {
  SIGNED_URL_TTL_SECONDS,
  STORAGE_BUCKET,
  buildStoragePath,
  isStoragePathForOrganization,
  type DocumentType,
  type Json,
  type ListDocumentsQuery,
  type StorageEntity,
  type VerificationStatus,
} from '@shared/index';
import { ApiRouteError, throwIfPostgresError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import {
  MIN_PDF_BYTES,
  PDF_MAGIC_SEARCH_WINDOW,
  UploadValidationError,
  validatePdfBytes,
  type DocumentExtractionEnvelope,
} from '@/services/extraction';

import { decodeDocumentCursor, encodeDocumentCursor } from './cursor';

/**
 * Columns read for every document. `extracted_text` is deliberately absent — see the
 * file header.
 */
export const DOCUMENT_COLUMNS =
  'id, organization_id, property_id, tenancy_id, ticket_id, document_type, storage_path, extracted_data, verification_status, uploaded_by, created_at';

/** A `documents` row as this lane reads it. */
export interface DocumentRecord {
  id: string;
  organization_id: string;
  property_id: string | null;
  tenancy_id: string | null;
  ticket_id: string | null;
  document_type: string;
  storage_path: string;
  extracted_data: unknown;
  verification_status: string;
  uploaded_by: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ reads -- */

/**
 * One document, or `null`.
 *
 * `maybeSingle` rather than `single`: `single` turns "no rows" into a PostgREST error
 * (`PGRST116`), and an RLS-hidden row is the *expected* case for a cross-organization
 * request, not an exception.
 */
export async function findDocument(
  client: AppSupabaseClient,
  documentId: string,
): Promise<DocumentRecord | null> {
  const { data, error } = await client
    .from('documents')
    .select(DOCUMENT_COLUMNS)
    .eq('id', documentId)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as unknown as DocumentRecord | null) ?? null;
}

/** `findDocument`, as an assertion. A hidden row and a missing row both give 404. */
export async function requireDocument(
  client: AppSupabaseClient,
  documentId: string,
): Promise<DocumentRecord> {
  const document = await findDocument(client, documentId);
  if (!document) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'document_not_visible' } });
  }
  return document;
}

export interface DocumentPage {
  readonly items: readonly DocumentRecord[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;
}

/**
 * A page of documents the caller may see.
 *
 * The query is **not** filtered by organization. That looks like an omission and is the
 * opposite: `organization_id` would have to come from somewhere, and the only safe
 * source is the membership — which is exactly what RLS already applies, on every one of
 * the five `documents_select_*` policies. Adding `.eq('organization_id', …)` would make
 * the route look like the thing enforcing isolation and invite someone to later take
 * the value from a query parameter. The organization is asserted on the way *out*
 * instead, by `assertSameOrganization` below, which is a check rather than a filter.
 *
 * `limit + 1` rows are fetched so `has_more` is known without a second count query.
 */
export async function listDocuments(
  client: AppSupabaseClient,
  membership: Membership,
  query: ListDocumentsQuery,
): Promise<DocumentPage> {
  const limit = query.limit;
  const cursor = decodeDocumentCursor(query.cursor);

  let request = client
    .from('documents')
    .select(DOCUMENT_COLUMNS)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (query.document_type) request = request.eq('document_type', query.document_type);
  if (query.verification_status) {
    request = request.eq('verification_status', query.verification_status);
  }
  if (query.property_id) request = request.eq('property_id', query.property_id);
  if (query.tenancy_id) request = request.eq('tenancy_id', query.tenancy_id);
  if (query.ticket_id) request = request.eq('ticket_id', query.ticket_id);

  if (cursor) {
    // Keyset: strictly older than the cursor row, with `id` breaking ties so a second
    // document created in the same microsecond is neither skipped nor repeated.
    request = request.or(
      `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
    );
  }

  const { data, error } = await request;
  throwIfPostgresError(error);

  const rows = (data ?? []) as unknown as DocumentRecord[];
  for (const row of rows) assertSameOrganization(row, membership);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    limit,
    nextCursor:
      hasMore && last ? encodeDocumentCursor({ createdAt: last.created_at, id: last.id }) : null,
  };
}

/**
 * The last line of defence on a read path.
 *
 * RLS returned the row and the matrix allowed the action; this asserts that the row
 * actually belongs to the caller's organization anyway. It has never fired in testing
 * and that is the point — it is there for the day a policy is edited and one of the
 * five `documents_select_*` predicates loses its organization clause. A 500 is the
 * correct outcome: there is no request a client can make that should reach it, so it is
 * a defect in our code rather than a denial to report.
 */
export function assertSameOrganization(document: DocumentRecord, membership: Membership): void {
  if (document.organization_id === membership.organization.id) return;
  throw new ApiRouteError('INTERNAL_ERROR', {
    logFields: {
      reason: 'cross_organization_row_returned',
      organization_id: membership.organization.id,
      document_id: document.id,
    },
  });
}

/* ------------------------------------------------------------------ facts -- */

/**
 * The row-level facts `lib/auth/authorize.ts` needs about a document.
 *
 * Resolved through the caller's client, so each lookup is itself RLS-checked. A tenant
 * who cannot see the tenancy gets `tenantId: null` and fails the ownership predicate,
 * which is the right answer arrived at twice.
 */
export interface ResolvedDocumentFacts {
  readonly organizationId: string;
  readonly tenantId: string | null;
  readonly ownerMemberId: string | null;
  readonly providerId: string | null;
}

export async function resolveDocumentFacts(
  client: AppSupabaseClient,
  document: DocumentRecord,
): Promise<ResolvedDocumentFacts> {
  const [tenantId, ownerMemberId, providerId] = await Promise.all([
    document.tenancy_id ? tenantForTenancy(client, document.tenancy_id) : Promise.resolve(null),
    document.property_id ? ownerForProperty(client, document.property_id) : Promise.resolve(null),
    document.ticket_id ? providerForTicket(client, document.ticket_id) : Promise.resolve(null),
  ]);

  return { organizationId: document.organization_id, tenantId, ownerMemberId, providerId };
}

async function tenantForTenancy(
  client: AppSupabaseClient,
  tenancyId: string,
): Promise<string | null> {
  const { data } = await client
    .from('tenancies')
    .select('tenant_id')
    .eq('id', tenancyId)
    .maybeSingle();
  return data?.tenant_id ?? null;
}

async function ownerForProperty(
  client: AppSupabaseClient,
  propertyId: string,
): Promise<string | null> {
  const { data } = await client
    .from('properties')
    .select('owner_member_id')
    .eq('id', propertyId)
    .maybeSingle();
  return data?.owner_member_id ?? null;
}

async function providerForTicket(
  client: AppSupabaseClient,
  ticketId: string,
): Promise<string | null> {
  const { data } = await client
    .from('maintenance_tickets')
    .select('assigned_provider_id')
    .eq('id', ticketId)
    .maybeSingle();
  return data?.assigned_provider_id ?? null;
}

/* ------------------------------------------------------- association check -- */

export interface AssociationRequest {
  readonly property_id?: string | undefined;
  readonly tenancy_id?: string | undefined;
  readonly ticket_id?: string | undefined;
}

/**
 * Checks that every association the caller named is one they can actually see.
 *
 * The composite foreign keys on `documents` — `(organization_id, property_id)` and
 * friends — already make a cross-organization association impossible, so this is not
 * the thing preventing the attack. It exists to make the *failure* right: without it a
 * caller naming another organization's tenancy gets `23503` mapped to `422`, which says
 * "your request is semantically invalid" about a request that was in fact unauthorized,
 * and the attempt is hard to distinguish in the logs from a typo. With it the caller
 * gets `404`, the same answer they get for an id that does not exist.
 */
export async function assertAssociationsVisible(
  client: AppSupabaseClient,
  request: AssociationRequest,
): Promise<void> {
  const checks: { table: 'properties' | 'tenancies' | 'maintenance_tickets'; id: string }[] = [];
  if (request.property_id) checks.push({ table: 'properties', id: request.property_id });
  if (request.tenancy_id) checks.push({ table: 'tenancies', id: request.tenancy_id });
  if (request.ticket_id) checks.push({ table: 'maintenance_tickets', id: request.ticket_id });

  for (const check of checks) {
    const { data, error } = await client
      .from(check.table)
      .select('id')
      .eq('id', check.id)
      .maybeSingle();

    throwIfPostgresError(error);
    if (!data) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'association_not_visible', entity_type: check.table },
      });
    }
  }
}

/* ----------------------------------------------------------------- writes -- */

export interface InsertDocumentInput {
  /** Server-generated. Shared with the storage object name so the two cannot drift. */
  readonly id: string;
  readonly organizationId: string;
  readonly documentType: DocumentType;
  readonly storagePath: string;
  /** `profiles.id` from the session. `documents_insert_staff` requires exactly this. */
  readonly uploadedBy: string;
  readonly propertyId?: string | null;
  readonly tenancyId?: string | null;
  readonly ticketId?: string | null;
}

/**
 * Registers an uploaded document.
 *
 * `verification_status` is not named in the insert. It takes the column default,
 * `'pending'`, which means there is no code path in this lane — not even a mistaken one
 * — that can create a document in any other state. The RLS INSERT policies could not
 * stop it if there were: `documents_insert_staff` has no clause about verification,
 * because the column default plus the absence of this field is what guarantees it.
 */
export async function insertDocument(
  client: AppSupabaseClient,
  input: InsertDocumentInput,
): Promise<DocumentRecord> {
  if (!isStoragePathForOrganization(input.storagePath, input.organizationId)) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'storage_path_outside_organization' },
    });
  }

  const { data, error } = await client
    .from('documents')
    .insert({
      id: input.id,
      organization_id: input.organizationId,
      document_type: input.documentType,
      storage_path: input.storagePath,
      uploaded_by: input.uploadedBy,
      property_id: input.propertyId ?? null,
      tenancy_id: input.tenancyId ?? null,
      ticket_id: input.ticketId ?? null,
    })
    .select(DOCUMENT_COLUMNS)
    .single();

  throwIfPostgresError(error);
  if (!data) {
    throw new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'document_insert_no_row' } });
  }
  return data as unknown as DocumentRecord;
}

export interface RecordVerificationInput {
  readonly documentId: string;
  readonly status: Extract<VerificationStatus, 'verified' | 'rejected'>;
  readonly envelope: DocumentExtractionEnvelope;
}

/**
 * Writes a human verification decision. **The only writer of `verification_status`.**
 *
 * Two properties this function must keep:
 *
 *  1. `.eq('verification_status', 'pending')` — the compare-and-swap. Two reviewers
 *     opening the same document produce one decision; the loser gets zero rows back and
 *     the route raises `409`. Without it the second submission would silently overwrite
 *     the first, and the audit trail would show two verifications of which only one
 *     took effect.
 *  2. It touches `documents` and nothing else. In particular it does not write
 *     `tenancies`. A verified contract's dates and rent are a *record of what the
 *     document says*; propagating them into the tenancy row would make an extraction —
 *     reviewed, but still an extraction — the source of a tenancy's legal terms. That
 *     is a separate, deliberate action for a human in the tenancy screens (lane w1-l3),
 *     not a side effect of clicking "verify".
 */
export async function recordVerification(
  client: AppSupabaseClient,
  input: RecordVerificationInput,
): Promise<DocumentRecord | null> {
  const { data, error } = await client
    .from('documents')
    .update({
      verification_status: input.status,
      extracted_data: input.envelope as unknown as Json,
    })
    .eq('id', input.documentId)
    .eq('verification_status', 'pending')
    .select(DOCUMENT_COLUMNS)
    .maybeSingle();

  throwIfPostgresError(error);
  return (data as unknown as DocumentRecord | null) ?? null;
}

/* ---------------------------------------------------------------- storage -- */

/** The `{entity}` path segment. Ticket evidence is filed under `maintenance`. */
export function storageEntityFor(ticketId: string | null | undefined): StorageEntity {
  return ticketId ? 'maintenance' : 'documents';
}

/** The one legal object path, built from trusted values only. */
export function storagePathFor(
  organizationId: string,
  ticketId: string | null | undefined,
  objectId: string,
): string {
  return buildStoragePath(organizationId, storageEntityFor(ticketId), objectId);
}

export interface SignedUrl {
  readonly url: string;
  readonly expiresInSeconds: number;
}

/**
 * A signed URL for uploading one object.
 *
 * ---------------------------------------------------------------------------
 * TTL — reported as a planning defect; see this lane's report.
 * ---------------------------------------------------------------------------
 * §5.7 freezes the signed-URL TTL at 60 seconds, and `UploadUrlResponseSchema` types
 * `expires_in_seconds` as `z.literal(SIGNED_URL_TTL_SECONDS)`. For *downloads* that is
 * exactly what happens: `createSignedUrl(path, 60)` takes the TTL as an argument and the
 * token really does expire.
 *
 * For *uploads* it cannot. `storage-js`'s `createSignedUploadUrl(path, { upsert })` — the
 * version installed here, and every 2.x — accepts no `expiresIn`, and the token's
 * lifetime is set by the Storage service rather than by the client. There is no
 * supabase-js call that issues a 60-second upload token.
 *
 * So the number in the response is the contract's value and is honest about the API
 * contract — a client should treat the URL as valid for 60 seconds — while the
 * underlying token outlives it. What limits the exposure instead:
 *
 *   * The token authorises writing **one** object path, which is a server-generated
 *     UUID inside the caller's own organization prefix.
 *   * The storage INSERT policy independently requires active membership of the
 *     organization in path segment 1, so a leaked token is no more powerful than the
 *     membership the caller already has.
 *   * An object with no `documents` row is inert: nothing can list it, sign it or
 *     process it.
 *
 * It is still a divergence from a frozen value, which is why it is reported rather than
 * commented away.
 * ---------------------------------------------------------------------------
 */
export async function createUploadUrl(
  client: AppSupabaseClient,
  storagePath: string,
): Promise<SignedUrl> {
  const { data, error } = await client.storage
    .from(STORAGE_BUCKET)
    // No `upsert`: overwriting an existing object is a separate, staff-only action
    // (`documents_objects_update_staff`), and an upload URL must not be able to replace
    // a stored contract.
    .createSignedUploadUrl(storagePath);

  if (error || !data?.signedUrl) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'signed_upload_url_failed', bucket: STORAGE_BUCKET },
      cause: error,
    });
  }

  return { url: data.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS };
}

/**
 * A 60-second signed URL for reading one object.
 *
 * The path is re-checked against the caller's organization before signing, even though
 * it was read from a row RLS already allowed. Storage policies derive the organization
 * from path segment 1 and are the floor; this is the gate, and it is what makes a
 * corrupted `storage_path` a 500 in our code rather than a signed URL into another
 * tenant's prefix.
 */
export async function createDownloadUrl(
  client: AppSupabaseClient,
  document: DocumentRecord,
  membership: Membership,
): Promise<SignedUrl> {
  assertSameOrganization(document, membership);
  if (!isStoragePathForOrganization(document.storage_path, membership.organization.id)) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'storage_path_outside_organization', document_id: document.id },
    });
  }

  const { data, error } = await client.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(document.storage_path, SIGNED_URL_TTL_SECONDS);

  if (error || !data?.signedUrl) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'signed_download_url_failed', bucket: STORAGE_BUCKET },
      cause: error,
    });
  }

  return { url: data.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS };
}

/** Bytes requested for the header sniff. One kibibyte covers the search window. */
const HEADER_PROBE_BYTES = PDF_MAGIC_SEARCH_WINDOW + 64;

/**
 * Three distinct outcomes, each its own single-literal variant so `reason` is a usable
 * discriminant. A variant typed `'object_missing' | 'probe_failed'` would compile and
 * then refuse to narrow at the call site, which is how a route ends up with a cast.
 */
export type HeaderProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'object_missing' }
  | { readonly ok: false; readonly reason: 'probe_failed' }
  | { readonly ok: false; readonly reason: 'rejected'; readonly validation: UploadValidationError };

/**
 * Magic-byte validation of a stored object, without downloading it.
 *
 * This is the check a direct-to-Storage upload makes necessary. The bytes never pass
 * through the application on the way in — that is the point of a signed upload URL — so
 * the only place a declared `application/pdf` can be compared against reality is here,
 * on the way to processing.
 *
 * A ranged `GET` over a signed URL rather than `storage.download()`, because `download`
 * fetches the whole object and the question needs 1 KiB. On a 10 MB contract that is
 * four orders of magnitude of difference for an identical answer.
 *
 * The signed URL is issued with the caller's client, so a caller who cannot read the
 * object cannot probe it either.
 */
export async function probePdfHeader(
  client: AppSupabaseClient,
  document: DocumentRecord,
  membership: Membership,
  fetchImpl: typeof fetch = fetch,
): Promise<HeaderProbe> {
  const signed = await createDownloadUrl(client, document, membership);

  let response: Response;
  try {
    response = await fetchImpl(signed.url, {
      headers: { Range: `bytes=0-${HEADER_PROBE_BYTES - 1}` },
      cache: 'no-store',
    });
  } catch {
    return { ok: false, reason: 'probe_failed' };
  }

  if (response.status === 404 || response.status === 400) {
    return { ok: false, reason: 'object_missing' };
  }
  // 206 for a satisfied range, 200 when the object is smaller than the range.
  if (response.status !== 200 && response.status !== 206) {
    return { ok: false, reason: 'probe_failed' };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) return { ok: false, reason: 'object_missing' };

  // A ranged read returns at most 1 KiB, so the full-file size cap cannot be judged
  // here. Storage enforces it on upload (`file_size_limit`) and the worker enforces it
  // on the complete object; this check is the signature and the floor.
  const validation = validatePdfBytes(
    bytes.length >= MIN_PDF_BYTES ? bytes : padForMinimumCheck(bytes),
  );
  if (!validation.ok) {
    return {
      ok: false,
      reason: 'rejected',
      validation: new UploadValidationError(validation.reason),
    };
  }
  return { ok: true };
}

/**
 * A ranged read of a tiny object can legitimately return fewer than `MIN_PDF_BYTES`.
 * Padding keeps `validatePdfBytes`'s minimum-size rule from firing on a short *read* of
 * a long enough *file*; the worker applies the real minimum to the whole object.
 */
function padForMinimumCheck(bytes: Uint8Array): Uint8Array {
  const padded = new Uint8Array(MIN_PDF_BYTES);
  padded.set(bytes.subarray(0, Math.min(bytes.length, MIN_PDF_BYTES)));
  return padded;
}
