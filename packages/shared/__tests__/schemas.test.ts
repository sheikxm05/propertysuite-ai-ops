import { describe, expect, it } from 'vitest';

import {
  ClassificationSchema,
  ClassifyRequestSchema,
  ConfirmTicketSchema,
  DocumentExtractionSchema,
} from '../schemas/ai';
import { UploadUrlSchema, VerifyDocumentSchema } from '../schemas/document';
import {
  AssignTicketSchema,
  CompleteTicketSchema,
  CreateActivitySchema,
  CreateTicketSchema,
  ListTicketsQuerySchema,
  UpdateTicketSchema,
} from '../schemas/maintenance';
import {
  AcceptInvitationSchema,
  CreateOrganizationSchema,
  InviteMemberSchema,
  UpdateMemberSchema,
  UpdateProfileSchema,
} from '../schemas/organization';
import {
  CreatePropertySchema,
  ListPropertiesQuerySchema,
  UpdatePropertySchema,
} from '../schemas/property';
import { CreateTenancySchema, UpdateTenancySchema } from '../schemas/tenancy';
import { CreateTenantSchema, UpdateTenantSchema } from '../schemas/tenant';
import { CreateUnitSchema, UpdateUnitSchema } from '../schemas/unit';
import { MAX_UPLOAD_BYTES } from '../constants/storage';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER_UUID = '11111111-2222-4333-8444-555555555555';

/**
 * Accept and reject cases for every request schema.
 *
 * The reject cases that matter most are the mass-assignment ones. Every request
 * schema is `.strict()`, so a body that smuggles `organization_id`, `status`,
 * `tenant_id` or `role` is a 400 rather than a silently ignored field. Those
 * assertions are the contract-level half of "never trust a client-supplied
 * organization_id" and are repeated per domain on purpose — a single
 * non-strict schema would be a hole.
 */

describe('CreateOrganizationSchema', () => {
  it('accepts a name and slug', () => {
    expect(CreateOrganizationSchema.parse({ name: 'Marina Group', slug: 'marina-group' })).toEqual({
      name: 'Marina Group',
      slug: 'marina-group',
    });
  });

  it('rejects a missing field, a short name and a bad slug', () => {
    expect(() => CreateOrganizationSchema.parse({ name: 'Marina Group' })).toThrow();
    expect(() => CreateOrganizationSchema.parse({ name: 'M', slug: 'marina' })).toThrow();
    expect(() => CreateOrganizationSchema.parse({ name: 'Marina', slug: 'Bad Slug' })).toThrow();
  });

  it('rejects an unknown key', () => {
    expect(() =>
      CreateOrganizationSchema.parse({ name: 'Marina', slug: 'marina', status: 'active' }),
    ).toThrow();
  });
});

describe('InviteMemberSchema', () => {
  it('accepts an email and a role', () => {
    expect(InviteMemberSchema.parse({ email: 'A@B.com', role: 'tenant' })).toEqual({
      email: 'a@b.com',
      role: 'tenant',
    });
  });

  it('rejects an unknown role and a malformed email', () => {
    expect(() => InviteMemberSchema.parse({ email: 'a@b.com', role: 'superuser' })).toThrow();
    expect(() => InviteMemberSchema.parse({ email: 'nope', role: 'tenant' })).toThrow();
  });

  it('rejects a client-supplied organization_id', () => {
    expect(() =>
      InviteMemberSchema.parse({ email: 'a@b.com', role: 'tenant', organization_id: UUID }),
    ).toThrow();
  });
});

describe('AcceptInvitationSchema', () => {
  it('accepts a token of plausible length', () => {
    const token = 'a'.repeat(43);
    expect(AcceptInvitationSchema.parse({ invitation_token: token })).toEqual({
      invitation_token: token,
    });
  });

  it('rejects a short token and an unknown key', () => {
    expect(() => AcceptInvitationSchema.parse({ invitation_token: 'short' })).toThrow();
    expect(() =>
      AcceptInvitationSchema.parse({
        invitation_token: 'a'.repeat(43),
        role: 'organization_admin',
      }),
    ).toThrow();
  });
});

