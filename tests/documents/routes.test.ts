/**
 * The six `/api/v1/documents/*` handlers, driven as handlers.
 *
 * The suite covers three of the lane's exit-gate assertions and one acceptance
 * criterion:
 *
 *   * the organization is derived from the session and a request cannot influence it
 *   * a document from another organization is not readable (the server-side layer; the
 *     RLS layer is `tests/rls/**` — see `_support/route-harness.ts`)
 *   * a non-PDF with a faked `.pdf` extension is rejected, by magic bytes, with 422
 *   * nothing is verified without an explicit human confirmation
 *
 * Plus the signed-URL discipline: the download TTL is the frozen 60 seconds and an
 * expired or invalid token does not silently succeed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `server-only` resolves to a module that throws under anything but React's
 * `react-server` condition, which is exactly the build-time guard that makes importing
 * `withPrivilegedApiHandler` from a client component a compile failure. Vitest is
 * neither, so the guard fires here too. Stubbing it is a test-environment shim for a
 * Next.js build condition, not a weakening of the boundary: the ESLint path rule and the
 * service-role client's own runtime assertion are untouched, and
 * `tests/ai/no-privileged-action.test.ts` checks the import graph independently.
 */
vi.mock('server-only', () => ({}));

/* The five substitutions. Async factories, so they can reach the harness's state. */

vi.mock('@/lib/supabase/server', async () => {
  const { routeMockState } = await import('./_support/route-harness');
  return {
    createRouteHandlerClient: () => ({
      supabase: routeMockState.client,
      pendingCookies: [],
    }),
    createServerClient: async () => routeMockState.client,
  };
});

vi.mock('@/lib/auth/session', async () => {
  const { routeMockState } = await import('./_support/route-harness');
  const session = () => ({
    userId: routeMockState.sessionUserId,
    email: 'manager@example.com',
    lastSignInAt: null,
  });
  return {
    requireSessionFromClient: async () => session(),
    getSessionFromClient: async () => session(),
    requireSession: async () => session(),
    getSession: async () => session(),
  };
});

vi.mock('@/lib/auth/roles', async (importOriginal) => {
  const { routeMockState } = await import('./_support/route-harness');
  // `membershipLogFields` stays real: it is the function that decides which membership
  // fields are safe to log, and stubbing it would make the log assertions meaningless.
  const actual = await importOriginal<typeof import('@/lib/auth/roles')>();
  return {
    ...actual,
    requireMembership: async () => routeMockState.membership,
    resolveMembership: async () => routeMockState.membership,
  };
});

vi.mock('@/lib/audit/write', async () => {
  const { routeMockState } = await import('./_support/route-harness');
  return {
    writeAuditLog: async (_client: unknown, entry: never) => {
      routeMockState.audits.push(entry);
      return { written: true, auditId: 'audit-1', reason: null };
    },
  };
});

vi.mock('@/lib/supabase/server-only/service-role', async () => {
  const { routeMockState } = await import('./_support/route-harness');
  return {
    createServiceRoleClient: () => routeMockState.client,
    tryCreateServiceRoleClient: () =>
      routeMockState.serviceRoleAvailable ? routeMockState.client : null,
  };
});

import { MAX_UPLOAD_BYTES, SIGNED_URL_TTL_SECONDS, STORAGE_BUCKET } from '@shared/index';
import { resetRateLimits } from '@/lib/rate-limit';

import { GET as listDocuments } from '@/app/api/v1/documents/route';
import { POST as requestUploadUrl } from '@/app/api/v1/documents/upload-url/route';
import { GET as getDocument } from '@/app/api/v1/documents/[documentId]/route';
import { POST as requestDownloadUrl } from '@/app/api/v1/documents/[documentId]/download-url/route';
import { POST as processDocument } from '@/app/api/v1/documents/[documentId]/process/route';
import { POST as verifyDocument } from '@/app/api/v1/documents/[documentId]/verify/route';

import { FakeDatabase, createFakeClient, type FakeStorageOptions } from './_support/fake-supabase';
import {
  capturedAudits,
  dataOf,
  jsonRequest,
  readResponse,
  resetRouteMocks,
  routeParams,
  setCaller,
  setClient,
  setServiceRoleAvailable,
} from './_support/route-harness';
import {
  DOCUMENT_A,
  DOCUMENT_B,
  ORG_A,
  ORG_B,
  PROFILE_MANAGER_A,
  PROPERTY_A,
  PROVIDER_A,
  PROVIDER_A_OTHER,
  TENANCY_A,
  TICKET_A,
  adminA,
  documentRow,
  managerA,
  managerB,
  ownerA,
  pendingEnvelope,
  providerA,
  tenantA,
} from './_support/fixtures';
import { buildFakePdfBytes, buildTenancyContractPdf } from './_support/pdf-fixture';

