import { z } from 'zod';

import { MEMBER_ROLES } from '../constants/roles';
import { INVITATION_STATUSES, MEMBER_STATUSES, ORGANIZATION_STATUSES } from '../constants/statuses';
import {
  EmailSchema,
  IsoDateTimeSchema,
  PaginationQuerySchema,
  PhoneSchema,
  ShortTextSchema,
  SlugSchema,
  UuidSchema,
  boundedText,
  listResponseSchema,
  resourceResponseSchema,
} from './primitives';

/**
 * Organizations, memberships and invitations.
 *
 * Routes: `/api/v1/organizations`, `/api/v1/members` (lane w1-l1).
 *
 * `organization_id` appears in no request schema in this file. Membership is
 * resolved from trusted database rows by `resolveMembership()`; a body that
 * tries to name an organization is rejected by `.strict()`.
 */

export const MemberRoleSchema = z.enum(MEMBER_ROLES);
export const MemberStatusSchema = z.enum(MEMBER_STATUSES);
export const OrganizationStatusSchema = z.enum(ORGANIZATION_STATUSES);
export const InvitationStatusSchema = z.enum(INVITATION_STATUSES);

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /api/v1/organizations`
 *
 * Executed through the `create_organization` security-definer RPC, which also
 * creates the caller's `organization_admin` membership. The caller's role is
 * therefore not part of the request — it is a consequence of creating the
 * organization.
 */
export const CreateOrganizationSchema = z
  .object({
    name: boundedText(2, 120),
    slug: SlugSchema,
  })
  .strict();

export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;

/** `PATCH /api/v1/organizations/{organizationId}` — organization administrators only. */
export const UpdateOrganizationSchema = z
  .object({
    name: boundedText(2, 120).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateOrganizationInput = z.infer<typeof UpdateOrganizationSchema>;

/**
 * `POST /api/v1/members` — issue an invitation.
 *
 * Identified by email because an invitee may have no account yet. The invitee's
 * organization is the caller's organization, derived from the session; it is not
 * an input. Executed through the `invite_member` security-definer RPC because
 * `0002` grants no direct INSERT policy on `organization_members`
 * (`docs/implementation-plan.md` §3 finding 8).
 */
export const InviteMemberSchema = z
  .object({
    email: EmailSchema,
    role: MemberRoleSchema,
    /** Optional display name, so the pending member is recognisable before acceptance. */
    full_name: boundedText(2, 120).optional(),
  })
  .strict();

export type InviteMemberInput = z.infer<typeof InviteMemberSchema>;

/**
 * `POST /api/v1/members/accept`
 *
 * Calls `accept_invitation(p_token)`. The token is the plaintext value returned
 * exactly once by `invite_member`; `organization_invitations` stores only its
 * SHA-256 hash, so a database read cannot be replayed as an acceptance.
 *
 * The RPC additionally requires the authenticated account's email to match the
 * invitation, so possession of a token is necessary but not sufficient. Never
 * log this value and never place it in a URL that is logged — it belongs in a
 * request body for exactly this reason.
 */
export const AcceptInvitationSchema = z
  .object({
    invitation_token: boundedText(16, 256),
  })
  .strict();

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

/** `POST /api/v1/members/invitations/{invitationId}/revoke` — organization administrators only. */
export const RevokeInvitationSchema = z
  .object({
    invitation_id: UuidSchema,
  })
  .strict();

export type RevokeInvitationInput = z.infer<typeof RevokeInvitationSchema>;

export const InvitationPathParamsSchema = z.object({ invitationId: UuidSchema }).strict();

/** `GET /api/v1/members/invitations?cursor=&limit=&status=` */
export const ListInvitationsQuerySchema = PaginationQuerySchema.extend({
  status: InvitationStatusSchema.optional(),
}).strict();

export type ListInvitationsQuery = z.infer<typeof ListInvitationsQuerySchema>;

/** `PATCH /api/v1/members/{memberId}` — change a role, or disable a member. No DELETE path exists. */
export const UpdateMemberSchema = z
  .object({
    role: MemberRoleSchema.optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateMemberInput = z.infer<typeof UpdateMemberSchema>;

/** `GET /api/v1/members?cursor=&limit=&role=&status=` */
export const ListMembersQuerySchema = PaginationQuerySchema.extend({
  role: MemberRoleSchema.optional(),
  status: MemberStatusSchema.optional(),
}).strict();

export type ListMembersQuery = z.infer<typeof ListMembersQuerySchema>;

export const OrganizationPathParamsSchema = z.object({ organizationId: UuidSchema }).strict();

export const MemberPathParamsSchema = z.object({ memberId: UuidSchema }).strict();

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export const OrganizationSchema = z
  .object({
    id: UuidSchema,
    name: ShortTextSchema,
    slug: SlugSchema,
    status: OrganizationStatusSchema,
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Organization = z.infer<typeof OrganizationSchema>;

/**
 * The profile fields safe to embed beside a membership.
 *
 * `email` and `phone` are personal data. A tenant or service provider sees only
 * their own profile (§4 `profiles`: "R self only"), so these fields are
 * nullable here and the RLS policy — not this schema — decides whether they
 * arrive populated. Never widen this to include another person's contact
 * details for a non-staff caller.
 */
export const MemberProfileSchema = z
  .object({
    id: UuidSchema,
    full_name: ShortTextSchema,
    email: EmailSchema.nullable(),
    phone: PhoneSchema.nullable(),
  })
  .strict();

export const MemberSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    profile_id: UuidSchema,
    role: MemberRoleSchema,
    status: MemberStatusSchema,
    created_at: IsoDateTimeSchema,
    profile: MemberProfileSchema.nullable().optional(),
  })
  .strict();

export type Member = z.infer<typeof MemberSchema>;

/** The caller's own resolved context: who am I, where, and as what. */
export const MembershipContextSchema = z
  .object({
    profile_id: UuidSchema,
    organization: OrganizationSchema,
    role: MemberRoleSchema,
    status: MemberStatusSchema,
  })
  .strict();

export type MembershipContext = z.infer<typeof MembershipContextSchema>;

export const OrganizationResponseSchema = resourceResponseSchema(OrganizationSchema);
export const OrganizationListResponseSchema = listResponseSchema(OrganizationSchema);
export const MemberResponseSchema = resourceResponseSchema(MemberSchema);
export const MemberListResponseSchema = listResponseSchema(MemberSchema);
export const MembershipContextResponseSchema = resourceResponseSchema(MembershipContextSchema);

/* -------------------------------------------------------------------------- */
/* Profiles — amendment A6                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The caller's own profile.
 *
 * Creation has no request schema on purpose: profiles are created by the
 * `handle_new_auth_user()` trigger on `auth.users`, which is the only write
 * path, so there is no client INSERT to validate (amendment A6).
 */
export const ProfileSchema = z
  .object({
    id: UuidSchema,
    full_name: ShortTextSchema,
    email: EmailSchema.nullable(),
    phone: PhoneSchema.nullable(),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * `PATCH /api/v1/profile` — self-scoped update, per the §4 matrix row
 * `profiles: U self` added by amendment A6.
 *
 * `email` is absent deliberately: the address of record lives in `auth.users`
 * and changing it is an identity operation that must go through Supabase Auth's
 * own verification flow, not a profile PATCH. `auth_user_id` is absent for the
 * same reason — it is the link that makes "self" mean anything.
 */
export const UpdateProfileSchema = z
  .object({
    full_name: boundedText(2, 120).optional(),
    phone: PhoneSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update.',
  });

export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>;

export const ProfileResponseSchema = resourceResponseSchema(ProfileSchema);

/* -------------------------------------------------------------------------- */
/* Invitations — amendment A4                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A pending invitation as an administrator sees it.
 *
 * `token_hash` is deliberately absent: the admin SELECT policy on
 * `organization_invitations` omits that column, and no response shape in this
 * package can carry it.
 */
export const InvitationSchema = z
  .object({
    id: UuidSchema,
    organization_id: UuidSchema,
    email: EmailSchema,
    role: MemberRoleSchema,
    status: InvitationStatusSchema,
    invited_by_profile_id: UuidSchema.nullable(),
    accepted_profile_id: UuidSchema.nullable(),
    expires_at: IsoDateTimeSchema,
    accepted_at: IsoDateTimeSchema.nullable(),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export type Invitation = z.infer<typeof InvitationSchema>;

export const InvitationResponseSchema = resourceResponseSchema(InvitationSchema);
export const InvitationListResponseSchema = listResponseSchema(InvitationSchema);

/* -------------------------------------------------------------------------- */
/* RPC result parsers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The three onboarding RPCs return `jsonb`, which arrives as `unknown`. Parse
 * it — a `security definer` function's output is trusted but its shape is not
 * type-checked by the client, so a signature change should surface as a
 * validation error rather than as `undefined` three call frames later.
 */

/** `create_organization(p_name, p_slug)` → `{ id, name, slug, status, created_at }`. */
export const CreateOrganizationResultSchema = OrganizationSchema;

/**
 * `invite_member(p_org, p_email, p_role)` →
 * `{ invitation_id, token, role, expires_at }`.
 *
 * `token` is the plaintext invitation token, returned exactly once. It must
 * reach the invitee and nothing else: never log it, never audit it, never
 * include it in an error message.
 */
export const InviteMemberResultSchema = z
  .object({
    invitation_id: UuidSchema,
    token: z.string().min(16),
    role: MemberRoleSchema,
    expires_at: IsoDateTimeSchema,
  })
  .strict();

export type InviteMemberResult = z.infer<typeof InviteMemberResultSchema>;

/** `accept_invitation(p_token)` → `{ organization_id, member_id, role }`. */
export const AcceptInvitationResultSchema = z
  .object({
    organization_id: UuidSchema,
    member_id: UuidSchema,
    role: MemberRoleSchema,
  })
  .strict();

export type AcceptInvitationResult = z.infer<typeof AcceptInvitationResultSchema>;

/** `revoke_invitation(p_invitation_id)` → `{ invitation_id, status }`. */
export const RevokeInvitationResultSchema = z
  .object({
    invitation_id: UuidSchema,
    status: InvitationStatusSchema,
  })
  .strict();

export type RevokeInvitationResult = z.infer<typeof RevokeInvitationResultSchema>;

/**
 * The invitation response an administrator receives after issuing one.
 *
 * Mirrors `InviteMemberResultSchema` minus the token. The token is delivered to
 * the invitee out of band; echoing it to the issuing admin's browser would put
 * a bearer credential into a response body, a devtools history and any
 * client-side error reporter.
 */
export const IssuedInvitationResponseSchema = resourceResponseSchema(
  z
    .object({
      invitation_id: UuidSchema,
      email: EmailSchema,
      role: MemberRoleSchema,
      expires_at: IsoDateTimeSchema,
    })
    .strict(),
);