describe('UpdateMemberSchema and UpdateProfileSchema', () => {
  it('accepts a role change and a disable', () => {
    expect(UpdateMemberSchema.parse({ role: 'property_manager' })).toEqual({
      role: 'property_manager',
    });
    expect(UpdateMemberSchema.parse({ status: 'disabled' })).toEqual({ status: 'disabled' });
  });

  it('rejects an empty body and an invited status, which is not a reachable update', () => {
    expect(() => UpdateMemberSchema.parse({})).toThrow();
    expect(() => UpdateMemberSchema.parse({ status: 'invited' })).toThrow();
  });

  it('lets a user update their own name and phone but not their email identity', () => {
    expect(UpdateProfileSchema.parse({ full_name: 'Aisha Khan' })).toEqual({
      full_name: 'Aisha Khan',
    });
    expect(UpdateProfileSchema.parse({ phone: null })).toEqual({ phone: null });
    expect(() => UpdateProfileSchema.parse({ email: 'new@example.com' })).toThrow();
    expect(() => UpdateProfileSchema.parse({ auth_user_id: UUID })).toThrow();
    expect(() => UpdateProfileSchema.parse({})).toThrow();
  });
});

describe('CreatePropertySchema', () => {
  it('accepts the api-contracts.md example field for field', () => {
    expect(
      CreatePropertySchema.parse({
        name: 'Marina Residence',
        property_type: 'apartment_building',
        address_line: 'Example Street',
        city: 'Dubai',
        emirate: 'Dubai',
      }),
    ).toEqual({
      name: 'Marina Residence',
      property_type: 'apartment_building',
      address_line: 'Example Street',
      city: 'Dubai',
      emirate: 'Dubai',
    });
  });

  it('defaults city and emirate to Dubai', () => {
    const parsed = CreatePropertySchema.parse({
      name: 'Marina Residence',
      property_type: 'villa',
      address_line: 'Example Street',
    });
    expect(parsed.city).toBe('Dubai');
    expect(parsed.emirate).toBe('Dubai');
  });

  it('accepts an optional owner association', () => {
    expect(
      CreatePropertySchema.parse({
        name: 'Marina Residence',
        property_type: 'villa',
        address_line: 'Example Street',
        owner_member_id: UUID,
      }).owner_member_id,
    ).toBe(UUID);
  });

  it('rejects an unknown property type and a missing address', () => {
    expect(() =>
      CreatePropertySchema.parse({
        name: 'X Tower',
        property_type: 'space_station',
        address_line: 'Example Street',
      }),
    ).toThrow();
    expect(() => CreatePropertySchema.parse({ name: 'X Tower', property_type: 'villa' })).toThrow();
  });

  it('rejects a client-supplied organization_id or status', () => {
    const base = {
      name: 'Marina Residence',
      property_type: 'villa',
      address_line: 'Example Street',
    };
    expect(() => CreatePropertySchema.parse({ ...base, organization_id: UUID })).toThrow();
    expect(() => CreatePropertySchema.parse({ ...base, status: 'archived' })).toThrow();
  });
});

describe('UpdatePropertySchema', () => {
  it('accepts a partial update and the archive status change', () => {
    expect(UpdatePropertySchema.parse({ name: 'New Name' })).toEqual({ name: 'New Name' });
    expect(UpdatePropertySchema.parse({ status: 'archived' })).toEqual({ status: 'archived' });
    expect(UpdatePropertySchema.parse({ owner_member_id: null })).toEqual({
      owner_member_id: null,
    });
  });

  it('rejects an empty body', () => {
    expect(() => UpdatePropertySchema.parse({})).toThrow();
  });

  it('offers no status that deletes a row', () => {
    expect(() => UpdatePropertySchema.parse({ status: 'deleted' })).toThrow();
  });
});

describe('ListPropertiesQuerySchema', () => {
  it('accepts an empty query and applies the default limit', () => {
    expect(ListPropertiesQuerySchema.parse({}).limit).toBe(25);
  });

  it('accepts filters from a query string', () => {
    const parsed = ListPropertiesQuerySchema.parse({ status: 'active', q: 'marina', limit: '10' });
    expect(parsed.status).toBe('active');
    expect(parsed.q).toBe('marina');
    expect(parsed.limit).toBe(10);
  });

  it('rejects an unknown filter', () => {
    expect(() => ListPropertiesQuerySchema.parse({ organization_id: UUID })).toThrow();
  });
});

