# Identity, organizations and invitations — lane w1-l1

Everything a signed-in person needs before any other feature means anything: an account,
an organization, a role inside it, and a way for an administrator to hand those out.

## Surface

| Path                                                     | What it is                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| `/sign-in` `/sign-up` `/forgot-password`                 | Auth pages. Slugs frozen by amendment A17 and named literally by `middleware.ts`. |
| `/accept-invitation`                                     | Signed-**out** landing page for an invitee. Cannot redeem — see the defect below. |
| `/dashboard`                                             | Authenticated landing page. Composes `widgetsForRole()` from `config/dashboard.slots.ts`. |
| `/organization`                                          | Organization summary for every role; invitation desk for an administrator. |
| `/organization/accept`                                   | Where an invitation is actually redeemed (session guaranteed).            |
| `/members`                                               | The roster. Open to every role on purpose — see "Role boundaries", below. |
| `GET POST /api/v1/organizations`                         | List the caller's organizations; create one via `create_organization`.   |
| `GET /api/v1/organizations/{organizationId}`             | One organization. 404, never 403, across the boundary.                  |
| `GET POST /api/v1/members`                               | Roster; issue an invitation (admin only).                               |
| `PATCH /api/v1/members/{memberId}`                       | Change a role or disable a member (admin only, audited).                |
| `GET /api/v1/members/invitations`                        | Invitation list (admin only).                                           |
| `POST /api/v1/members/invitations/{invitationId}/revoke` | Revoke. A POST, not a DELETE.                                           |
| `POST /api/v1/members/accept`                            | Redeem a token (for a caller who already holds a membership).           |

No `PATCH` on an organization and no `DELETE` anywhere: `organizations` is read-only for
every role including `organization_admin` (§5.9), and removal is always archival —
`status = 'disabled'` for a member, `status = 'revoked'` for an invitation.

## Where the writes go

All four onboarding writes are security-definer RPCs from `0003`, wrapped in
`rpc.ts`. There is no INSERT, UPDATE or DELETE policy on `organizations`,
`organization_members` or `organization_invitations`, so a direct statement is not merely
discouraged — it is impossible.

```
create_organization(p_name, p_slug)   → { id, name, slug, status, created_at }
invite_member(p_org, p_email, p_role) → { invitation_id, token, role, expires_at }
accept_invitation(p_token)            → { organization_id, member_id, role }
revoke_invitation(p_invitation_id)    → { invitation_id, status }
```

Each re-derives the caller from `auth.uid()`, checks authority with `has_org_role()`, and
writes its own `audit_logs` row in the same transaction. That is why these routes declare
no `audit` option on `withApiHandler`: one state change, one audit row. The single direct
write in the lane — a role change in `members.ts` — is the one that *does* declare it.

## The invitation token

`invite_member` returns the plaintext token **once**; only a SHA-256 hash is stored, so it
cannot be read back by anyone, including the administrator who issued it. It is surfaced
to that administrator immediately, on a panel that says so, and it reaches no log line, no
audit row, no error message and no URL. If it is lost, revoke and reissue.

## Role boundaries

`/members` and `GET /api/v1/members` are deliberately open to every role. What comes back
is decided by `0002`'s two SELECT policies: staff see the roster, a tenant or a provider
sees exactly one row, their own. Gating the route to administrators would hide the
boundary; letting policy answer makes acceptance criterion 2 visible on screen.

Row visibility is RLS. **Column** visibility is ours: `queries.ts` runs every embedded
profile through `authorize(…, 'read', { type: 'profile', … })` and drops `email` and
`phone` when the matrix withholds them, because RLS is row-level and cannot hide a column.

`select *` is never issued against `organization_invitations` — the grant in `0003` is
column-level and omits `token_hash`, so a star select fails outright.
`INVITATION_COLUMNS` is the projection, and `tests/organizations/invitation-columns.test.ts`
parses the grant out of the migration and compares the two.

## Tests

```bash
npx vitest run tests/organizations                 # always-on: 119 assertions
PS_ORG_LIVE=1 npx vitest run tests/organizations   # 152 — adds 33 against live Postgres
```

The live file is the one that proves the exit gate, because it is the only one where RLS
is real: it impersonates `authenticated` exactly as PostgREST does, runs the full
lifecycle, and asserts the SQLSTATE of every refusal. It is gated because the always-on
suite must stay green with no network, and the gate is reported in a test name rather than
skipped silently.

## Planning defects raised by this lane

1. **`withApiHandler` cannot serve onboarding.** It resolves membership before the handler
   and answers `FORBIDDEN` when there is none — which is exactly the state of a user who
   has just signed up. `create_organization` and `accept_invitation` are therefore also
   exposed as server actions in `app/(auth)/actions.ts`, calling the same functions in
   `rpc.ts`.
2. **`/accept-invitation` cannot redeem an invitation.** `middleware.ts` treats all four
   A17 slugs as signed-out-only, but `accept_invitation` requires `auth.uid()`. The
   redemption form lives at `/organization/accept`; the A17 slug is a landing page.
3. **Two frozen response shapes for one route.** `IssuedInvitationResponseSchema` omits
   the token, `InviteMemberResultSchema` carries it, and §5 binds neither to a route. This
   lane returns the latter, because with no mail transport in §5.1 an invitation without
   its token can never be redeemed.
4. **`TRUNCATE` is still granted to `authenticated`** on `organizations`,
   `organization_members`, `profiles` and `audit_logs`, and TRUNCATE ignores RLS. §5.9a
   recorded this for `maintenance_activities` only. Measured against the live database and
   asserted in the live test so the gap stays visible. Needs `0004`, which is w2-l3's file.
5. **No owner for `/api/v1/profile`.** `UpdateProfileSchema` exists in `packages/shared`
   (amendment A6) but `app/api/v1/profile/**` is in no lane's globs.
6. **No slot for an account control in the shell.** `components/shell/topbar.tsx` is
   w0-l1's, so sign-out is rendered by `app/(dashboard)/layout.tsx` instead.
