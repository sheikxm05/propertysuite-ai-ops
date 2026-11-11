/**
 * Private object storage. Lane w0-l6, task 9.
 *
 * Documents are the most sensitive data in the system — tenancy contracts, identity
 * pages — and they live outside Postgres, so the table policies say nothing about them.
 * `storage.objects` has its own policy set, derived from path segment 1, and it needs
 * its own adversarial pass.
 *
 * Frozen facts asserted here (§5.7 plus amendment A5): bucket id `documents`, private;
 * path `{organization_id}/{entity}/{uuid}.pdf`; signed URLs expire in 60 seconds;
 * `application/pdf` only.
 *
 * The file is split by driver, and the split is a real limitation rather than a
 * convenience:
 *
 *   policy-level   `storage.objects` is an ordinary table with ordinary RLS. The pg
 *                  driver asserts the policies directly. PostgREST does not expose the
 *                  `storage` schema, so the supabase driver cannot.
 *   protocol-level A signed URL is minted and validated by the Storage HTTP service,
 *                  not by Postgres. Only the supabase driver can exercise expiry and
 *                  signature coverage; no amount of SQL will test them.
 *
 * Cases outside the active driver's reach call `ctx.skip()`, so the report shows them as
 * skipped. They are never quietly green: a storage assertion that silently passes is
 * indistinguishable from one that proves the bucket is wide open.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  STORAGE_BUCKET,
  clientFor,
  getWorld,
  org as orgFixture,
  recordCoverage,
  recordPass,
  type Principal,
  type World,
} from '../_harness';

let world: World;

const OBJECTS = 'storage.objects';

const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46, 0x0a,
]);

const storagePass = (policy: string, outcome: 'allow' | 'deny', label: string) =>
  recordCoverage({ dimension: 'storage', outcome, policies: [policy], label });

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The supabase driver exposes the Storage HTTP client on its principals. The cast is
 * confined to this one line: `Principal` is a SQL-shaped interface on purpose, and
 * storage is the one thing that is not reachable through SQL on both transports.
 */
const httpStorage = (principal: Principal): SupabaseClient['storage'] =>
  (principal as unknown as { storage(): SupabaseClient['storage'] }).storage();

beforeAll(async () => {
  world = await getWorld();
  expect(
    world.storage.seeded,
    `Storage fixtures were not seeded: ${world.storage.reason ?? 'unknown'}. ` +
      `The suite expects a private bucket with id "${STORAGE_BUCKET}" (amendment A5), ` +
      'created in migration 0002.',
  ).toBe(true);
});

/* ------------------------------------------------- policy level (pg driver) -- */