describe('CreateUnitSchema and UpdateUnitSchema', () => {
  it('accepts a unit number alone', () => {
    expect(CreateUnitSchema.parse({ unit_number: '1203' })).toEqual({ unit_number: '1203' });
  });

  it('accepts a studio and fractional bathrooms', () => {
    expect(
      CreateUnitSchema.parse({ unit_number: 'S1', bedrooms: 0, bathrooms: 1.5, area_sqft: 480.5 }),
    ).toBeTruthy();
  });

  it('rejects a property_id in the body — the unit belongs to the path', () => {
    expect(() => CreateUnitSchema.parse({ unit_number: '1203', property_id: UUID })).toThrow();
    expect(() => CreateUnitSchema.parse({ unit_number: '1203', organization_id: UUID })).toThrow();
  });

  it('rejects out-of-range measurements', () => {
    expect(() => CreateUnitSchema.parse({ unit_number: '1', bedrooms: -1 })).toThrow();
    expect(() => CreateUnitSchema.parse({ unit_number: '1', bathrooms: 2.55 })).toThrow();
  });

  it('accepts clearing a measurement on update and rejects an empty body', () => {
    expect(UpdateUnitSchema.parse({ bedrooms: null })).toEqual({ bedrooms: null });
    expect(() => UpdateUnitSchema.parse({})).toThrow();
  });
});

describe('CreateTenantSchema and UpdateTenantSchema', () => {
  it('accepts a name alone and normalizes contact details', () => {
    expect(CreateTenantSchema.parse({ full_name: 'Aisha Khan' })).toEqual({
      full_name: 'Aisha Khan',
    });
    const parsed = CreateTenantSchema.parse({
      full_name: 'Aisha Khan',
      email: 'Aisha@Example.com',
      phone: '+971 50 123 4567',
    });
    expect(parsed.email).toBe('aisha@example.com');
    expect(parsed.phone).toBe('+971501234567');
  });

  it('rejects a one-character name and an organization_id', () => {
    expect(() => CreateTenantSchema.parse({ full_name: 'A' })).toThrow();
    expect(() =>
      CreateTenantSchema.parse({ full_name: 'Aisha Khan', organization_id: UUID }),
    ).toThrow();
  });

  it('accepts a partial update and rejects an empty one', () => {
    expect(UpdateTenantSchema.parse({ email: null })).toEqual({ email: null });
    expect(() => UpdateTenantSchema.parse({})).toThrow();
  });
});

describe('CreateTenancySchema', () => {
  const valid = {
    property_unit_id: UUID,
    tenant_id: OTHER_UUID,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    rent_amount: '120000',
  };

  it('accepts a valid tenancy and normalizes the money and currency', () => {
    const parsed = CreateTenancySchema.parse(valid);
    expect(parsed.rent_amount).toBe('120000.00');
    expect(parsed.currency).toBe('AED');
  });

  it('accepts a numeric rent amount and still returns a string', () => {
    expect(CreateTenancySchema.parse({ ...valid, rent_amount: 120000 }).rent_amount).toBe(
      '120000.00',
    );
  });

  it('rejects an end date before the start date, mirroring the database check', () => {
    expect(() =>
      CreateTenancySchema.parse({ ...valid, start_date: '2026-12-31', end_date: '2026-01-01' }),
    ).toThrow();
  });

  it('accepts a single-day tenancy, since the constraint is >=', () => {
    expect(
      CreateTenancySchema.parse({ ...valid, start_date: '2026-01-01', end_date: '2026-01-01' }),
    ).toBeTruthy();
  });

  it('rejects an impossible date and a negative rent', () => {
    expect(() => CreateTenancySchema.parse({ ...valid, end_date: '2026-02-31' })).toThrow();
    expect(() => CreateTenancySchema.parse({ ...valid, rent_amount: '-1' })).toThrow();
  });

  it('rejects a client-supplied organization_id', () => {
    expect(() => CreateTenancySchema.parse({ ...valid, organization_id: UUID })).toThrow();
  });
});

