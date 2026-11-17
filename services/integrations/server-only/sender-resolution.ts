/**
 * Which tenant, in which organization, sent this message?
 *
 * This is the one place in the lane where getting it wrong is a tenancy breach rather
 * than a bug. An inbound WhatsApp number is an unauthenticated claim of identity: a
 * sender chooses their own number, Meta tells us what it is, and nothing about that
 * constitutes proof of who they are inside *our* data. Attaching such a message to an
 * organization publishes a stranger's words inside that company's inbox, and in the
 * other direction it is the first step towards replying into the wrong tenancy.
 *
 * So the rule is deliberately unforgiving:
 *
 *     exactly one tenant, in exactly one organization, or no organization at all.
 *
 * Zero matches and two matches are the **same outcome** — `unmatched`, `organization_id`
 * left null, visible in the inbox as unattributed. The two-match case is the one worth
 * dwelling on: two organizations can legitimately hold the same phone number (an agent
 * who is a tenant in one building and a landlord's contact in another; a shared office
 * line; a recycled SIM). Picking the first row, the newest row, or the row whose
 * organization has more activity would all be guesses, and a guess here crosses the
 * isolation boundary the entire project exists to defend. Refusing is not a limitation
 * of this implementation — it is the implementation.
 *
 * **Why a service-role client.** Resolution has to look across organizations to
 * discover that it must not choose between them, and there is no caller to scope the
 * read to: a webhook has no session. That is the legitimate background-job use of an
 * RLS-bypassing client named in `lib/api/server-only/privileged-handler.ts`, and it
 * moves the burden of scoping here. The burden is discharged by what this function
 * *returns*: at most one organization id, derived from a matched row, never from the
 * payload. The webhook's own body can no more steer this than it can forge a signature.
 *
 * **Why the match is exact.** `normalisePhone` canonicalises; `phoneMatchCandidates`
 * enumerates the written forms of that one canonical number; and every row the database
 * returns is re-canonicalised and compared again before it counts. There is no suffix
 * match, no "last nine digits", no `like`. See `whatsapp/phone.ts`.
 *
 * Nothing here logs a phone number, a name or a message body.
 */

import 'server-only';

import type { PrivilegedSupabaseClient } from '@/lib/supabase/types';

import { normalisePhone, phoneMatchCandidates } from '../whatsapp/phone';

/**
 * Why resolution did or did not produce an organization. All five are safe to log.
 *
 * A separate vocabulary from `inbound_messages.status`, deliberately. This is the
 * *verdict* and is written to the log's `reason` field; the row's status is one of the
 * six frozen in `whatsapp/constants.ts`. `'matched'` here becomes `'classified'` there —
 * the names differ because the things differ, and collapsing them would mean a change to
 * 0004's CHECK constraint silently rewrote this lane's diagnostics.
 */
export type SenderResolutionReason =
  | 'matched'
  | 'identifier_not_a_phone_number'
  | 'no_tenant_matched'
  | 'ambiguous_sender'
  | 'lookup_failed';

export type SenderResolution =
  | {
      readonly matched: true;
      readonly reason: 'matched';
      readonly tenantId: string;
      readonly organizationId: string;
    }
  | {
      readonly matched: false;
      readonly reason: Exclude<SenderResolutionReason, 'matched'>;
      /** How many rows the exact re-check accepted. `2` means ambiguous, not "pick one". */
      readonly candidateCount: number;
    };

/** Upper bound on rows read. A number matching more than this is ambiguous regardless. */
const CANDIDATE_LIMIT = 10;

/**
 * Resolves a sender identifier to at most one tenant.
 *
 * A failed lookup is reported as a distinct reason rather than folded into
 * `no_tenant_matched`: the caller retries a database failure and does not retry a
 * genuine non-match, and conflating them would either retry forever on an unknown
 * number or silently drop messages during an outage.
 */
export async function resolveSender(
  client: PrivilegedSupabaseClient,
  fromIdentifier: string,
): Promise<SenderResolution> {
  const canonical = normalisePhone(fromIdentifier);
  if (!canonical) {
    return { matched: false, reason: 'identifier_not_a_phone_number', candidateCount: 0 };
  }

  const { data, error } = await client
    .from('tenants')
    // Exactly three columns. `full_name` and `email` are not selected: this function
    // decides attribution, and reading personal data it does not need would put it in
    // a stack frame — and one careless log line later, in a log.
    .select('id, organization_id, phone')
    .in('phone', phoneMatchCandidates(canonical) as string[])
    .limit(CANDIDATE_LIMIT);

  if (error) {
    return { matched: false, reason: 'lookup_failed', candidateCount: 0 };
  }

  // The `in (…)` filter is a prefilter over written forms. The decision is this
  // re-check, which compares canonical numbers — so a candidate variant that somehow
  // matched a different subscriber is discarded here rather than trusted.
  const exact = (data ?? []).filter((row) => normalisePhone(row.phone) === canonical);

  if (exact.length === 0) {
    return { matched: false, reason: 'no_tenant_matched', candidateCount: 0 };
  }

  // One tenant row per organization is still ambiguous if there are two of them, and
  // two tenant rows inside ONE organization is ambiguous too — we would not know which
  // tenancy to attribute the request to. Both are refused.
  if (exact.length > 1) {
    return { matched: false, reason: 'ambiguous_sender', candidateCount: exact.length };
  }

  const only = exact[0];
  if (!only) {
    return { matched: false, reason: 'no_tenant_matched', candidateCount: 0 };
  }

  return {
    matched: true,
    reason: 'matched',
    tenantId: only.id,
    organizationId: only.organization_id,
  };
}