const BASE = 'https://app.test/api/v1/documents';

const VERIFIED_FIELDS = {
  tenant_name: 'Aisha Rahman',
  contract_number: 'EJ-2026-004217',
  property_address: 'Unit 1204, Marina Heights, Dubai Marina, Dubai',
  start_date: '2026-02-01',
  end_date: '2027-01-31',
  rent_amount: '120000.00',
  currency: 'AED',
} as const;

interface WorldOptions {
  documents?: Record<string, unknown>[];
  properties?: Record<string, unknown>[];
  tenancies?: Record<string, unknown>[];
  tickets?: Record<string, unknown>[];
  jobs?: Record<string, unknown>[];
  storage?: FakeStorageOptions;
}

function world(options: WorldOptions = {}) {
  const db = new FakeDatabase({
    documents: {
      rows: options.documents ?? [],
      // Mirrors the column defaults in `0001`: a document is `pending` unless the
      // insert says otherwise, and nothing in this lane's insert says otherwise.
      defaults: () => ({
        verification_status: 'pending',
        created_at: '2026-03-01T08:00:00.000Z',
        extracted_data: null,
        extracted_text: null,
        property_id: null,
        tenancy_id: null,
        ticket_id: null,
      }),
    },
    properties: {
      rows: options.properties ?? [
        { id: PROPERTY_A, organization_id: ORG_A, owner_member_id: 'member-owner-1' },
      ],
    },
    tenancies: {
      rows: options.tenancies ?? [
        {
          id: TENANCY_A,
          organization_id: ORG_A,
          tenant_id: 'ccccccc1-1111-4111-8111-ccccccccccc1',
        },
      ],
    },
    maintenance_tickets: {
      rows: options.tickets ?? [
        { id: TICKET_A, organization_id: ORG_A, assigned_provider_id: PROVIDER_A },
      ],
    },
    jobs: { rows: options.jobs ?? [], unique: ['idempotency_key'] },
  });

  const client = createFakeClient(db, { storage: options.storage ?? {} });
  setClient(client);
  return { db, client };
}

/**
 * The real logger from `lib/observability` runs throughout this suite — it is the
 * module that applies the redaction allowlist, and substituting it would make any claim
 * about what is logged vacuous. Its transport is `process.stdout`, so the writes are
 * captured rather than silenced: the suite stays readable *and* every line becomes
 * assertable. See the final test in this file.
 */
let logOutput: string[] = [];
let restoreStdout: (() => void) | null = null;

beforeEach(() => {
  resetRouteMocks();
  // The limiter is process-global and keyed on the profile id, so without this a later
  // test in the file inherits an earlier test's spend.
  resetRateLimits();

  logOutput = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    if (text.includes('"request_id"')) {
      logOutput.push(text);
      return true;
    }
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  restoreStdout = () => {
    process.stdout.write = original;
  };
});

afterEach(() => {
  resetRouteMocks();
  restoreStdout?.();
  restoreStdout = null;
});

/* ====================================================== POST /upload-url == */