describe('UpdateTenancySchema', () => {
  it('accepts a status change and a rent change', () => {
    expect(UpdateTenancySchema.parse({ status: 'active' })).toEqual({ status: 'active' });
    expect(UpdateTenancySchema.parse({ rent_amount: '95000.5' }).rent_amount).toBe('95000.50');
  });

  it('rejects changing the unit or the tenant — that is a new tenancy', () => {
    expect(() => UpdateTenancySchema.parse({ property_unit_id: UUID })).toThrow();
    expect(() => UpdateTenancySchema.parse({ tenant_id: UUID })).toThrow();
  });

  it('checks the date order when both dates are supplied', () => {
    expect(() =>
      UpdateTenancySchema.parse({ start_date: '2026-12-31', end_date: '2026-01-01' }),
    ).toThrow();
    expect(UpdateTenancySchema.parse({ start_date: '2026-01-01' })).toBeTruthy();
  });

  it('rejects an empty body', () => {
    expect(() => UpdateTenancySchema.parse({})).toThrow();
  });
});

describe('CreateTicketSchema', () => {
  const valid = {
    property_unit_id: UUID,
    title: 'Air conditioning not cooling',
    description: 'The AC is running but not cooling the room.',
    category: 'hvac',
    priority: 'normal',
    source: 'web',
  };

  it('accepts the api-contracts.md example field for field', () => {
    expect(CreateTicketSchema.parse(valid)).toEqual(valid);
  });

  it('defaults an unclassified ticket to unknown and web', () => {
    const parsed = CreateTicketSchema.parse({
      property_unit_id: UUID,
      title: 'Something is wrong',
      description: 'I am not sure what the problem is exactly.',
    });
    expect(parsed.category).toBe('unknown');
    expect(parsed.source).toBe('web');
    expect(parsed.priority).toBeUndefined();
  });

  it('rejects an unknown category or source', () => {
    expect(() => CreateTicketSchema.parse({ ...valid, category: 'wizardry' })).toThrow();
    expect(() => CreateTicketSchema.parse({ ...valid, source: 'telepathy' })).toThrow();
  });

  it('rejects a too-short description, so a ticket carries usable information', () => {
    expect(() => CreateTicketSchema.parse({ ...valid, description: 'broken' })).toThrow();
  });

  it('rejects every server-derived field', () => {
    for (const field of [
      'organization_id',
      'property_id',
      'tenant_id',
      'tenancy_id',
      'assigned_provider_id',
      'status',
    ]) {
      expect(() => CreateTicketSchema.parse({ ...valid, [field]: UUID })).toThrow();
    }
  });
});

describe('UpdateTicketSchema', () => {
  it('accepts a status transition and a re-prioritization', () => {
    expect(UpdateTicketSchema.parse({ status: 'in_progress' })).toEqual({
      status: 'in_progress',
    });
    expect(UpdateTicketSchema.parse({ priority: 'urgent' })).toEqual({ priority: 'urgent' });
  });

  it('rejects assignment, which has its own route and its own authorization', () => {
    expect(() => UpdateTicketSchema.parse({ assigned_provider_id: UUID })).toThrow();
  });

  it('rejects an unknown status and an empty body', () => {
    expect(() => UpdateTicketSchema.parse({ status: 'done' })).toThrow();
    expect(() => UpdateTicketSchema.parse({})).toThrow();
  });
});

describe('AssignTicketSchema', () => {
  it('accepts a provider and an optional note', () => {
    expect(AssignTicketSchema.parse({ provider_id: UUID })).toEqual({ provider_id: UUID });
    expect(AssignTicketSchema.parse({ provider_id: UUID, note: 'Scheduled Tuesday' })).toBeTruthy();
  });

  it('rejects a missing or malformed provider and an organization_id', () => {
    expect(() => AssignTicketSchema.parse({})).toThrow();
    expect(() => AssignTicketSchema.parse({ provider_id: 'nope' })).toThrow();
    expect(() =>
      AssignTicketSchema.parse({ provider_id: UUID, organization_id: OTHER_UUID }),
    ).toThrow();
  });
});

