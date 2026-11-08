/**
 * Redaction by allowlist.
 *
 * CLAUDE.md rule 8 says never log document text, message bodies, tokens or personal
 * data. A denylist cannot deliver that: the next lane adds a field, nobody updates the
 * list, and a tenant's phone number is in the log. So this module inverts the default.
 * **A field is dropped unless its name appears on `LOGGABLE_FIELDS` below.** Sensitive
 * data is unloggable by construction; the failure mode of forgetting to update the list
 * is a missing diagnostic, not a leak.
 *
 * What is on the list: correlation ids, resource ids, enum-valued state, counters and
 * timings. All of it either opaque (a UUID) or schema-level (a status name).
 *
 * What is deliberately *not* on the list, and must stay off it:
 *   `email`, `phone`, `full_name`, `name`, `address_line`, `title`, `description`,
 *   `content`, `message`, `body`, `text`, `token`, `access_token`, `refresh_token`,
 *   `authorization`, `cookie`, `password`, `api_key`, `key`, `secret`,
 *   `extracted_data`, `storage_path`, `metadata`, `payload`, `signed_url`.
 *
 * `scrubText` is the second line of defence, for the free-text log *message* itself,
 * which no allowlist can police.
 */

/**
 * Field names permitted in structured log output. Alphabetical, so that adding one is
 * a visible, reviewable diff.
 */
export const LOGGABLE_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'allowed',
  'attempt',
  'bucket',
  'cache',
  'category',
  'code',
  'conversation_id',
  'count',
  'cursor',
  'document_id',
  'duration_ms',
  'entity_id',
  'entity_type',
  'env',
  'error_code',
  'event',
  'from_status',
  'job_id',
  'latency_ms',
  'limit',
  'member_id',
  'method',
  'model',
  'operation',
  'organization_id',
  'outcome',
  'pg_code',
  'priority',
  'profile_id',
  'property_id',
  'provider',
  'provider_id',
  'rate_limit_key',
  'reason',
  'remaining',
  'request_id',
  'resource_type',
  'retry_after_s',
  'retry_count',
  'role',
  'route',
  'runtime',
  'status',
  'status_code',
  'tenancy_id',
  'tenant_id',
  'ticket_id',
  'to_status',
  'tokens_in',
  'tokens_out',
  'unit_id',
  'verification_status',
  'version',
]);

/** Deepest nesting level walked before a value is replaced by a marker. */
const MAX_DEPTH = 4;

/** Longest string retained for an allowlisted field. Guards against a pasted blob. */
const MAX_STRING_LENGTH = 512;

/** Longest array retained for an allowlisted field. */
const MAX_ARRAY_LENGTH = 20;

/** The result of redacting a field bag: what survived, and how much did not. */
export interface RedactionResult {
  fields: Record<string, unknown>;
  /** Number of keys dropped, at any depth. Names are not reported — a key can itself
   *  be data (an object keyed by email address), so only the count is safe. */
  redacted: number;
}

/**
 * Filters a bag of structured log fields down to the allowlist.
 *
 * Nested objects are walked and filtered at every level, so `{ ticket: { title } }`
 * loses `title` even though `ticket` is not itself allowlisted — an unknown key is
 * dropped whole rather than walked, which is the safer default.
 */
export function redactFields(input: unknown): RedactionResult {
  let redacted = 0;

  const walk = (value: unknown, depth: number): Record<string, unknown> => {
    if (depth > MAX_DEPTH || !isPlainObject(value)) return {};
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (!LOGGABLE_FIELDS.has(key)) {
        redacted += 1;
        continue;
      }
      const clean = sanitiseValue(raw, depth, walk);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  };

  return { fields: walk(input, 0), redacted };
}

/**
 * Redacts a structured payload destined for an `audit_logs.metadata` column.
 *
 * The same allowlist is applied. An audit row is a security artefact that an
 * organization administrator can read, and a route that put a tenancy's rent figure or
 * a document's extracted text into audit metadata would turn the audit trail into a
 * second copy of the data it is meant to describe.
 */
export function redactMetadata(input: unknown): Record<string, unknown> {
  return redactFields(input).fields;
}

/**
 * Scrubs patterns that must never appear in a log line, whatever the field name.
 *
 * Applied to the free-text `message` argument of every logger call, because a developer
 * can interpolate anything into a template string and the allowlist cannot see inside
 * one. Not a substitute for the allowlist — a backstop for the one input it cannot
 * cover.
 */
export function scrubText(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, '[redacted-jwt]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\b(?:sb|sbp|service_role)_[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\b(?:\+971|00971|0)5\d[\s-]?\d{3}[\s-]?\d{4}\b/g, '[redacted-phone]');
}

/* ----------------------------------------------------------------- helpers -- */

function sanitiseValue(
  raw: unknown,
  depth: number,
  walk: (value: unknown, depth: number) => Record<string, unknown>,
): unknown {
  if (raw === null) return null;
  switch (typeof raw) {
    case 'string':
      return truncate(scrubText(raw));
    case 'number':
      return Number.isFinite(raw) ? raw : String(raw);
    case 'boolean':
      return raw;
    case 'bigint':
      return raw.toString();
    case 'undefined':
      return undefined;
    case 'function':
    case 'symbol':
      return undefined;
    default:
      break;
  }
  if (Array.isArray(raw)) {
    return raw
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) =>
        isPlainObject(item) ? walk(item, depth + 1) : sanitiseValue(item, depth, walk),
      );
  }
  if (raw instanceof Date) return raw.toISOString();
  if (isPlainObject(raw)) return walk(raw, depth + 1);
  return undefined;
}

function truncate(value: string): string {
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}
