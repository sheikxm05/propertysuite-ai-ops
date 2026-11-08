/**
 * Private object storage, frozen in `docs/parallel-execution-plan.md` §5.7:
 * storage path `{organization_id}/{entity}/{uuid}.pdf`; signed URL TTL 60 s;
 * upload cap 10 MB; `application/pdf` only.
 *
 * There is no public bucket. Storage policies derive the organization from the
 * first path segment, which is why `buildStoragePath` never accepts a
 * caller-supplied prefix: the organization id must come from the resolved
 * membership, not from the request.
 */
export const STORAGE_BUCKET = 'documents';

/** Seconds. Short-lived by design — a leaked URL expires before it is useful. */
export const SIGNED_URL_TTL_SECONDS = 60;

/** 10 MB. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ALLOWED_UPLOAD_MIME_TYPES = ['application/pdf'] as const;
export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

export const ALLOWED_UPLOAD_EXTENSIONS = ['.pdf'] as const;

/** The `{entity}` segment of the storage path. */
export const STORAGE_ENTITIES = ['documents', 'maintenance'] as const;
export type StorageEntity = (typeof STORAGE_ENTITIES)[number];

/**
 * Build the one legal object path shape: `{organization_id}/{entity}/{uuid}.pdf`.
 *
 * `organizationId` and `objectId` must already be validated UUIDs — pass values
 * from a parsed schema or from `resolveMembership()`, never raw request input.
 * No caller-supplied filename reaches the path, so there is nothing to
 * traverse with: the stored name is always a server-generated UUID.
 */
export function buildStoragePath(
  organizationId: string,
  entity: StorageEntity,
  objectId: string,
): string {
  return `${organizationId}/${entity}/${objectId}.pdf`;
}

/**
 * Does `path` belong to `organizationId`?
 *
 * A defence-in-depth check for code that receives a stored path and is about to
 * sign it. Storage RLS is the floor; this is the gate.
 */
export function isStoragePathForOrganization(path: string, organizationId: string): boolean {
  if (organizationId.length === 0 || path.includes('..')) return false;
  return path.startsWith(`${organizationId}/`);
}
