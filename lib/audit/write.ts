/**
 * The audit writer. Acceptance criterion 10: every critical state change leaves a row.
 *
 * It calls `public.log_audit(...)` from migration `0003`, **as the caller**, never with
 * the service-role client. Three reasons, all of them deliberate decisions by W0-L2 and
 * W0-L3:
 *
 *  - `audit_logs` has INSERT, UPDATE and DELETE revoked from `authenticated` and a
 *    SELECT policy limited to `organization_admin`, so a direct insert with the caller's
 *    client cannot succeed. `log_audit` is `security definer`, so it can.
 *  - `log_audit` checks that the caller is an **active member** of the target
 *    organization before inserting. Running it as service-role would skip that check,
 *    and a forged audit trail is worse than a missing one.
 *  - `actor_profile_id` is filled by `current_profile_id()` inside the function. With
 *    service-role there is no `auth.uid()`, so every row would be attributed to nobody.
 *
 * The signature is
 * `log_audit(p_action text, p_entity_type text, p_entity_id uuid, p_metadata jsonb
 * default '{}', p_organization_id uuid default null)`. The organization is passed
 * explicitly rather than left to the `metadata.organization_id` fallback — the fallback
 * exists for callers that cannot know it, and this one always can.
 *
 * Metadata passes through the logger's redaction allowlist first. An audit row is
 * readable by an organization administrator and lives forever; a route that put a
 * document's extracted text or a tenant's phone number in it would turn the audit trail
 * into a second, less guarded copy of the data it is meant to describe (CLAUDE.md
 * rule 8).
 */

import { isPostgresErrorLike, postgresErrorToken } from '@/lib/api/errors';
import type { Logger } from '@/lib/observability/logger';
import { redactMetadata } from '@/lib/observability/redaction';
import type { Json } from '@/lib/shared';
import type { AppSupabaseClient } from '@/lib/supabase/types';

export interface AuditEntry {
  /** Verb, `snake_case`, past tense: `property_created`, `ticket_assigned`. */
  action: string;
  /** The table or domain concept the action applied to: `property`, `ticket`. */
  entityType: string;
  /** The affected row, when there is a single one. */
  entityId?: string | null;
  /** The organization the row belongs to. From trusted membership, never a request. */
  organizationId: string;
  /** Redacted before it is stored. Safe to pass a wider object than you intend to keep. */
  metadata?: Record<string, unknown>;
}

export interface AuditResult {
  written: boolean;
  /** `audit_logs.id`, when the row was written. */
  auditId: string | null;
  /** Stable reason when it was not. Logged, never returned to a client. */
  reason: string | null;
}

/**
 * Appends one audit row.
 *
 * Never throws. An audit failure after a successful mutation cannot be undone by
 * rejecting the response — the state change already happened, and returning 500 would
 * tell the client to retry a write that succeeded. So the failure is logged at `error`
 * level with the request's correlation id, which is what a Wave 2 alert can watch. The
 * return value lets a caller that *can* react, react.
 */
export async function writeAuditLog(
  client: AppSupabaseClient,
  entry: AuditEntry,
  logger: Logger,
): Promise<AuditResult> {
  if (!entry.organizationId) {
    logger.error('audit write skipped: no organization', {
      action: entry.action,
      entity_type: entry.entityType,
      reason: 'audit_organization_missing',
    });
    return { written: false, auditId: null, reason: 'audit_organization_missing' };
  }

  const metadata = redactMetadata(entry.metadata ?? {});

  const { data, error } = await client.rpc('log_audit', {
    p_action: entry.action,
    p_entity_type: entry.entityType,
    p_entity_id: entry.entityId ?? null,
    // `redactMetadata` reduces every value it keeps to a string, number, boolean,
    // null, array or plain object, so the result is `Json` by construction.
    p_metadata: metadata as Json,
    p_organization_id: entry.organizationId,
  });

  if (error) {
    const token = isPostgresErrorLike(error) ? postgresErrorToken(error.message) : null;
    logger.error('audit write failed', {
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      organization_id: entry.organizationId,
      pg_code: error.code ?? 'unknown',
      reason: token ?? 'audit_write_failed',
    });
    return { written: false, auditId: null, reason: token ?? 'audit_write_failed' };
  }

  const auditId = typeof data === 'string' ? data : null;
  logger.info('audit written', {
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId ?? null,
    organization_id: entry.organizationId,
    outcome: 'written',
  });

  return { written: true, auditId, reason: null };
}
