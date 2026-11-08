import { z } from 'zod';

import { MEMBER_ROLES } from '../constants/roles';
import { MEMBER_STATUSES, ORGANIZATION_STATUSES } from '../constants/statuses';
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
 * Accepts either identifier so that the route is compatible with both
 * invitation designs available to migration `0003`: a dedicated invitations
 * table keyed by an unguessable token, or a pending `organization_members` row
 * with `status = 'invited'`. Whichever `0003` delivers, exactly one branch is
 * used and the other is dead — the server validates the value against the
 * database either way, so neither branch is a trust decision.
 */
export const AcceptInvitationSchema = z.union([
  z.object({ invitation_token: boundedText(16, 256) }).strict(),
  z.object({ membership_id: UuidSchema }).strict(),
]);

export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

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

export const OrganizationPathParamsSchema = z
  .object({ organizationId: UuidSchema })
  .strict();

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