describe('CompleteTicketSchema', () => {
  const valid = {
    resolution_summary: 'Replaced the compressor and tested the unit.',
    confirmed: true,
  };

  it('accepts a confirmed completion with evidence', () => {
    expect(
      CompleteTicketSchema.parse({ ...valid, evidence_document_ids: [UUID, OTHER_UUID] }),
    ).toBeTruthy();
  });

  it('requires an explicit confirmation', () => {
    expect(() =>
      CompleteTicketSchema.parse({ resolution_summary: valid.resolution_summary }),
    ).toThrow();
    expect(() => CompleteTicketSchema.parse({ ...valid, confirmed: false })).toThrow();
    expect(() => CompleteTicketSchema.parse({ ...valid, confirmed: 'yes' })).toThrow();
  });

  it('requires a substantive resolution summary', () => {
    expect(() => CompleteTicketSchema.parse({ ...valid, resolution_summary: 'done' })).toThrow();
  });

  it('bounds the evidence list', () => {
    expect(() =>
      CompleteTicketSchema.parse({ ...valid, evidence_document_ids: Array(11).fill(UUID) }),
    ).toThrow();
  });
});

describe('CreateActivitySchema', () => {
  it('accepts a controlled activity type with bounded metadata', () => {
    expect(
      CreateActivitySchema.parse({
        activity_type: 'status_changed',
        description: 'Moved from open to assigned.',
        metadata: { from: 'open', to: 'assigned' },
      }),
    ).toBeTruthy();
  });

  it('rejects a free-text activity type, because the timeline cannot be corrected later', () => {
    expect(() =>
      CreateActivitySchema.parse({ activity_type: 'whatever', description: 'x' }),
    ).toThrow();
  });

  it('rejects a caller-supplied actor — the author is the authenticated session', () => {
    expect(() =>
      CreateActivitySchema.parse({
        activity_type: 'comment_added',
        description: 'A note.',
        actor_profile_id: UUID,
      }),
    ).toThrow();
  });
});

describe('ListTicketsQuerySchema', () => {
  it('accepts the documented filters', () => {
    const parsed = ListTicketsQuerySchema.parse({
      status: 'open',
      priority: 'high',
      category: 'hvac',
      limit: '50',
    });
    expect(parsed.status).toBe('open');
    expect(parsed.limit).toBe(50);
  });

  it('rejects an invalid enum value', () => {
    expect(() => ListTicketsQuerySchema.parse({ status: 'nope' })).toThrow();
  });
});

describe('UploadUrlSchema', () => {
  const valid = {
    document_type: 'tenancy_contract',
    file_name: 'contract.pdf',
    content_type: 'application/pdf',
    size_bytes: 1024,
  };

  it('accepts a PDF within the size cap', () => {
    expect(UploadUrlSchema.parse(valid)).toBeTruthy();
    expect(UploadUrlSchema.parse({ ...valid, size_bytes: MAX_UPLOAD_BYTES })).toBeTruthy();
  });

  it('rejects any content type other than application/pdf', () => {
    expect(() => UploadUrlSchema.parse({ ...valid, content_type: 'image/png' })).toThrow();
    expect(() =>
      UploadUrlSchema.parse({ ...valid, content_type: 'application/octet-stream' }),
    ).toThrow();
  });

  it('rejects a file above the 10 MB cap and a zero-byte file', () => {
    expect(() => UploadUrlSchema.parse({ ...valid, size_bytes: MAX_UPLOAD_BYTES + 1 })).toThrow();
    expect(() => UploadUrlSchema.parse({ ...valid, size_bytes: 0 })).toThrow();
  });

  it('rejects a path traversal or a non-PDF name', () => {
    expect(() => UploadUrlSchema.parse({ ...valid, file_name: '../../etc/passwd.pdf' })).toThrow();
    expect(() => UploadUrlSchema.parse({ ...valid, file_name: 'a/b.pdf' })).toThrow();
    expect(() => UploadUrlSchema.parse({ ...valid, file_name: 'contract.exe' })).toThrow();
  });

  it('accepts a ticket association for provider evidence', () => {
    expect(
      UploadUrlSchema.parse({
        ...valid,
        document_type: 'maintenance_evidence',
        ticket_id: UUID,
      }),
    ).toBeTruthy();
  });

  it('rejects a client-supplied storage_path or organization_id', () => {
    expect(() => UploadUrlSchema.parse({ ...valid, storage_path: 'x/y.pdf' })).toThrow();
    expect(() => UploadUrlSchema.parse({ ...valid, organization_id: UUID })).toThrow();
  });
});

