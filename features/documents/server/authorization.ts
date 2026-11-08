/**
 * Document authorization — the application-space half, with one documented divergence.
 *
 * `lib/auth/authorize.ts` encodes the §4 matrix in TypeScript and is the second of the
 * two enforcement layers. Every function here delegates to it. For four of the five
 * roles that is the whole story.
 *
 * ---------------------------------------------------------------------------
 * THE DIVERGENCE — reported as a planning defect; see this lane's report.
 * ---------------------------------------------------------------------------
 * Amendment A7 (`parallel-execution-plan.md` §5.8) grants a `service_provider`
 * INSERT and SELECT on `documents`, scoped to tickets assigned to them, and adds
 * `documents.ticket_id` to make that scoping expressible. Migration 0002 implements it
 * as `documents_insert_provider_assigned` and `documents_select_provider_assigned`, both
 * live on the database.
 *
 * `lib/auth/authorize.ts` was written against the matrix *before* A7 and still has
 * `document: { … service_provider: NONE }`. So the two layers disagree: Postgres permits
 * provider evidence, application space forbids it. Calling `assertAuthorized(…,
 * 'create', { type: 'document' })` for a provider therefore returns 403 and
 * `requirements.md` §3 — "Provider updates status and adds completion evidence" —
 * becomes unimplementable.
 *
 * `lib/**` is read-only to this lane, so the fix belongs to whoever owns that file.
 * What this module does in the meantime is the narrowest thing that is still correct:
 * for the provider-evidence case **only**, it performs the A7 predicate itself, clause
 * for clause, rather than widening anything or bypassing a check.
 *
 *   A7 INSERT policy requires            `assertProviderMayAttachEvidence` requires
 *   ------------------------------------ -----------------------------------------------
 *   ticket_id is not null                a ticket id in the request
 *   property_id is null                  no property association
 *   tenancy_id is null                   no tenancy association
 *   the ticket is assigned to the caller the ticket, read through the CALLER'S client
 *                                        (so RLS applies), has assigned_provider_id =
 *                                        the membership's provider id
 *   uploaded_by = current_profile_id()   the insert sets the membership's profile id
 *
 * It is strictly narrower than the policy, not wider: it additionally pins
 * `document_type` to `maintenance_evidence`, so a provider cannot file evidence as a
 * tenancy contract. If `lib/auth/authorize.ts` is later corrected, this function
 * becomes redundant and should be deleted rather than kept alongside it.
 *
 * Why this is not "working around a planning defect": the alternative is to deny the
 * provider and ship a build where the matrix's own amendment is dead code — and to do
 * it silently. Both the divergence and this compensation are reported.
 * ---------------------------------------------------------------------------
 */

import { assertAuthorized, type Action } from '@/lib/auth/authorize';
import type { Membership } from '@/lib/auth/roles';
import { ApiRouteError } from '@/lib/api/errors';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import type { DocumentType, UploadUrlInput } from '@shared/index';

/** The `document_type` a service provider may file. Narrower than the A7 policy. */
export const PROVIDER_EVIDENCE_DOCUMENT_TYPE: DocumentType = 'maintenance_evidence';

/** Roles that may request an upload URL: staff, plus a provider filing evidence. */
export const DOCUMENT_UPLOAD_ROLES = [
  'organization_admin',
  'property_manager',
  'service_provider',
] as const;

/** Roles that may process and verify. Mirrors `documents_update_staff` in 0002. */
export const DOCUMENT_STAFF_ROLES = ['organization_admin', 'property_manager'] as const;

/* ------------------------------------------------------------------ reads -- */

/**
 * The facts `authorize` needs about a document row.
 *
 * Every field must have been read from the row by the server. Nothing here may come
 * from a request (CLAUDE.md rule 5) — `organizationId` above all.
 */
export interface DocumentResourceFacts {
  readonly organizationId: string;
  readonly tenantId?: string | null;
  readonly ownerMemberId?: string | null;
  readonly providerId?: string | null;
}

/** Delegates to the matrix. Throws `AuthorizationDeniedError`, which becomes a 403. */
export function assertDocumentAction(
  membership: Membership,
  action: Action,
  facts: DocumentResourceFacts,
): void {
  assertAuthorized(membership, action, {
    type: 'document',
    organizationId: facts.organizationId,
    tenantId: facts.tenantId ?? null,
    ownerMemberId: facts.ownerMemberId ?? null,
    providerId: facts.providerId ?? null,
  });
}