describe('POST /upload-url', () => {
  const BODY = {
    document_type: 'tenancy_contract' as const,
    file_name: 'tenancy-contract.pdf',
    content_type: 'application/pdf' as const,
    size_bytes: 524_288,
  };

  it('issues a URL on the frozen path and derives the organization from the session', async () => {
    const { db } = world();
    setCaller(managerA());

    const parsed = await readResponse(
      await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, BODY)),
    );

    expect(parsed.status).toBe(201);
    const data = dataOf<{ document_id: string; storage_path: string; expires_in_seconds: number }>(
      parsed,
    );

    // `{organization_id}/{entity}/{uuid}.pdf`, with the organization from the membership.
    expect(data.storage_path).toBe(`${ORG_A}/documents/${data.document_id}.pdf`);
    expect(data.expires_in_seconds).toBe(SIGNED_URL_TTL_SECONDS);
    // The stored object name is the row id, so the two cannot drift apart.
    expect(db.rows('documents')[0]?.id).toBe(data.document_id);
    expect(db.rows('documents')[0]?.organization_id).toBe(ORG_A);
    // The RLS INSERT policy requires exactly this.
    expect(db.rows('documents')[0]?.uploaded_by).toBe(PROFILE_MANAGER_A);
    // Column default, never named by the insert.
    expect(db.rows('documents')[0]?.verification_status).toBe('pending');
  });

  it('IGNORES A CLIENT-SUPPLIED organization_id — the schema rejects the body outright', async () => {
    world();
    setCaller(managerA());

    const parsed = await readResponse(
      await requestUploadUrl(
        jsonRequest(`${BASE}/upload-url`, { ...BODY, organization_id: ORG_B }),
      ),
    );

    // `.strict()` on `UploadUrlSchema`: a mass-assignment attempt is a 400 that shows up
    // in the logs, not a field that is silently ignored.
    expect(parsed.status).toBe(400);
    expect(parsed.errorCode).toBe('VALIDATION_ERROR');
  });

  it('puts no part of the caller-supplied file name into the path', async () => {
    const { db } = world();
    setCaller(managerA());

    const parsed = await readResponse(
      await requestUploadUrl(
        jsonRequest(`${BASE}/upload-url`, { ...BODY, file_name: 'marina-contract-2026.pdf' }),
      ),
    );

    const data = dataOf<{ storage_path: string }>(parsed);
    expect(parsed.status).toBe(201);
    expect(data.storage_path).not.toContain('marina');
    expect(db.rows('documents')[0]?.storage_path).not.toContain('marina');
  });

  it.each([
    ['a non-PDF content type', { content_type: 'application/zip' }],
    ['a traversing file name', { file_name: '../../etc/passwd.pdf' }],
    ['a double extension', { file_name: 'invoice.pdf.exe' }],
    ['an oversized declared file', { size_bytes: MAX_UPLOAD_BYTES + 1 }],
  ])('rejects %s', async (_label, override) => {
    world();
    setCaller(managerA());

    const parsed = await readResponse(
      await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, { ...BODY, ...override })),
    );

    expect(parsed.status).toBe(400);
    expect(parsed.errorCode).toBe('VALIDATION_ERROR');
  });

  it('refuses a tenant and an owner — neither has an INSERT policy on documents', async () => {
    for (const membership of [tenantA(), ownerA()]) {
      world();
      setCaller(membership);
      resetRateLimits();

      const parsed = await readResponse(
        await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, BODY)),
      );
      expect(parsed.status).toBe(403);
      expect(parsed.errorCode).toBe('FORBIDDEN');
    }
  });

  it('files an association only after checking the caller can see it', async () => {
    const { db } = world();
    setCaller(managerA());

    const parsed = await readResponse(
      await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, { ...BODY, tenancy_id: TENANCY_A })),
    );

    expect(parsed.status).toBe(201);
    expect(db.rows('documents')[0]?.tenancy_id).toBe(TENANCY_A);
  });

  it('answers 404 for an association the caller cannot see', async () => {
    // Another organization's tenancy. The composite foreign key would reject it as a
    // 422; 404 is the right answer, because it is the same answer an id that does not
    // exist gets, and so reveals nothing.
    world({ tenancies: [] });
    setCaller(managerA());

    const parsed = await readResponse(
      await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, { ...BODY, tenancy_id: TENANCY_A })),
    );

    expect(parsed.status).toBe(404);
    expect(parsed.errorCode).toBe('NOT_FOUND');
  });

  it('writes an audit row carrying ids and no file name', async () => {
    world();
    setCaller(managerA());

    await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, BODY));

    const audit = capturedAudits()[0];
    expect(audit?.action).toBe('document_upload_authorized');
    expect(audit?.entityType).toBe('document');
    expect(audit?.organizationId).toBe(ORG_A);
    expect(JSON.stringify(audit?.metadata)).not.toContain('tenancy-contract.pdf');
  });

  describe('a service provider filing ticket evidence (amendment A7)', () => {
    const EVIDENCE = {
      document_type: 'maintenance_evidence' as const,
      file_name: 'completion-photo.pdf',
      content_type: 'application/pdf' as const,
      size_bytes: 102_400,
      ticket_id: TICKET_A,
    };

    it('is allowed on a ticket assigned to them, under the maintenance prefix', async () => {
      const { db } = world();
      setCaller(providerA());

      const parsed = await readResponse(
        await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, EVIDENCE)),
      );

      expect(parsed.status).toBe(201);
      const data = dataOf<{ document_id: string; storage_path: string }>(parsed);
      expect(data.storage_path).toBe(`${ORG_A}/maintenance/${data.document_id}.pdf`);
      // The A7 INSERT policy forces both to null; the route pins them so the insert
      // cannot carry them even if the gate is later loosened.
      expect(db.rows('documents')[0]?.property_id).toBeNull();
      expect(db.rows('documents')[0]?.tenancy_id).toBeNull();
      expect(db.rows('documents')[0]?.ticket_id).toBe(TICKET_A);
    });

    it('is refused on a ticket assigned to someone else', async () => {
      world({
        tickets: [{ id: TICKET_A, organization_id: ORG_A, assigned_provider_id: PROVIDER_A_OTHER }],
      });
      setCaller(providerA());

      const parsed = await readResponse(
        await requestUploadUrl(jsonRequest(`${BASE}/upload-url`, EVIDENCE)),
      );

      expect(parsed.status).toBe(403);
    });

    it('CANNOT STAPLE EVIDENCE ONTO A TENANCY', async () => {
      // The attack A7's `property_id is null and tenancy_id is null` clause exists to
      // stop: a provider attaching a row to a tenancy, which would then be visible to
      // that tenancy's tenant.
      world();
      setCaller(providerA());

      const parsed = await readResponse(
        await requestUploadUrl(
          jsonRequest(`${BASE}/upload-url`, { ...EVIDENCE, tenancy_id: TENANCY_A }),
        ),
      );

      expect(parsed.status).toBe(403);
    });

    it('cannot file a document with no ticket at all', async () => {
      world();
      setCaller(providerA());

      const parsed = await readResponse(
        await requestUploadUrl(
          jsonRequest(`${BASE}/upload-url`, {
            document_type: 'tenancy_contract',
            file_name: 'contract.pdf',
            content_type: 'application/pdf',
            size_bytes: 1_024,
          }),
        ),
      );

      expect(parsed.status).toBe(403);
    });

    it('cannot file evidence as a tenancy contract', async () => {
      world();
      setCaller(providerA());

      const parsed = await readResponse(
        await requestUploadUrl(
          jsonRequest(`${BASE}/upload-url`, { ...EVIDENCE, document_type: 'tenancy_contract' }),
        ),
      );

      expect(parsed.status).toBe(403);
    });
  });
});