describe('VerifyDocumentSchema', () => {
  const fields = {
    tenant_name: 'Aisha Khan',
    contract_number: 'EJ-2026-001',
    property_address: 'Marina Residence, Dubai',
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    rent_amount: '120000',
    currency: 'AED',
  };

  it('accepts a confirmed verification with the full reviewed field set', () => {
    const parsed = VerifyDocumentSchema.parse({
      verification_status: 'verified',
      fields,
      confirmed: true,
    });
    expect(parsed.verification_status).toBe('verified');
  });

  it('accepts explicit nulls, so "verified" means reviewed rather than skipped', () => {
    expect(
      VerifyDocumentSchema.parse({
        verification_status: 'verified',
        fields: {
          tenant_name: null,
          contract_number: null,
          property_address: null,
          start_date: null,
          end_date: null,
          rent_amount: null,
          currency: null,
        },
        confirmed: true,
      }),
    ).toBeTruthy();
  });

  it('rejects a verification with a missing field, rather than defaulting it', () => {
    const { currency: _omitted, ...incomplete } = fields;
    expect(() =>
      VerifyDocumentSchema.parse({
        verification_status: 'verified',
        fields: incomplete,
        confirmed: true,
      }),
    ).toThrow();
  });

  it('requires an explicit confirmation on both outcomes', () => {
    expect(() => VerifyDocumentSchema.parse({ verification_status: 'verified', fields })).toThrow();
    expect(() =>
      VerifyDocumentSchema.parse({
        verification_status: 'rejected',
        reason: 'Illegible scan.',
      }),
    ).toThrow();
  });

  it('accepts a rejection with a reason and no fields', () => {
    expect(
      VerifyDocumentSchema.parse({
        verification_status: 'rejected',
        reason: 'Illegible scan.',
        confirmed: true,
      }),
    ).toBeTruthy();
    expect(() =>
      VerifyDocumentSchema.parse({
        verification_status: 'rejected',
        reason: 'Illegible scan.',
        fields,
        confirmed: true,
      }),
    ).toThrow();
  });

  it('rejects pending as a verification outcome — pending is the starting state', () => {
    expect(() =>
      VerifyDocumentSchema.parse({ verification_status: 'pending', confirmed: true }),
    ).toThrow();
  });
});

describe('ClassifyRequestSchema', () => {
  it('accepts a message alone', () => {
    expect(ClassifyRequestSchema.parse({ message: 'The AC is not cooling.' })).toEqual({
      message: 'The AC is not cooling.',
    });
  });

  it('rejects an empty message and an over-long one', () => {
    expect(() => ClassifyRequestSchema.parse({ message: '' })).toThrow();
    expect(() => ClassifyRequestSchema.parse({ message: 'x'.repeat(4001) })).toThrow();
  });

  it('rejects a client-supplied tenant or organization', () => {
    expect(() => ClassifyRequestSchema.parse({ message: 'hello', tenant_id: UUID })).toThrow();
    expect(() =>
      ClassifyRequestSchema.parse({ message: 'hello', organization_id: UUID }),
    ).toThrow();
  });
});

