/**
 * The four security-definer RPCs, as typed TypeScript functions. Lane w1-l1.
 *
 * `supabase/migrations/0002_rls_hardening.sql` grants **no** INSERT, UPDATE or DELETE
 * policy on `public.organizations` or `public.organization_members`, and `0003` grants
 * none on `public.organization_invitations`. Onboarding and invitation writes are
 * therefore impossible to express as a direct statement — by design (§3 finding 8). They
 * go through these four functions and nothing else:
 *
 *   create_organization(p_name, p_slug)   → { id, name, slug, status, created_at }
 *   invite_member(p_org, p_email, p_role) → { invitation_id, token, role, expires_at }
 *   accept_invitation(p_token)            → { organization_id, member_id, role }
 *   revoke_invitation(p_invitation_id)    → { invitation_id, status }
 *
 * Each function re-derives the caller from `auth.uid()` via `current_profile_id()` and
 * checks authority with `has_org_role()`. There is no argument through which a caller
 * can name somebody else, and `p_org` selects a *target* — it never grants access. That
 * is why passing `membership.organization.id` below is not a breach of CLAUDE.md rule 5:
 * the value is read from a trusted membership row, and the database re-checks it anyway.
 *
 * Every one of the four writes its own `audit_logs` row through `log_audit()` inside the
 * same transaction as the change it records. A failed call therefore leaves no audit row
 * and a successful one cannot lack it — which is stronger than auditing in the
 * application layer, and is why these are safe to invoke from a server action as well as
 * from a route handler.
 *
 * Results are parsed with the frozen schemas from `packages/shared`. A `security
 * definer` function's output is trusted but its *shape* is not type-checked by
 * PostgREST, so a signature change surfaces here as a validation error rather than as
 * `undefined` three frames later.
 */

import { ApiRouteError, postgresErrorToApiError } from '@/lib/api/errors';
import type { AppSupabaseClient } from '@/lib/supabase/types';
import {
  AcceptInvitationResultSchema,
  CreateOrganizationResultSchema,
  InviteMemberResultSchema,
  RevokeInvitationResultSchema,
  type AcceptInvitationResult,
  type InviteMemberResult,
  type MemberRole,
  type Organization,
  type RevokeInvitationResult,
} from '@shared/index';

/* ------------------------------------------------------------- the wrapper -- */

/**
 * Calls an RPC and parses its `jsonb` result.
 *
 * `0003` raises with a deliberate SQLSTATE on every refusal — `42501` for an
 * authorization failure, `P0001` for a conflict, `22023` for bad input — and
 * `postgresErrorToApiError` maps those to the frozen error codes per amendment A2. So a
 * non-admin calling `invite_member` becomes a 403 and a duplicate invitation becomes a
 * 409 without this file enumerating a single status code.
 *
 * The raw Postgres message never reaches the client: `0003` interpolates values into
 * some of its messages, and `lib/api/errors.ts` keeps only the leading `snake_case`
 * token for the log.
 */
async function callRpc<TResult>(
  client: AppSupabaseClient,
  fn: 'create_organization' | 'invite_member' | 'accept_invitation' | 'revoke_invitation',
  args: Record<string, unknown>,
  parse: (value: unknown) => TResult,
): Promise<TResult> {
  // The generated `Database['public']['Functions']` types each declare their own Args
  // shape; this wrapper is generic over all four, so the argument object is widened
  // here and narrowed by the caller-facing functions below.
  const { data, error } = await (
    client.rpc as unknown as (
      name: string,
      params: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: unknown }>
  )(fn, args);

  if (error) {
    throw postgresErrorToApiError(error as { code?: string | null; message?: string | null });
  }

  return parse(data);
}

/**
 * Maps a `0003` error token onto a frozen error code with a message a user can act on.
 *
 * Only the stable `snake_case` token is consulted — `lib/api/errors.ts` already put it
 * in `logFields.reason` and discarded the rest of the Postgres message, which may
 * contain interpolated row values. The replacement text is written here rather than
 * passed through, so no uncontrolled string can reach a client.
 *
 * An unrecognised token falls through with the code's default message. That is the safe
 * direction: a refusal we did not anticipate says less, not more.
 */
export function describeRpcFailure(error: unknown): ApiRouteError {
  if (!(error instanceof ApiRouteError)) {
    return new ApiRouteError('INTERNAL_ERROR', { logFields: { reason: 'rpc_unhandled' } });
  }

  const reason = error.logFields.reason;
  const message = typeof reason === 'string' ? RPC_MESSAGES[reason] : undefined;
  if (!message) return error;

  return new ApiRouteError(error.code, {
    message,
    logFields: error.logFields,
    cause: error,
  });
}