/* =========================================================== GET /:id ===== */

describe('GET /{documentId}', () => {
  it('returns the document with its proposal marked unverified', async () => {
    world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(managerA());

    const parsed = await readResponse(
      await getDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}`, undefined, 'GET'),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(200);
    const data = dataOf<{
      is_verified: boolean;
      proposed_fields: Record<string, unknown> | null;
      verification_status: string;
    }>(parsed);

    expect(data.verification_status).toBe('pending');
    expect(data.is_verified).toBe(false);
    expect(data.proposed_fields).toMatchObject({ tenant_name: 'Aisha Rahman' });
  });

  it('NEVER RETURNS extracted_text', async () => {
    world({
      documents: [
        {
          ...documentRow({ extractedData: pendingEnvelope() }),
          extracted_text: 'THE WHOLE CONTRACT BODY',
        },
      ],
    });
    setCaller(managerA());

    const parsed = await readResponse(
      await getDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}`, undefined, 'GET'),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    // Not merely absent from the object: absent from the serialised body, so no nesting
    // or future column addition can smuggle it out.
    expect(JSON.stringify(parsed.body)).not.toContain('THE WHOLE CONTRACT BODY');
    expect(Object.keys(dataOf(parsed))).not.toContain('extracted_text');
  });

  it('A DOCUMENT FROM ANOTHER ORGANIZATION IS NOT READABLE', async () => {
    // The fake hands over a row belonging to organization B — which is what an RLS
    // failure would look like. The server-side layer must refuse it on its own.
    world({ documents: [documentRow({ id: DOCUMENT_B, organizationId: ORG_B })] });
    setCaller(managerA());

    const parsed = await readResponse(
      await getDocument(
        jsonRequest(`${BASE}/${DOCUMENT_B}`, undefined, 'GET'),
        routeParams({ documentId: DOCUMENT_B }),
      ),
    );

    // 500 is correct and deliberate: no legitimate request can reach this, so it is a
    // defect in our code — or in a policy — rather than a denial to explain to a client.
    // Critically, the body carries no document data either way.
    expect(parsed.status).toBe(500);
    expect(parsed.errorCode).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(parsed.body)).not.toContain(ORG_B);
  });

  it("is a 404 for organization B's manager asking about organization A's document", async () => {
    // The ordinary path: RLS returns nothing, so the route cannot tell an absent id from
    // an inaccessible one — and says so with the same status for both.
    world({ documents: [] });
    setCaller(managerB());

    const parsed = await readResponse(
      await getDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}`, undefined, 'GET'),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(404);
    expect(parsed.errorCode).toBe('NOT_FOUND');
  });

  it('refuses a provider a tenancy contract even when the row is handed over', async () => {
    // `documents_select_provider_assigned` requires `ticket_id is not null`. This row
    // has none, which is what structurally keeps providers out of tenancy contracts.
    world({ documents: [documentRow({ tenancyId: TENANCY_A })] });
    setCaller(providerA());

    const parsed = await readResponse(
      await getDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}`, undefined, 'GET'),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(404);
  });

  it('lets a provider read their own ticket evidence', async () => {
    world({
      documents: [documentRow({ ticketId: TICKET_A, documentType: 'maintenance_evidence' })],
    });
    setCaller(providerA());

    const parsed = await readResponse(
      await getDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}`, undefined, 'GET'),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(200);
  });

  it('rejects a malformed document id before touching the database', async () => {
    world();
    setCaller(managerA());

    const parsed = await readResponse(
      await getDocument(
        jsonRequest(`${BASE}/not-a-uuid`, undefined, 'GET'),
        routeParams({ documentId: 'not-a-uuid' }),
      ),
    );

    expect(parsed.status).toBe(400);
    expect(parsed.errorCode).toBe('VALIDATION_ERROR');
  });
});

/* ============================================================ GET / ======= */

describe('GET /', () => {
  it('returns the A18 list envelope', async () => {
    world({ documents: [documentRow(), documentRow({ id: DOCUMENT_B })] });
    setCaller(managerA());

    const parsed = await readResponse(await listDocuments(jsonRequest(BASE, undefined, 'GET')));

    expect(parsed.status).toBe(200);
    // Amendment A18: the `packages/shared` shape wins. `has_more` carries information
    // `next_cursor` alone cannot — on an RLS-filtered list a short page is normal.
    expect(Object.keys(parsed.body).sort()).toEqual(['data', 'page_info']);
    expect(parsed.body.page_info).toEqual({ next_cursor: null, has_more: false, limit: 25 });
  });

  it('paginates with an opaque cursor and reports has_more', async () => {
    const rows = Array.from({ length: 4 }, (_unused, index) =>
      documentRow({
        id: `1212121${index}-1111-4111-8111-121212121212`,
        createdAt: `2026-03-0${index + 1}T08:00:00.000Z`,
      }),
    );
    world({ documents: rows });
    setCaller(managerA());

    const first = await readResponse(
      await listDocuments(jsonRequest(`${BASE}?limit=2`, undefined, 'GET')),
    );
    const page = first.body.page_info as { next_cursor: string; has_more: boolean };

    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBeTruthy();

    const second = await readResponse(
      await listDocuments(
        jsonRequest(
          `${BASE}?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`,
          undefined,
          'GET',
        ),
      ),
    );

    const firstIds = (first.body.data as { id: string }[]).map((row) => row.id);
    const secondIds = (second.body.data as { id: string }[]).map((row) => row.id);
    // Disjoint pages: no row repeated, none skipped.
    expect(firstIds.filter((id) => secondIds.includes(id))).toHaveLength(0);
  });

  it('refuses a limit above the frozen maximum rather than clamping it', async () => {
    world();
    setCaller(managerA());

    const parsed = await readResponse(
      await listDocuments(jsonRequest(`${BASE}?limit=5000`, undefined, 'GET')),
    );

    expect(parsed.status).toBe(400);
    expect(parsed.errorCode).toBe('VALIDATION_ERROR');
  });

  it('ignores a forged cursor instead of failing', async () => {
    world({ documents: [documentRow()] });
    setCaller(managerA());

    const parsed = await readResponse(
      await listDocuments(jsonRequest(`${BASE}?cursor=not-a-real-cursor`, undefined, 'GET')),
    );

    // A cursor carries no authorization, so a forged one can only reorder the caller's
    // own page. Decoding is total: it yields the first page rather than a 500.
    expect(parsed.status).toBe(200);
    expect((parsed.body.data as unknown[]).length).toBe(1);
  });
});

/* ================================================== POST /:id/download-url = */

describe('POST /{documentId}/download-url', () => {
  it('signs for exactly the frozen 60 seconds', async () => {
    const document = documentRow();
    const { client } = world({
      documents: [document],
      storage: { objects: { [document.storage_path as string]: buildTenancyContractPdf() } },
    });
    setCaller(managerA());

    const parsed = await readResponse(
      await requestDownloadUrl(
        jsonRequest(`${BASE}/${DOCUMENT_A}/download-url`),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(200);
    expect(dataOf<{ expires_in_seconds: number }>(parsed).expires_in_seconds).toBe(
      SIGNED_URL_TTL_SECONDS,
    );
    // The TTL is an argument to `createSignedUrl`, so this is the real token lifetime
    // rather than a number in a response body.
    expect(client.signedUrlRequests).toEqual([
      { path: document.storage_path, expiresIn: SIGNED_URL_TTL_SECONDS },
    ]);
  });

  it('never audits or returns the signed URL as a loggable value', async () => {
    const document = documentRow();
    world({ documents: [document] });
    setCaller(managerA());

    await requestDownloadUrl(
      jsonRequest(`${BASE}/${DOCUMENT_A}/download-url`),
      routeParams({ documentId: DOCUMENT_A }),
    );

    const audit = capturedAudits()[0];
    expect(audit?.action).toBe('document_download_url_issued');
    // A signed URL is a bearer credential. `signed_url` is deliberately absent from the
    // logger's allowlist, and the audit metadata must not carry one either.
    expect(JSON.stringify(audit?.metadata)).not.toContain('token');
    expect(JSON.stringify(audit?.metadata)).not.toContain('storage.test');
  });

  it('refuses to sign a path outside the caller organization', async () => {
    // A corrupted `storage_path`: the row passes RLS and the matrix while pointing into
    // another tenant's prefix. Only a path check catches it.
    world({
      documents: [documentRow({ storagePath: `${ORG_B}/documents/${DOCUMENT_A}.pdf` })],
    });
    setCaller(managerA());

    const parsed = await readResponse(
      await requestDownloadUrl(
        jsonRequest(`${BASE}/${DOCUMENT_A}/download-url`),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(500);
    expect(parsed.errorCode).toBe('INTERNAL_ERROR');
  });

  it('is a 404 for a document the caller cannot see', async () => {
    world({ documents: [] });
    setCaller(managerB());

    const parsed = await readResponse(
      await requestDownloadUrl(
        jsonRequest(`${BASE}/${DOCUMENT_A}/download-url`),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(404);
  });
});

/* ===================================================== POST /:id/process == */

describe('POST /{documentId}/process', () => {
  function processWorld(bytes: Uint8Array | null) {
    const document = documentRow();
    const objects = bytes ? { [document.storage_path as string]: bytes } : {};
    const { db, client } = world({ documents: [document], storage: { objects } });

    // The route probes the header with a ranged GET over a signed URL, so `fetch` is the
    // boundary to stand in for. The stub answers exactly as Storage would: 206 with the
    // first kibibyte, or 404 when the object is absent.
    const stub = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      // `split` is wrong here and was: the bucket is called `documents` and so is the
      // `{entity}` segment, so `.../sign/documents/<org>/documents/<uuid>.pdf` splits
      // into three parts and the object path is not the second one. Slice from the
      // FIRST bucket marker instead.
      const marker = `/${STORAGE_BUCKET}/`;
      const start = url.indexOf(marker);
      const path =
        start < 0 ? '' : decodeURIComponent(url.slice(start + marker.length).split('?')[0] ?? '');

      const object = objects[path];
      if (!object) return new Response(null, { status: 404 });
      return new Response(object.slice(0, 1024) as unknown as BodyInit, { status: 206 });
    });
    vi.stubGlobal('fetch', stub);

    return { db, client, document, stub };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('enqueues extraction and returns 202', async () => {
    const { db } = processWorld(buildTenancyContractPdf());
    setCaller(managerA());

    const parsed = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(202);
    const data = dataOf<{ document_id: string; job_id: string; status: string }>(parsed);
    expect(data.document_id).toBe(DOCUMENT_A);
    expect(data.status).toBe('queued');
    expect(db.rows('jobs')).toHaveLength(1);
    expect(db.rows('jobs')[0]?.idempotency_key).toBe(`document_extraction:${DOCUMENT_A}`);
    // The payload carries the organization for the worker to CROSS-CHECK, never to scope.
    expect((db.rows('jobs')[0]?.payload as Record<string, unknown>).organization_id).toBe(ORG_A);
    // Still pending. Enqueuing extraction is not a step towards verification.
    expect(db.rows('documents')[0]?.verification_status).toBe('pending');
  });

  it('A NON-PDF WITH A FAKED .pdf EXTENSION IS REJECTED BY THE MAGIC-BYTE CHECK', async () => {
    // Declared `application/pdf`, named `.pdf`, and a ZIP archive. The upload URL route
    // could not tell — there were no bytes yet. This is the first moment it can.
    const { db } = processWorld(buildFakePdfBytes());
    setCaller(managerA());

    const parsed = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(422);
    expect(parsed.errorCode).toBe('UNPROCESSABLE');
    // The message names the rule, not the sniffed format: anything more would make this
    // route a free file-type oracle.
    expect((parsed.body.error as { message: string }).message).toBe(
      'The uploaded file is not a PDF.',
    );
    // No job row at all: rejected before the queue.
    expect(db.rows('jobs')).toHaveLength(0);
  });

  it('A DUPLICATE REQUEST RETURNS THE SAME JOB AND QUEUES NOTHING NEW', async () => {
    const { db } = processWorld(buildTenancyContractPdf());
    setCaller(managerA());

    const first = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );
    const second = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(second.status).toBe(202);
    expect(dataOf<{ job_id: string }>(second).job_id).toBe(
      dataOf<{ job_id: string }>(first).job_id,
    );
    expect(db.rows('jobs')).toHaveLength(1);
    // The audit row records that the second request was deduplicated rather than lost.
    expect(capturedAudits().map((audit) => audit.metadata?.outcome)).toEqual([
      'enqueued',
      'already_enqueued',
    ]);
  });

  it('answers 422 when the object has not finished uploading', async () => {
    const { db } = processWorld(null);
    setCaller(managerA());

    const parsed = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(422);
    expect(db.rows('jobs')).toHaveLength(0);
  });

  it('AN EXPIRED OR INVALID SIGNED URL DOES NOT SILENTLY SUCCEED', async () => {
    processWorld(buildTenancyContractPdf());
    setCaller(managerA());

    // Storage answers a token that has expired, or one whose signature does not verify,
    // with a 4xx. The probe must treat that as "cannot read the object" rather than as
    // a pass — otherwise an expired URL would wave an unvalidated file through.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'jwt expired' }), { status: 400 })),
    );

    const parsed = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(422);
    expect(parsed.errorCode).toBe('UNPROCESSABLE');
  });

  it('refuses a document that has already been decided', async () => {
    const document = documentRow({ verificationStatus: 'verified' });
    world({
      documents: [document],
      storage: { objects: { [document.storage_path as string]: buildTenancyContractPdf() } },
    });
    setCaller(managerA());

    const parsed = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(409);
    expect(parsed.errorCode).toBe('CONFLICT');
  });

  it('is staff only — a provider cannot queue a write to a row they cannot update', async () => {
    processWorld(buildTenancyContractPdf());
    setCaller(providerA());

    const parsed = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(403);
  });

  it('says so rather than pretending, when the queue is unreachable', async () => {
    processWorld(buildTenancyContractPdf());
    setCaller(managerA());
    setServiceRoleAvailable(false);

    const parsed = await readResponse(
      await processDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/process`, {}),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    // `jobs` is service-role only by design. Accepting the work with no queue behind it
    // would be worse than a 500.
    expect(parsed.status).toBe(500);
  });
});

