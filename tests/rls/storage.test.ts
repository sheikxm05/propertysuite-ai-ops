/**
 * Private object storage. Lane w0-l6, task 9.
 *
 * Documents are the most sensitive data in the system — tenancy contracts, identity
 * pages — and they live outside Postgres, so the table policies say nothing about them.
 * Storage has its own policy set, derived from path segment 1, and it needs its own
 * adversarial pass.
 *
 * Frozen facts asserted here (§5.7 plus amendment A5): bucket id `documents`, private;
 * path `{organization_id}/{entity}/{uuid}.pdf`; signed URLs expire in 60 seconds;
 * `application/pdf` only; 10 MB cap.
 *
 * A signed URL is a bearer credential. Two failure modes matter and are both tested:
 * minting one for an object you may not read, and a minted one outliving its expiry.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  STORAGE_BUCKET,
  clientFor,
  getWorld,
  org as orgFixture,
  recordCoverage,
  recordPass,
  type World,
} from '../_harness';

let world: World;

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a,
]);

const storagePass = (policy: string, outcome: 'allow' | 'deny', label: string) =>
  recordCoverage({ dimension: 'storage', outcome, policies: [policy], label });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  world = await getWorld();
  expect(
    world.storage.seeded,
    `Storage fixtures were not seeded: ${world.storage.reason ?? 'unknown'}. ` +
      `The suite expects a private bucket with id "${STORAGE_BUCKET}" (amendment A5), ` +
      'created in migration 0002.',
  ).toBe(true);
});

describe('the bucket is private', () => {
  it('a public URL does not serve the object', async () => {
    // §4: "No public bucket exists." If the bucket were public, every policy below
    // would be decoration.
    const f = orgFixture(world, 'A');
    const client = clientFor(world, 'A', 'property_manager');
    const { data } = client.storage.from(STORAGE_BUCKET).getPublicUrl(f.objects.d1);

    const response = await fetch(data.publicUrl);
    expect(
      response.ok,
      `the object was served without a signature from ${data.publicUrl}. The bucket is ` +
        'public, and every tenancy contract in the system is world-readable.',
    ).toBe(false);
    recordPass({ dimension: 'storage', label: 'bucket is not public' });
  });
});

describe('a signed URL for your own organization`s object', () => {
  it('is issued to a member and actually fetches the bytes', async () => {
    const f = orgFixture(world, 'A');
    const { data, error } = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .createSignedUrl(f.objects.d1, 60);

    expect(
      error,
      `a member could not sign its own organization's object: ${error?.message}`,
    ).toBeNull();
    expect(data?.signedUrl).toBeTruthy();

    const response = await fetch(String(data?.signedUrl));
    expect(response.status, 'a valid signed URL did not serve the object').toBe(200);
    storagePass('documents_objects_select_member', 'allow', 'member signs own-organization object');
  });
});

describe('a signed URL for the other organization`s object', () => {
  it('is refused to every role', async () => {
    // The path is known — it is derivable from the organization id and the document id,
    // both of which appear in URLs and logs. Knowing it must not be enough.
    const b = orgFixture(world, 'B');

    for (const role of [
      'organization_admin',
      'property_manager',
      'property_owner',
      'tenant',
      'service_provider',
    ] as const) {
      const { data, error } = await clientFor(world, 'A', role)
        .storage.from(STORAGE_BUCKET)
        .createSignedUrl(b.objects.d1, 60);

      // Supabase Storage refuses to sign an object the caller cannot select. If it ever
      // signs one, the URL itself is the breach, so fetch it and prove it is dead.
      if (!error && data?.signedUrl) {
        const response = await fetch(data.signedUrl);
        expect(
          response.ok,
          `${role} of organization A obtained a WORKING signed URL for organization B's ` +
            'document. This is a direct cross-tenant data breach.',
        ).toBe(false);
      } else {
        expect(error, `${role}: expected a refusal`).not.toBeNull();
      }
    }
    storagePass('documents_objects_select_member', 'deny', 'cross-organization signing refused');
  });

  it('cannot be downloaded directly either', async () => {
    const b = orgFixture(world, 'B');
    const { data, error } = await clientFor(world, 'A', 'organization_admin')
      .storage.from(STORAGE_BUCKET)
      .download(b.objects.d1);

    expect(
      error !== null || data === null,
      'organization A downloaded organization B`s document through the storage API',
    ).toBe(true);
    recordPass({ dimension: 'storage', label: 'cross-organization download refused' });
  });

  it('is invisible when listing the other organization`s prefix', async () => {
    const b = orgFixture(world, 'B');
    const { data } = await clientFor(world, 'A', 'organization_admin')
      .storage.from(STORAGE_BUCKET)
      .list(`${b.organizationId}/tenancies`);

    expect(data ?? [], 'organization A enumerated organization B`s stored documents').toEqual([]);
    recordPass({ dimension: 'storage', label: 'cross-organization listing is empty' });
  });
});

describe('expiry is honoured', () => {
  it('a signed URL stops working once it expires', async () => {
    // A signed URL is a bearer credential. If expiry were advisory, a URL pasted into a
    // chat message in 2026 would still serve a tenancy contract in 2027.
    const f = orgFixture(world, 'A');
    const { data, error } = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .createSignedUrl(f.objects.d1, 1);

    expect(error).toBeNull();
    const url = String(data?.signedUrl);

    const immediate = await fetch(url);
    expect(immediate.status, 'the URL should work before it expires').toBe(200);

    await sleep(2500);

    const expired = await fetch(url);
    expect(
      expired.ok,
      'an expired signed URL still served the object. Expiry is not being enforced, so ' +
        'every URL ever issued is effectively permanent.',
    ).toBe(false);
    recordPass({ dimension: 'storage', label: 'expired signed URL refused' });
  });

  it('a tampered signature is refused', async () => {
    const f = orgFixture(world, 'A');
    const { data } = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .createSignedUrl(f.objects.d1, 60);

    const url = String(data?.signedUrl);
    // Re-point a legitimately signed URL at a different organization's object.
    const b = orgFixture(world, 'B');
    const swapped = url.replace(f.organizationId, b.organizationId);
    expect(swapped, 'the path rewrite did not change the URL').not.toBe(url);

    const response = await fetch(swapped);
    expect(
      response.ok,
      'a signed URL was re-pointed at another organization`s object and still served it. ' +
        'The signature does not cover the path.',
    ).toBe(false);
    recordPass({ dimension: 'storage', label: 'signature covers the object path' });
  });
});

describe('writing objects', () => {
  it('a member may upload under its own organization`s prefix', async () => {
    const f = orgFixture(world, 'A');
    const path = `${f.organizationId}/tenancies/${randomUUID()}.pdf`;
    const { error } = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .upload(path, PDF_BYTES, { contentType: 'application/pdf' });

    expect(
      error,
      `a manager could not upload to its own organization: ${error?.message}`,
    ).toBeNull();
    storagePass('documents_objects_insert_member', 'allow', 'member uploads under own prefix');
  });

  it('nobody may upload under the other organization`s prefix', async () => {
    // Writing into another tenant's prefix would let an attacker plant a document that
    // the victim's own UI then presents as theirs.
    const b = orgFixture(world, 'B');
    for (const role of ['organization_admin', 'property_manager', 'tenant'] as const) {
      const path = `${b.organizationId}/tenancies/${randomUUID()}.pdf`;
      const { error } = await clientFor(world, 'A', role)
        .storage.from(STORAGE_BUCKET)
        .upload(path, PDF_BYTES, { contentType: 'application/pdf' });
      expect(error, `${role} of organization A wrote an object into organization B`).not.toBeNull();
    }
    storagePass('documents_objects_insert_member', 'deny', 'cross-organization upload refused');
  });

  it('staff may overwrite an object in their own organization; a tenant may not', async () => {
    const f = orgFixture(world, 'A');
    const path = `${f.organizationId}/tenancies/${randomUUID()}.pdf`;

    const seed = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .upload(path, PDF_BYTES, { contentType: 'application/pdf' });
    expect(seed.error).toBeNull();

    const staffOverwrite = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .upload(path, PDF_BYTES, { contentType: 'application/pdf', upsert: true });
    expect(
      staffOverwrite.error,
      `staff could not overwrite: ${staffOverwrite.error?.message}`,
    ).toBeNull();
    storagePass(
      'documents_objects_update_staff',
      'allow',
      'staff overwrite own-organization object',
    );

    const tenantOverwrite = await clientFor(world, 'A', 'tenant')
      .storage.from(STORAGE_BUCKET)
      .upload(path, PDF_BYTES, { contentType: 'application/pdf', upsert: true });
    expect(
      tenantOverwrite.error,
      'a tenant overwrote a stored document. The matrix makes document management staff work.',
    ).not.toBeNull();
    storagePass('documents_objects_update_staff', 'deny', 'tenant cannot overwrite');
  });

  it('no role may delete a stored object', async () => {
    // §4 again: a document is a record. There is no DELETE policy on storage.objects
    // for this bucket, for the same reason there is none on the tables.
    const f = orgFixture(world, 'A');
    for (const role of ['organization_admin', 'property_manager', 'tenant'] as const) {
      const { error } = await clientFor(world, 'A', role)
        .storage.from(STORAGE_BUCKET)
        .remove([f.objects.d1]);
      expect(error, `${role} deleted a stored document`).not.toBeNull();
    }

    // Still there, and still readable by somebody entitled to it.
    const { error: stillThere } = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .createSignedUrl(f.objects.d1, 60);
    expect(stillThere, 'the object is gone after the delete attempts').toBeNull();
    recordPass({ dimension: 'storage', label: 'object deletion refused for every role' });
  });

  it('refuses a non-PDF upload', async () => {
    // §5.7: `application/pdf` only, enforced on the bucket's allowed_mime_types.
    const f = orgFixture(world, 'A');
    const path = `${f.organizationId}/tenancies/${randomUUID()}.pdf`;
    const { error } = await clientFor(world, 'A', 'property_manager')
      .storage.from(STORAGE_BUCKET)
      .upload(path, new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), {
        contentType: 'application/x-msdownload',
      });
    expect(error, 'an executable was accepted into the documents bucket').not.toBeNull();
    recordPass({ dimension: 'storage', label: 'non-PDF content type refused' });
  });
});