/** The user-facing text for a `0003` refusal token, or `null` if there is none. */
export function rpcFailureMessage(error: unknown): string | null {
  if (!(error instanceof ApiRouteError)) return null;
  const reason = error.logFields.reason;
  return (typeof reason === 'string' ? RPC_MESSAGES[reason] : undefined) ?? null;
}

/**
 * Client-safe replacements for the tokens `0003` raises.
 *
 * Note what is *not* here: `invitation_invalid_or_expired` and
 * `invitation_revoke_forbidden` are mapped to the same kind of flat refusal the database
 * gives, because `0003` deliberately makes "no such invitation" and "not yours"
 * indistinguishable. Splitting them in the UI would rebuild the oracle the migration
 * went out of its way to avoid.
 */
const RPC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  organization_slug_taken: 'That organization address is already in use.',
  organization_name_invalid: 'The organization name must be 2 to 120 characters.',
  organization_slug_invalid:
    'The organization address must be lowercase letters, digits and hyphens.',
  member_already_exists: 'That email address already has a membership in this organization.',
  invitation_already_pending: 'A live invitation for that email address already exists.',
  member_invite_forbidden: 'Only an organization administrator may invite members.',
  member_email_invalid: 'Enter a valid email address.',
  invitation_invalid_or_expired: 'That invitation is not valid.',
  invitation_recipient_mismatch: 'That invitation was issued to a different account.',
  invitation_not_pending: 'That invitation is no longer pending.',
  invitation_revoke_forbidden: 'That invitation cannot be revoked.',
  profile_required: 'Your account is not fully set up yet. Sign out and sign in again.',
});

/* ----------------------------------------------------------- the four RPCs -- */

/**
 * `create_organization` — the only write path to `public.organizations`.
 *
 * Creates the organization and the caller's own `organization_admin` membership in one
 * transaction, so there is no window in which an organization exists with nobody able to
 * administer it. The caller's role is not an argument: it is a consequence of having
 * created the organization.
 */
export async function createOrganization(
  client: AppSupabaseClient,
  input: { name: string; slug: string },
): Promise<Organization> {
  return callRpc(
    client,
    'create_organization',
    { p_name: input.name, p_slug: input.slug },
    (value) => CreateOrganizationResultSchema.parse(value),
  );
}

/**
 * `invite_member` — issues an invitation and returns its plaintext token **once**.
 *
 * `organization_invitations` stores only a SHA-256 hash of the token, so this return
 * value is the single moment the plaintext exists outside the invitee's hands. The
 * caller is responsible for putting it in front of the inviting administrator and
 * nowhere else:
 *
 *  - never into a log line (`lib/observability/logger.ts` has an allowlist; `token` is
 *    not on it, so this cannot happen by accident),
 *  - never into an `audit_logs` row — `0003` records only the role, deliberately,
 *  - never into an error message or a URL.
 */
export async function inviteMember(
  client: AppSupabaseClient,
  input: { organizationId: string; email: string; role: MemberRole },
): Promise<InviteMemberResult> {
  return callRpc(
    client,
    'invite_member',
    { p_org: input.organizationId, p_email: input.email, p_role: input.role },
    (value) => InviteMemberResultSchema.parse(value),
  );
}

/**
 * `accept_invitation` — consumes a token and activates the membership.
 *
 * Possession of the token is necessary but **not sufficient**: the RPC also requires the
 * authenticated account's email to match the invitation, so an intercepted token cannot
 * be redeemed by whoever intercepted it.
 *
 * This is one of the two operations an authenticated user performs while holding *no*
 * membership, so it cannot run under `withApiHandler` — see the note in
 * `app/(auth)/actions.ts`.
 */
export async function acceptInvitation(
  client: AppSupabaseClient,
  token: string,
): Promise<AcceptInvitationResult> {
  return callRpc(client, 'accept_invitation', { p_token: token }, (value) =>
    AcceptInvitationResultSchema.parse(value),
  );
}

/**
 * `revoke_invitation` — withdraws a pending invitation.
 *
 * Takes an id, never a token, and returns no token: no path through this function can
 * disclose one. Revoking an already accepted or revoked invitation is a conflict rather
 * than a silent success, because the caller's view of the world is stale and they should
 * be told.
 *
 * This is the archive path for an invitation. There is no DELETE anywhere in this lane —
 * a revoked invitation stays on the record (CLAUDE.md rule 6).
 */
export async function revokeInvitation(
  client: AppSupabaseClient,
  invitationId: string,
): Promise<RevokeInvitationResult> {
  return callRpc(client, 'revoke_invitation', { p_invitation_id: invitationId }, (value) =>
    RevokeInvitationResultSchema.parse(value),
  );
}