/* ====================================================== POST /:id/verify == */

describe('POST /{documentId}/verify', () => {
  it('records a verification against the reviewer and returns the decided document', async () => {
    const { db } = world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(managerA());

    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'verified',
          fields: VERIFIED_FIELDS,
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(200);
    expect(dataOf<{ is_verified: boolean }>(parsed).is_verified).toBe(true);

    const stored = db.rows('documents')[0];
    expect(stored?.verification_status).toBe('verified');
    const envelope = stored?.extracted_data as { verification: { verified_by: string } };
    expect(envelope.verification.verified_by).toBe(PROFILE_MANAGER_A);
    // Nothing outside `documents` was written. Not `tenancies`, in particular.
    expect(db.writtenTables()).toEqual(['documents']);
  });

  it('NOTHING IS VERIFIED WITHOUT AN EXPLICIT CONFIRMATION', async () => {
    for (const confirmed of [undefined, false, 'true', 1]) {
      const { db } = world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
      setCaller(managerA());
      resetRateLimits();

      const parsed = await readResponse(
        await verifyDocument(
          jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
            verification_status: 'verified',
            fields: VERIFIED_FIELDS,
            ...(confirmed === undefined ? {} : { confirmed }),
          }),
          routeParams({ documentId: DOCUMENT_A }),
        ),
      );

      // `ConfirmationSchema` is `z.literal(true)`, so absent, false and
      // truthy-but-not-true are all 400s rather than verifications.
      expect(parsed.status).toBe(400);
      expect(parsed.errorCode).toBe('VALIDATION_ERROR');
      expect(db.rows('documents')[0]?.verification_status).toBe('pending');
    }
  });

  it('requires a value for every field, so verified means reviewed rather than skipped', async () => {
    const { db } = world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(managerA());

    const { tenant_name: _omitted, ...incomplete } = VERIFIED_FIELDS;
    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'verified',
          fields: incomplete,
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(400);
    expect(db.rows('documents')[0]?.verification_status).toBe('pending');
  });

  it('accepts an explicit null — "the document does not state this"', async () => {
    const { db } = world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(managerA());

    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'verified',
          fields: { ...VERIFIED_FIELDS, contract_number: null },
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(200);
    const envelope = db.rows('documents')[0]?.extracted_data as {
      verification: { fields: Record<string, unknown> };
    };
    expect(envelope.verification.fields.contract_number).toBeNull();
  });

  it("stores the reviewer's correction rather than the model's proposal", async () => {
    const { db } = world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(adminA());

    await verifyDocument(
      jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
        verification_status: 'verified',
        fields: { ...VERIFIED_FIELDS, rent_amount: '118000.00' },
        note: 'Rent corrected against the signed addendum.',
        confirmed: true,
      }),
      routeParams({ documentId: DOCUMENT_A }),
    );

    const envelope = db.rows('documents')[0]?.extracted_data as {
      proposed: { rent_amount: string };
      verification: { fields: { rent_amount: string } };
    };
    expect(envelope.proposed.rent_amount).toBe('120000.00');
    expect(envelope.verification.fields.rent_amount).toBe('118000.00');
  });

  it('stores no field values on a rejection', async () => {
    const { db } = world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(managerA());

    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'rejected',
          reason: 'The scan is unreadable past page one.',
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(200);
    expect(db.rows('documents')[0]?.verification_status).toBe('rejected');
    const envelope = db.rows('documents')[0]?.extracted_data as {
      verification: { fields: unknown };
    };
    expect(envelope.verification.fields).toBeNull();
  });

  it('rejects a rejection that smuggles field values', async () => {
    world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(managerA());

    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'rejected',
          reason: 'Not this tenancy.',
          fields: VERIFIED_FIELDS,
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    // The discriminated union's `.strict()` branch: a rejection carries a reason and
    // nothing else.
    expect(parsed.status).toBe(400);
  });

  it('is a 409 on a second decision', async () => {
    world({
      documents: [
        documentRow({ verificationStatus: 'verified', extractedData: pendingEnvelope() }),
      ],
    });
    setCaller(managerA());

    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'rejected',
          reason: 'Changed my mind.',
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(409);
    expect(parsed.errorCode).toBe('CONFLICT');
  });

  it.each([
    ['a tenant', tenantA],
    ['a property owner', ownerA],
    ['a service provider', providerA],
  ])('refuses %s', async (_label, build) => {
    const { db } = world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(build());
    resetRateLimits();

    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'verified',
          fields: VERIFIED_FIELDS,
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(403);
    expect(db.rows('documents')[0]?.verification_status).toBe('pending');
  });

  it('CANNOT VERIFY ANOTHER ORGANIZATION’S DOCUMENT', async () => {
    world({
      documents: [documentRow({ organizationId: ORG_B, extractedData: pendingEnvelope() })],
    });
    setCaller(managerA());

    const parsed = await readResponse(
      await verifyDocument(
        jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
          verification_status: 'verified',
          fields: VERIFIED_FIELDS,
          confirmed: true,
        }),
        routeParams({ documentId: DOCUMENT_A }),
      ),
    );

    expect(parsed.status).toBe(500);
    expect(parsed.errorCode).toBe('INTERNAL_ERROR');
  });

  it('audits the decision without auditing the values', async () => {
    world({ documents: [documentRow({ extractedData: pendingEnvelope() })] });
    setCaller(managerA());

    await verifyDocument(
      jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
        verification_status: 'verified',
        fields: VERIFIED_FIELDS,
        confirmed: true,
      }),
      routeParams({ documentId: DOCUMENT_A }),
    );

    const audit = capturedAudits()[0];
    expect(audit?.action).toBe('document_verification_decided');
    expect(audit?.metadata?.verification_status).toBe('verified');
    expect(audit?.metadata?.profile_id).toBe(PROFILE_MANAGER_A);
    // An audit row is readable by an administrator and lives forever; the accepted
    // values are a tenant's personal data.
    const serialised = JSON.stringify(audit?.metadata);
    expect(serialised).not.toContain('Aisha Rahman');
    expect(serialised).not.toContain('Marina Heights');
    expect(serialised).not.toContain('120000');
  });
});

