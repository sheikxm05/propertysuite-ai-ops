/**
 * The read and write gates every document route calls, in one place.
 *
 * Each gate does the same three things in the same order: resolve the row's facts from
 * the database, apply the §4 matrix in application space, and — for a service provider
 * — apply amendment A7's predicate, which `lib/auth/authorize.ts` does not yet carry
 * (see the divergence note in `authorization.ts`).
 *
 * Why the gates live here and not inline in six route files: a route that resolves its
 * own facts is a route that can resolve them slightly differently, and the difference
 * will be in the one path nobody tested. There are exactly two document gates — may you
 * read this row, and may you change it — so there are exactly two functions.
 */

import { ApiRouteError } from '@/lib/api/errors';
import type { Membership } from '@/lib/auth/roles';
import type { AppSupabaseClient } from '@/lib/supabase/types';

import { assertDocumentAction } from './authorization';
import {
  assertSameOrganization,
  resolveDocumentFacts,
  type DocumentRecord,
} from './documents-service';

/**
 * May `membership` read this document?
 *
 * The provider branch mirrors `documents_select_provider_assigned` from migration 0002:
 * `ticket_id is not null` **and** the ticket is assigned to the caller. The first clause
 * is what structurally keeps a provider out of tenancy contracts and property documents
 * — those rows have a null `ticket_id` — and it is checked here as well as in the
 * policy, because this layer must deny on the assumption that the policy has a bug.
 */
export async function assertDocumentReadable(
  client: AppSupabaseClient,
  membership: Membership,
  document: DocumentRecord,
): Promise<void> {
  assertSameOrganization(document, membership);
  const facts = await resolveDocumentFacts(client, document);

  if (membership.role === 'service_provider') {
    if (!document.ticket_id) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'provider_document_without_ticket', document_id: document.id },
      });
    }
    if (!membership.providerId || facts.providerId !== membership.providerId) {
      throw new ApiRouteError('NOT_FOUND', {
        logFields: { reason: 'provider_document_not_assigned', document_id: document.id },
      });
    }
    return;
  }

  assertDocumentAction(membership, 'read', facts);
}

/**
 * May `membership` change this document?
 *
 * Staff only, and deliberately so: `documents_update_staff` is the only UPDATE policy
 * on the table, and a provider has none in any form (0002 is explicit about it). So
 * processing and verification are staff actions, and a provider who uploaded evidence
 * cannot later alter the row — which is what makes evidence evidence.
 */
export async function assertDocumentWritable(
  client: AppSupabaseClient,
  membership: Membership,
  document: DocumentRecord,
): Promise<void> {
  assertSameOrganization(document, membership);
  const facts = await resolveDocumentFacts(client, document);
  assertDocumentAction(membership, 'update', facts);
}