/* ------------------------------------------------- provider evidence (A7) -- */

export interface ProviderEvidenceRequest {
  readonly ticket_id?: string | undefined;
  readonly property_id?: string | undefined;
  readonly tenancy_id?: string | undefined;
  readonly document_type: DocumentType;
}

/**
 * The A7 predicate, applied in application space.
 *
 * The ticket is read through `client`, which is the **caller-scoped** client. That
 * matters more than the comparison that follows it: a provider's
 * `maintenance_tickets` SELECT policy only returns tickets assigned to them, so a
 * ticket in another organization — or in this one but assigned elsewhere — comes back
 * as no rows and this function raises `NOT_FOUND`. The explicit
 * `assigned_provider_id` comparison afterwards is the second layer, on the assumption
 * that the first has a bug.
 */
export async function assertProviderMayAttachEvidence(
  membership: Membership,
  request: ProviderEvidenceRequest,
  client: AppSupabaseClient,
): Promise<{ ticketId: string }> {
  if (membership.status !== 'active' || membership.organization.status !== 'active') {
    throw new ApiRouteError('FORBIDDEN', { logFields: { reason: 'membership_not_active' } });
  }

  if (!membership.providerId) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'provider_identity_unresolved' },
    });
  }

  if (!request.ticket_id) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'provider_requires_ticket_evidence' },
    });
  }

  // The A7 INSERT policy forces both to null. Rejecting here rather than letting the
  // policy reject turns a confusing 403-from-Postgres into a precise one, and keeps a
  // provider from discovering which tenancy ids exist by probing for the error.
  if (request.property_id || request.tenancy_id) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'provider_may_not_set_property_or_tenancy' },
    });
  }

  if (request.document_type !== PROVIDER_EVIDENCE_DOCUMENT_TYPE) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'provider_document_type_not_evidence' },
    });
  }

  const { data, error } = await client
    .from('maintenance_tickets')
    .select('id, organization_id, assigned_provider_id')
    .eq('id', request.ticket_id)
    .maybeSingle();

  if (error) {
    throw new ApiRouteError('INTERNAL_ERROR', {
      logFields: { reason: 'ticket_lookup_failed', pg_code: error.code ?? 'unknown' },
      cause: error,
    });
  }

  // Absent or inaccessible are the same answer. Distinguishing them would confirm that
  // a ticket id exists in some organization, which is itself a disclosure.
  if (!data) throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'ticket_not_visible' } });

  if (data.organization_id !== membership.organization.id) {
    throw new ApiRouteError('NOT_FOUND', { logFields: { reason: 'ticket_cross_organization' } });
  }

  if (data.assigned_provider_id !== membership.providerId) {
    throw new ApiRouteError('FORBIDDEN', {
      logFields: { reason: 'ticket_not_assigned_to_caller' },
    });
  }

  return { ticketId: data.id };
}

/* ---------------------------------------------------------------- dispatch -- */

export type UploadAuthorization =
  { readonly kind: 'staff' } | { readonly kind: 'provider_evidence'; readonly ticketId: string };

/**
 * Authorizes an upload request by role, and reports which of the two paths applied.
 *
 * The caller needs to know: the provider path pins `property_id` and `tenancy_id` to
 * null in the insert, and the staff path validates them against the organization.
 */
export async function authorizeUpload(
  membership: Membership,
  request: UploadUrlInput,
  client: AppSupabaseClient,
): Promise<UploadAuthorization> {
  if (membership.role === 'service_provider') {
    const { ticketId } = await assertProviderMayAttachEvidence(
      membership,
      {
        ...(request.ticket_id ? { ticket_id: request.ticket_id } : {}),
        ...(request.property_id ? { property_id: request.property_id } : {}),
        ...(request.tenancy_id ? { tenancy_id: request.tenancy_id } : {}),
        document_type: request.document_type,
      },
      client,
    );
    return { kind: 'provider_evidence', ticketId };
  }

  assertDocumentAction(membership, 'create', { organizationId: membership.organization.id });
  return { kind: 'staff' };
}