/* ======================================================= logging hygiene == */

describe('what the routes log', () => {
  it('logs ids, statuses and outcomes — and never document content', async () => {
    const document = documentRow({ extractedData: pendingEnvelope() });
    world({
      documents: [{ ...document, extracted_text: 'Tenant Name: Aisha Rahman, AED 120,000' }],
    });
    setCaller(managerA());

    await getDocument(
      jsonRequest(`${BASE}/${DOCUMENT_A}`, undefined, 'GET'),
      routeParams({ documentId: DOCUMENT_A }),
    );
    await verifyDocument(
      jsonRequest(`${BASE}/${DOCUMENT_A}/verify`, {
        verification_status: 'verified',
        fields: VERIFIED_FIELDS,
        note: 'Checked against the signed original.',
        confirmed: true,
      }),
      routeParams({ documentId: DOCUMENT_A }),
    );

    const logged = logOutput.join('\n');
    expect(logged.length).toBeGreaterThan(0);

    // The allowlist in `lib/observability/redaction.ts` keeps these.
    expect(logged).toContain('"document_id"');
    expect(logged).toContain('"verification_status":"verified"');
    expect(logged).toContain('"organization_id"');

    // And drops everything that is a person, a document or a credential. CLAUDE.md
    // rule 8, asserted against the real logger rather than against a stub of it.
    for (const forbidden of [
      'Aisha Rahman',
      'Marina Heights',
      'EJ-2026-004217',
      '120000',
      '120,000',
      'Checked against the signed original',
      document.storage_path as string,
    ]) {
      expect(logged).not.toContain(forbidden);
    }
  });
});