describe('storage.objects policies', () => {
  const pgOnly = (ctx: { skip: () => void }) => {
    if (world.driver.name !== 'pg') {
      ctx.skip();
      return true;
    }
    return false;
  };

  it('a member reads an object under its own organization`s prefix', async (ctx) => {
    if (pgOnly(ctx)) return;
    const f = orgFixture(world, 'A');
    const { data, error } = await clientFor(world, 'A', 'property_manager').select(OBJECTS, {
      columns: 'name',
      eq: { bucket_id: STORAGE_BUCKET, name: f.objects.d1 },
    });
    expect(error, `a member could not read its own object: ${error?.message}`).toBeNull();
    expect((data ?? []).length, 'the seeded object was invisible to its own organization').toBe(1);
    storagePass('documents_objects_select_member', 'allow', 'member reads own-prefix object');
  });

  it('no role reads an object under the other organization`s prefix', async (ctx) => {
    if (pgOnly(ctx)) return;
    const b = orgFixture(world, 'B');
    for (const role of [
      'organization_admin',
      'property_manager',
      'property_owner',
      'tenant',
      'service_provider',
    ] as const) {
      const { data } = await clientFor(world, 'A', role).select(OBJECTS, {
        columns: 'name',
        eq: { bucket_id: STORAGE_BUCKET, name: b.objects.d1 },
      });
      expect(
        data ?? [],
        `${role} of organization A can see organization B's stored document. The path is ` +
          'derivable from ids that appear in URLs and logs, so visibility is the breach.',
      ).toEqual([]);
    }
    storagePass('documents_objects_select_member', 'deny', 'cross-organization object hidden');
  });

  it('a member may create an object under its own prefix', async (ctx) => {
    if (pgOnly(ctx)) return;
    const f = orgFixture(world, 'A');
    const { error } = await clientFor(world, 'A', 'property_manager').insert(
      OBJECTS,
      {
        bucket_id: STORAGE_BUCKET,
        name: `${f.organizationId}/tenancies/${randomUUID()}.pdf`,
        metadata: { mimetype: 'application/pdf' },
      },
      'name',
    );
    expect(error, `a manager could not create an object: ${error?.message}`).toBeNull();
    storagePass('documents_objects_insert_member', 'allow', 'member writes own-prefix object');
  });

  it('nobody may create an object under the other organization`s prefix', async (ctx) => {
    if (pgOnly(ctx)) return;
    const b = orgFixture(world, 'B');
    for (const role of ['organization_admin', 'property_manager', 'tenant'] as const) {
      const { error } = await clientFor(world, 'A', role).insert(
        OBJECTS,
        {
          bucket_id: STORAGE_BUCKET,
          name: `${b.organizationId}/tenancies/${randomUUID()}.pdf`,
          metadata: { mimetype: 'application/pdf' },
        },
        'name',
      );
      expect(
        error,
        `${role} of organization A planted an object in organization B's prefix, where ` +
          "B's own UI would then present it as theirs",
      ).not.toBeNull();
    }
    storagePass('documents_objects_insert_member', 'deny', 'cross-organization write refused');
  });

  it('an object cannot be parked at the bucket root, where no organization is derivable', async (ctx) => {
    if (pgOnly(ctx)) return;
    const { error } = await clientFor(world, 'A', 'property_manager').insert(
      OBJECTS,
      { bucket_id: STORAGE_BUCKET, name: `${randomUUID()}.pdf`, metadata: {} },
      'name',
    );
    expect(error, 'an object was accepted at the bucket root').not.toBeNull();
    recordPass({ dimension: 'storage', label: 'bucket-root object refused' });
  });

  it('overwriting is staff-only', async (ctx) => {
    if (pgOnly(ctx)) return;
    const f = orgFixture(world, 'A');

    const staff = await clientFor(world, 'A', 'property_manager').update(
      OBJECTS,
      { metadata: { mimetype: 'application/pdf', revision: 2 } },
      { bucket_id: STORAGE_BUCKET, name: f.objects.d1 },
      'name',
    );
    expect(staff.error, `staff could not overwrite: ${staff.error?.message}`).toBeNull();
    expect((staff.data ?? []).length, 'the staff overwrite affected no rows').toBe(1);
    storagePass('documents_objects_update_staff', 'allow', 'staff overwrite own-organization');

    const tenant = await clientFor(world, 'A', 'tenant').update(
      OBJECTS,
      { metadata: { mimetype: 'application/pdf', revision: 3 } },
      { bucket_id: STORAGE_BUCKET, name: f.objects.d1 },
      'name',
    );
    expect(
      tenant.error !== null || (tenant.data ?? []).length === 0,
      'a tenant replaced a stored contract after the fact',
    ).toBe(true);
    storagePass('documents_objects_update_staff', 'deny', 'tenant cannot overwrite');
  });

  it('no role may delete a stored object', async (ctx) => {
    if (pgOnly(ctx)) return;
    // §4 again: a document is a record. There is no DELETE policy on storage.objects
    // for this bucket, for the same reason there is none on the tables.
    const f = orgFixture(world, 'A');
    for (const role of ['organization_admin', 'property_manager', 'tenant'] as const) {
      const { data, error } = await clientFor(world, 'A', role).remove(
        OBJECTS,
        { bucket_id: STORAGE_BUCKET, name: f.objects.d1 },
        'name',
      );
      expect(error !== null || (data ?? []).length === 0, `${role} deleted a stored document`).toBe(
        true,
      );
    }

    const { data: still } = await clientFor(world, 'A', 'property_manager').select(OBJECTS, {
      columns: 'name',
      eq: { bucket_id: STORAGE_BUCKET, name: f.objects.d1 },
    });
    expect((still ?? []).length, 'the object is gone after the delete attempts').toBe(1);
    recordPass({ dimension: 'storage', label: 'object deletion refused for every role' });
  });

  it('an unauthenticated caller sees no object at all', async (ctx) => {
    if (pgOnly(ctx)) return;
    const { data } = await world.anon.select(OBJECTS, {
      columns: 'name',
      eq: { bucket_id: STORAGE_BUCKET },
      limit: 5,
    });
    expect(data ?? [], 'stored documents are readable without authentication').toEqual([]);
    recordPass({ dimension: 'storage', label: 'anonymous object read denied' });
  });
});