describe('ClassificationSchema — model output validation', () => {
  const valid = {
    category: 'hvac',
    summary: 'Air conditioning is running but not cooling.',
    reported_symptoms: ['AC running', 'room not cooling'],
    suggested_priority: 'normal',
    missing_information: [],
    requires_clarification: false,
    clarification_question: null,
  };

  it('accepts the documented example exactly', () => {
    expect(ClassificationSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a clarification request with a question', () => {
    expect(
      ClassificationSchema.parse({
        ...valid,
        requires_clarification: true,
        clarification_question: 'Which unit is this about?',
      }),
    ).toBeTruthy();
  });

  it('rejects a clarification flag with no question', () => {
    expect(() => ClassificationSchema.parse({ ...valid, requires_clarification: true })).toThrow();
    expect(() =>
      ClassificationSchema.parse({
        ...valid,
        requires_clarification: true,
        clarification_question: null,
      }),
    ).toThrow();
  });

  it('rejects a question with no clarification flag, so the two cannot disagree', () => {
    expect(() =>
      ClassificationSchema.parse({ ...valid, clarification_question: 'Which unit?' }),
    ).toThrow();
  });

  it('rejects a category outside the controlled list', () => {
    expect(() => ClassificationSchema.parse({ ...valid, category: 'haunting' })).toThrow();
  });

  it('rejects a priority outside the four', () => {
    expect(() =>
      ClassificationSchema.parse({ ...valid, suggested_priority: 'critical' }),
    ).toThrow();
  });

  it('rejects an extra key — an off-contract model response must not be silently stripped', () => {
    expect(() => ClassificationSchema.parse({ ...valid, ticket_created: true })).toThrow();
    expect(() => ClassificationSchema.parse({ ...valid, assigned_provider_id: UUID })).toThrow();
  });

  it('rejects a missing field rather than defaulting it', () => {
    const { summary: _omitted, ...incomplete } = valid;
    expect(() => ClassificationSchema.parse(incomplete)).toThrow();
  });

  it('bounds a runaway generation', () => {
    expect(() => ClassificationSchema.parse({ ...valid, summary: 'x'.repeat(501) })).toThrow();
    expect(() =>
      ClassificationSchema.parse({ ...valid, reported_symptoms: Array(21).fill('x') }),
    ).toThrow();
  });
});

describe('ConfirmTicketSchema — the human commit', () => {
  const classification = {
    category: 'hvac',
    summary: 'Air conditioning is running but not cooling.',
    reported_symptoms: ['AC running'],
    suggested_priority: 'normal',
    missing_information: [],
    requires_clarification: false,
    clarification_question: null,
  };
  const valid = {
    property_unit_id: UUID,
    title: 'Air conditioning not cooling',
    description: 'The AC is running but not cooling the room.',
    classification,
    confirmed: true,
  };

  it('accepts a confirmed draft', () => {
    expect(ConfirmTicketSchema.parse(valid)).toBeTruthy();
  });

  it('refuses to create anything without an explicit confirmation', () => {
    const { confirmed: _omitted, ...unconfirmed } = valid;
    expect(() => ConfirmTicketSchema.parse(unconfirmed)).toThrow();
    expect(() => ConfirmTicketSchema.parse({ ...valid, confirmed: false })).toThrow();
  });

  it('re-validates the draft it is handed', () => {
    expect(() =>
      ConfirmTicketSchema.parse({
        ...valid,
        classification: { ...classification, category: 'haunting' },
      }),
    ).toThrow();
  });

  it('rejects a caller-supplied priority or status — policy and the state machine decide those', () => {
    expect(() => ConfirmTicketSchema.parse({ ...valid, priority: 'urgent' })).toThrow();
    expect(() => ConfirmTicketSchema.parse({ ...valid, status: 'completed' })).toThrow();
  });

  it('rejects a caller-supplied tenant or organization', () => {
    expect(() => ConfirmTicketSchema.parse({ ...valid, tenant_id: UUID })).toThrow();
    expect(() => ConfirmTicketSchema.parse({ ...valid, organization_id: UUID })).toThrow();
  });
});

describe('DocumentExtractionSchema', () => {
  const allNull = {
    tenant_name: null,
    contract_number: null,
    property_address: null,
    start_date: null,
    end_date: null,
    rent_amount: null,
    currency: null,
    confidence_notes: [],
    requires_human_review: true,
  };

  it('accepts the documented all-null example', () => {
    expect(DocumentExtractionSchema.parse(allNull)).toEqual(allNull);
  });

  it('accepts populated fields and normalizes the money', () => {
    const parsed = DocumentExtractionSchema.parse({
      ...allNull,
      tenant_name: 'Aisha Khan',
      start_date: '2026-01-01',
      rent_amount: '120000',
      currency: 'aed',
    });
    expect(parsed.rent_amount).toBe('120000.00');
    expect(parsed.currency).toBe('AED');
  });

  it('rejects a non-ISO date, per the extraction contract', () => {
    expect(() =>
      DocumentExtractionSchema.parse({ ...allNull, start_date: '01/01/2026' }),
    ).toThrow();
  });

  it('rejects an extra key and a missing field', () => {
    expect(() =>
      DocumentExtractionSchema.parse({ ...allNull, verification_status: 'verified' }),
    ).toThrow();
    const { requires_human_review: _omitted, ...incomplete } = allNull;
    expect(() => DocumentExtractionSchema.parse(incomplete)).toThrow();
  });
});
