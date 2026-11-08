/**
 * Memberships, document rows and envelopes for the document tests.
 *
 * Two organizations with deliberately similar data, for the same reason the demo seed
 * uses similar data: a leak between two obviously different organizations is easy to
 * spot by accident, and a leak between two that look alike is the one that ships.
 *
 * Nothing here constructs a `Membership` by casting. The shape comes from
 * `lib/auth/roles.ts`, so if that interface changes these fixtures fail to compile
 * rather than silently describing a membership that no longer exists.
 */

import type { Membership } from '@/lib/auth/roles';
import type { MemberRole } from '@shared/index';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';

export const PROFILE_MANAGER_A = 'aaaaaaa1-1111-4111-8111-aaaaaaaaaaa1';
export const PROFILE_MANAGER_B = 'bbbbbbb1-1111-4111-8111-bbbbbbbbbbb1';
export const PROFILE_TENANT_A = 'aaaaaaa2-2222-4222-8222-aaaaaaaaaaa2';
export const PROFILE_PROVIDER_A = 'aaaaaaa3-3333-4333-8333-aaaaaaaaaaa3';

export const TENANT_A = 'ccccccc1-1111-4111-8111-ccccccccccc1';
export const TENANT_A_OTHER = 'ccccccc2-2222-4222-8222-ccccccccccc2';
export const PROVIDER_A = 'ddddddd1-1111-4111-8111-ddddddddddd1';
export const PROVIDER_A_OTHER = 'ddddddd2-2222-4222-8222-ddddddddddd2';

export const TENANCY_A = 'eeeeeee1-1111-4111-8111-eeeeeeeeeee1';
export const PROPERTY_A = 'fffffff1-1111-4111-8111-fffffffffff1';
export const TICKET_A = '99999991-1111-4111-8111-999999999991';

export const DOCUMENT_A = '12121212-1111-4111-8111-121212121212';
export const DOCUMENT_B = '34343434-2222-4222-8222-343434343434';

interface MembershipOverrides {
  role?: MemberRole;
  organizationId?: string;
  profileId?: string;
  memberId?: string;
  tenantId?: string | null;
  providerId?: string | null;
  status?: Membership['status'];
  organizationStatus?: Membership['organization']['status'];
}

export function membership(overrides: MembershipOverrides = {}): Membership {
  const organizationId = overrides.organizationId ?? ORG_A;
  return {
    memberId: overrides.memberId ?? 'member-1',
    role: overrides.role ?? 'property_manager',
    status: overrides.status ?? 'active',
    profile: {
      id: overrides.profileId ?? PROFILE_MANAGER_A,
      authUserId: 'auth-user-1',
      fullName: 'A Manager',
    },
    organization: {
      id: organizationId,
      name: organizationId === ORG_A ? 'Marina Operations' : 'Marina Property Co',
      slug: organizationId === ORG_A ? 'marina-operations' : 'marina-property-co',
      status: overrides.organizationStatus ?? 'active',
    },
    tenantId: overrides.tenantId ?? null,
    providerId: overrides.providerId ?? null,
  };
}

export const managerA = (): Membership => membership({ role: 'property_manager' });
export const adminA = (): Membership => membership({ role: 'organization_admin' });

export const managerB = (): Membership =>
  membership({
    role: 'property_manager',
    organizationId: ORG_B,
    profileId: PROFILE_MANAGER_B,
    memberId: 'member-b-1',
  });

export const tenantA = (): Membership =>
  membership({ role: 'tenant', profileId: PROFILE_TENANT_A, tenantId: TENANT_A });

export const providerA = (): Membership =>
  membership({ role: 'service_provider', profileId: PROFILE_PROVIDER_A, providerId: PROVIDER_A });

export const ownerA = (): Membership =>
  membership({ role: 'property_owner', memberId: 'member-owner-1' });

/* -------------------------------------------------------------- documents -- */

export interface DocumentRowOverrides {
  id?: string;
  organizationId?: string;
  propertyId?: string | null;
  tenancyId?: string | null;
  ticketId?: string | null;
  documentType?: string;
  storagePath?: string;
  extractedData?: unknown;
  verificationStatus?: string;
  uploadedBy?: string | null;
  createdAt?: string;
}

export function documentRow(overrides: DocumentRowOverrides = {}): Record<string, unknown> {
  const id = overrides.id ?? DOCUMENT_A;
  const organizationId = overrides.organizationId ?? ORG_A;
  const ticketId = overrides.ticketId ?? null;
  const entity = ticketId ? 'maintenance' : 'documents';

  return {
    id,
    organization_id: organizationId,
    property_id: overrides.propertyId ?? null,
    tenancy_id: overrides.tenancyId ?? null,
    ticket_id: ticketId,
    document_type: overrides.documentType ?? 'tenancy_contract',
    storage_path: overrides.storagePath ?? `${organizationId}/${entity}/${id}.pdf`,
    extracted_data: overrides.extractedData ?? null,
    // Deliberately includes the column the job handler must never write, so a test can
    // assert its absence from an update patch.
    extracted_text: null,
    verification_status: overrides.verificationStatus ?? 'pending',
    uploaded_by: overrides.uploadedBy ?? PROFILE_MANAGER_A,
    created_at: overrides.createdAt ?? '2026-03-01T08:00:00.000Z',
  };
}

/** A model proposal, shaped exactly like `DocumentExtractionSchema`'s output. */
export function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_name: 'Aisha Rahman',
    contract_number: 'EJ-2026-004217',
    property_address: 'Unit 1204, Marina Heights, Dubai Marina, Dubai',
    start_date: '2026-02-01',
    end_date: '2027-01-31',
    rent_amount: '120000.00',
    currency: 'AED',
    confidence_notes: [],
    requires_human_review: true,
    ...overrides,
  };
}

/** A stored envelope in the `pending` state: a proposal and no verification. */
export function pendingEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 'document-extraction@v1',
    extracted_at: '2026-03-01T08:05:00.000Z',
    extractor_id: 'test-extractor',
    text: { character_count: 240, page_count: 1, truncated: false },
    proposed: proposal(),
    excerpts: {
      tenant_name: { excerpt: 'Tenant Name: Aisha Rahman', found: true, line: 3 },
    },
    notes: [],
    verification: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------- jobs -- */

export interface JobRowOverrides {
  id?: string;
  type?: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string | null;
  attempts?: number;
  nextRunAt?: string | null;
  status?: string;
  lastError?: string | null;
  createdAt?: string;
}

export function jobRow(overrides: JobRowOverrides = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? '55555555-1111-4111-8111-555555555555',
    type: overrides.type ?? 'document_extraction',
    payload: overrides.payload ?? { document_id: DOCUMENT_A, organization_id: ORG_A },
    idempotency_key:
      overrides.idempotencyKey === undefined
        ? `document_extraction:${DOCUMENT_A}`
        : overrides.idempotencyKey,
    attempts: overrides.attempts ?? 0,
    next_run_at:
      overrides.nextRunAt === undefined ? '2026-03-01T08:00:00.000Z' : overrides.nextRunAt,
    status: overrides.status ?? 'queued',
    last_error: overrides.lastError ?? null,
    created_at: overrides.createdAt ?? '2026-03-01T08:00:00.000Z',
  };
}