/* ------------------------------------------ protocol level (supabase driver) -- */

describe('signed URLs', () => {
  const httpOnly = (ctx: { skip: () => void }) => {
    if (!world.driver.supportsHttpStorage) {
      ctx.skip();
      return true;
    }
    return false;
  };

  const bucketFor = (principal: Principal) => httpStorage(principal);

  it('the bucket is not public', async (ctx) => {
    if (httpOnly(ctx)) return;
    // §4: "No public bucket exists." If it were public, every policy above would be
    // decoration.
    const f = orgFixture(world, 'A');
    const { data } = bucketFor(clientFor(world, 'A', 'property_manager'))
      .from(STORAGE_BUCKET)
      .getPublicUrl(f.objects.d1);

    const response = await fetch(data.publicUrl);
    expect(
      response.ok,
      `the object was served without a signature from ${data.publicUrl}: every tenancy ` +
        'contract in the system is world-readable',
    ).toBe(false);
    recordPass({ dimension: 'storage', label: 'bucket is not public' });
  });

  it('a member can sign its own organization`s object and fetch it', async (ctx) => {
    if (httpOnly(ctx)) return;
    const f = orgFixture(world, 'A');
    const { data, error } = await bucketFor(clientFor(world, 'A', 'property_manager'))
      .from(STORAGE_BUCKET)
      .createSignedUrl(f.objects.d1, 60);

    expect(error, `a member could not sign its own object: ${error?.message}`).toBeNull();
    const response = await fetch(String(data?.signedUrl));
    expect(response.status, 'a valid signed URL did not serve the object').toBe(200);
    storagePass('documents_objects_select_member', 'allow', 'signed URL for own object');
  });

  it('no role can obtain a working signed URL for the other organization`s object', async (ctx) => {
    if (httpOnly(ctx)) return;
    const b = orgFixture(world, 'B');
    for (const role of [
      'organization_admin',
      'property_manager',
      'property_owner',
      'tenant',
      'service_provider',
    ] as const) {
      const { data, error } = await bucketFor(clientFor(world, 'A', role))
        .from(STORAGE_BUCKET)
        .createSignedUrl(b.objects.d1, 60);

      // Storage refuses to sign an object the caller cannot select. If it ever signs
      // one, the URL itself is the breach — so fetch it and prove it is dead.
      if (!error && data?.signedUrl) {
        const response = await fetch(data.signedUrl);
        expect(
          response.ok,
          `${role} of organization A obtained a WORKING signed URL for organization B's ` +
            'document: a direct cross-tenant data breach',
        ).toBe(false);
      } else {
        expect(error, `${role}: expected a refusal`).not.toBeNull();
      }
    }
    storagePass('documents_objects_select_member', 'deny', 'cross-organization signing refused');
  });

  it('an expired signed URL stops working', async (ctx) => {
    if (httpOnly(ctx)) return;
    // A signed URL is a bearer credential. If expiry were advisory, a URL pasted into a
    // chat message in 2026 would still serve a tenancy contract in 2027.
    const f = orgFixture(world, 'A');
    const { data, error } = await bucketFor(clientFor(world, 'A', 'property_manager'))
      .from(STORAGE_BUCKET)
      .createSignedUrl(f.objects.d1, 1);

    expect(error).toBeNull();
    const url = String(data?.signedUrl);

    expect((await fetch(url)).status, 'the URL should work before it expires').toBe(200);
    await sleep(2500);
    expect(
      (await fetch(url)).ok,
      'an expired signed URL still served the object, so every URL ever issued is ' +
        'effectively permanent',
    ).toBe(false);
    recordPass({ dimension: 'storage', label: 'expired signed URL refused' });
  });

  it('a signature does not survive a path rewrite', async (ctx) => {
    if (httpOnly(ctx)) return;
    const f = orgFixture(world, 'A');
    const b = orgFixture(world, 'B');
    const { data } = await bucketFor(clientFor(world, 'A', 'property_manager'))
      .from(STORAGE_BUCKET)
      .createSignedUrl(f.objects.d1, 60);

    const url = String(data?.signedUrl);
    const swapped = url.replace(f.organizationId, b.organizationId);
    expect(swapped, 'the path rewrite did not change the URL').not.toBe(url);

    expect(
      (await fetch(swapped)).ok,
      'a signed URL was re-pointed at another organization`s object and still served ' +
        'it: the signature does not cover the path',
    ).toBe(false);
    recordPass({ dimension: 'storage', label: 'signature covers the object path' });
  });

  it('refuses a non-PDF upload', async (ctx) => {
    if (httpOnly(ctx)) return;
    // §5.7: `application/pdf` only, enforced by the bucket's allowed_mime_types.
    const f = orgFixture(world, 'A');
    const { error } = await bucketFor(clientFor(world, 'A', 'property_manager'))
      .from(STORAGE_BUCKET)
      .upload(`${f.organizationId}/tenancies/${randomUUID()}.pdf`, new Uint8Array([0x4d, 0x5a]), {
        contentType: 'application/x-msdownload',
      });
    expect(error, 'an executable was accepted into the documents bucket').not.toBeNull();
    recordPass({ dimension: 'storage', label: 'non-PDF content type refused' });
  });

  it('a member may upload under its own prefix', async (ctx) => {
    if (httpOnly(ctx)) return;
    const f = orgFixture(world, 'A');
    const { error } = await bucketFor(clientFor(world, 'A', 'property_manager'))
      .from(STORAGE_BUCKET)
      .upload(`${f.organizationId}/tenancies/${randomUUID()}.pdf`, PDF_BYTES, {
        contentType: 'application/pdf',
      });
    expect(error, `a manager could not upload: ${error?.message}`).toBeNull();
    storagePass('documents_objects_insert_member', 'allow', 'HTTP upload under own prefix');
  });

  it('nobody may upload under the other organization`s prefix', async (ctx) => {
    if (httpOnly(ctx)) return;
    const b = orgFixture(world, 'B');
    for (const role of ['organization_admin', 'property_manager', 'tenant'] as const) {
      const { error } = await bucketFor(clientFor(world, 'A', role))
        .from(STORAGE_BUCKET)
        .upload(`${b.organizationId}/tenancies/${randomUUID()}.pdf`, PDF_BYTES, {
          contentType: 'application/pdf',
        });
      expect(error, `${role} of organization A wrote an object into organization B`).not.toBeNull();
    }
    storagePass(
      'documents_objects_insert_member',
      'deny',
      'HTTP cross-organization upload refused',
    );
  });
});
