/**
 * The invitation lifecycle against the **live database**. Lane w1-l1.
 *
 * This is the file that actually proves the lane's exit gate, because it is the only one
 * in which Row Level Security is real. `invitation-lifecycle.test.ts` proves what our
 * code sends and what it does with the answer; this proves what Postgres does with it.
 *
 * ---------------------------------------------------------------------------
 * GATING — read before assuming this ran
 * ---------------------------------------------------------------------------
 * It is skipped unless `PS_ORG_LIVE=1`:
 *
 *     PS_ORG_LIVE=1 npx vitest run tests/organizations/live-invitation-lifecycle.test.ts
 *
 * `vitest.config.ts` includes `tests/**` in the always-on unit suite, and that suite has
 * to stay green on a machine with no network and no database — w0-l6's config says so
 * explicitly, and a network-dependent test in it would fail for reasons unrelated to the
 * code. The gate is an *explicit* skip reported in the test name, not a silent one: a
 * gate that quietly reports success is worse than no gate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REAL
 * ---------------------------------------------------------------------------
 * The organizations, the profiles, the memberships, the invitations, the four
 * security-definer RPCs, every RLS policy in `0002`, the `auth.users` profile trigger in
 * `0003` and the `log_audit` rows are all real. Every assertion runs as `authenticated`
 * with a principal's `auth.uid()` attached — never as the table owner, which would
 * bypass RLS and make the suite pass against a database with no policies at all.
 *
 * Fixtures and cleanup use the owner, and no assertion is made through it.
 *
 * ---------------------------------------------------------------------------
 * ISOLATION FROM OTHER LANES
 * ---------------------------------------------------------------------------
 * Five other agents are working against this same database. Every row this file creates
 * is namespaced by a per-run id, so two concurrent runs cannot collide, and everything is
 * removed in `afterAll`. Cleanup touches only rows carrying that id.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRunner,
  jsonValue,
  literal,
  liveRunPossible,
  readPostgresEnvironment,
  type SqlResult,
} from './_support/live-postgres';
import { INVITATION_COLUMNS } from '@/features/organizations/queries';

const LIVE = process.env.PS_ORG_LIVE === '1';
const POSSIBLE = LIVE && liveRunPossible();

/** Unique per run, so concurrent lanes and repeated runs cannot collide. */
const RUN = `w1l1${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

const connection = POSSIBLE ? readPostgresEnvironment() : null;
const db = connection ? createRunner(connection) : null;

interface Principal {
  authUserId: string;
  email: string;
}

const admin: Principal = { authUserId: uuidFor('01'), email: `admin.${RUN}@w1l1.test` };
const invitee: Principal = { authUserId: uuidFor('02'), email: `invitee.${RUN}@w1l1.test` };
const outsider: Principal = { authUserId: uuidFor('03'), email: `outsider.${RUN}@w1l1.test` };
const revokee = { email: `revokee.${RUN}@w1l1.test` };

let organizationId = '';
let invitationToken = '';
let invitationId = '';
let revokedInvitationId = '';

/** A deterministic, well-formed UUID carrying the run id, so cleanup can find it. */
function uuidFor(slot: string): string {
  const hex = [...RUN]
    .map((c) => c.charCodeAt(0).toString(16))
    .join('')
    .slice(0, 12)
    .padEnd(12, '0');
  return `aaaaaaaa-0000-4000-8000-${hex.slice(0, 10)}${slot}`;
}

function asAdmin(body: string): SqlResult {
  return must(db).asPrincipal(admin.authUserId, body);
}

function asInvitee(body: string): SqlResult {
  return must(db).asPrincipal(invitee.authUserId, body);
}

function asOutsider(body: string): SqlResult {
  return must(db).asPrincipal(outsider.authUserId, body);
}

function must<T>(value: T | null): T {
  if (value === null)
    throw new Error('the live runner is unavailable; this test should be skipped');
  return value;
}

/* -------------------------------------------------------------- lifecycle -- */

const suite = POSSIBLE ? describe : describe.skip;

suite(`the invitation lifecycle against the live database (run ${RUN})`, () => {
  beforeAll(() => {
    const runner = must(db);

    // Fixtures, as the owner. Three auth users; `0003`'s AFTER INSERT trigger on
    // `auth.users` creates each profile, which is the only write path there is.
    const seeded = runner.asOwner(
      `insert into auth.users
         (id, instance_id, aud, role, email, encrypted_password,
          email_confirmed_at, created_at, updated_at, raw_user_meta_data)
       values
         ${[admin, invitee, outsider]
           .map(
             (p, index) =>
               `(${literal(p.authUserId)}, '00000000-0000-0000-0000-000000000000',
                 'authenticated', 'authenticated', ${literal(p.email)}, 'not-a-password',
                 now(), now(), now(), ${literal(JSON.stringify({ full_name: `Live principal ${index + 1}` }))}::jsonb)`,
           )
           .join(', ')}
       on conflict (id) do nothing`,
    );
    expect(seeded.ok, `seeding auth users failed: ${seeded.message}`).toBe(true);
  }, 120_000);

  afterAll(() => {
    if (!db) return;
    // Cleanup, as the owner, and only rows carrying this run's id. The no-DELETE rule in
    // CLAUDE.md governs application paths; a fixture teardown is not one, and leaving
    // rows behind in a database five other lanes are using would be worse.
    db.asOwner(
      [
        `delete from public.audit_logs where organization_id in (select id from public.organizations where slug = ${literal(`live-${RUN}`)})`,
        `delete from public.organizations where slug = ${literal(`live-${RUN}`)}`,
        `delete from auth.users where email like ${literal(`%.${RUN}@w1l1.test`)}`,
      ].join('; '),
    );
  }, 120_000);

  /* ----------------------------------------------- the profile trigger ---- */

  it('creates exactly one profile per auth user, from the trigger and nothing else', () => {
    const count = must(db).asOwner(
      `select count(*) from public.profiles where auth_user_id in
         (${[admin, invitee, outsider].map((p) => literal(p.authUserId)).join(', ')})`,
    );
    expect(count.ok).toBe(true);
    expect(count.value).toBe('3');
  });

  it('gives a client no INSERT path into profiles', () => {
    // Amendment A6: creation moved to the trigger precisely so that a client cannot
    // choose its own profile id and pre-empt a pending invitation.
    const attempt = asAdmin(
      `insert into public.profiles (auth_user_id, full_name, email)
       values (${literal(admin.authUserId)}, 'Forged', 'forged@w1l1.test')`,
    );
    expect(attempt.ok).toBe(false);
    // 42501 is insufficient_privilege, which amendment A2 maps to 403.
    expect(attempt.code).toBe('42501');
  });

  /* ------------------------------------------------- 1. create the org ---- */

  it('step 1 — create_organization makes the caller an administrator in one transaction', () => {
    const result = asAdmin(
      `select public.create_organization(${literal(`Live Org ${RUN}`)}, ${literal(`live-${RUN}`)})`,
    );
    expect(result.ok, result.message).toBe(true);

    const organization = jsonValue<{ id: string; slug: string; status: string }>(result);
    organizationId = organization.id;
    expect(organization.slug).toBe(`live-${RUN}`);
    expect(organization.status).toBe('active');

    const membership = asAdmin(
      `select role::text from public.organization_members
         where organization_id = ${literal(organizationId)}::uuid`,
    );
    expect(membership.value).toBe('organization_admin');
  });

  it('refuses a duplicate slug with the conflict SQLSTATE', () => {
    const result = asAdmin(
      `select public.create_organization('Another name', ${literal(`live-${RUN}`)})`,
    );
    expect(result.ok).toBe(false);
    expect(result.token).toBe('organization_slug_taken');
    // P0001 → CONFLICT → 409 (amendment A2).
    expect(result.code).toBe('P0001');
  });

  it('gives no role a direct INSERT into organizations', () => {
    const insert = asAdmin(
      `insert into public.organizations (name, slug) values ('Sideways', ${literal(`side-${RUN}`)})`,
    );
    expect(insert.ok).toBe(false);

    const exists = must(db).asOwner(
      `select count(*) from public.organizations where slug = ${literal(`side-${RUN}`)}`,
    );
    expect(exists.value).toBe('0');
  });

  it('has no rename path for an organization, in any role', () => {
    // §5.9: `organizations` is read-only for every role including organization_admin,
    // which is why this lane ships no PATCH route.
    //
    // Note the shape of the denial. There is no UPDATE *policy*, so the statement
    // matches zero rows and Postgres reports success — a denied UPDATE under RLS is a
    // silent no-op, not an error. The assertion therefore has to be about the data, not
    // about the status: asserting `ok === false` would be asserting the wrong thing and
    // would pass only by accident on a database that also revoked the grant.
    const rename = asAdmin(
      `update public.organizations set name = 'Renamed by a client'
         where id = ${literal(organizationId)}::uuid`,
    );
    expect(rename.ok || rename.code === '42501').toBe(true);

    const name = must(db).asOwner(
      `select name from public.organizations where id = ${literal(organizationId)}::uuid`,
    );
    expect(name.value).toBe(`Live Org ${RUN}`);
  });

  it('records the unremediated TRUNCATE grant as a live fact (planning defect)', () => {
    // Supabase's default grants to `authenticated` include TRUNCATE, and §5.9a already
    // recorded that for `maintenance_activities`, assigning an explicit revoke to w2-l3.
    // Measured here against the live database, the exposure is wider: `organizations`,
    // `organization_members`, `profiles` and `audit_logs` all still carry it, and
    // TRUNCATE **ignores Row Level Security entirely**, so no policy can contain it.
    //
    // This assertion records the present state rather than the desired one, so the suite
    // reports a defect instead of hiding it. When `0004_security_remediation.sql` revokes
    // the privilege, invert it: `expect(granted).toBe('')`. A migration is not this
    // lane's file to write — reported as a planning defect.
    const granted = must(db).asOwner(
      `select coalesce(string_agg(distinct table_name, ',' order by table_name), '')
         from information_schema.role_table_grants
        where grantee = 'authenticated'
          and table_schema = 'public'
          and privilege_type = 'TRUNCATE'
          and table_name in ('organizations', 'organization_members', 'profiles', 'audit_logs')`,
    );

    expect(granted.ok).toBe(true);
    expect(granted.value).toBe('audit_logs,organization_members,organizations,profiles');
  });

  /* ------------------------------------------------------- 2. invite ------ */

  it('step 2 — invite_member returns the plaintext token exactly once', () => {
    const result = asAdmin(
      `select public.invite_member(${literal(organizationId)}::uuid, ${literal(invitee.email)}, 'tenant'::public.member_role)`,
    );
    expect(result.ok, result.message).toBe(true);

    const issued = jsonValue<{ invitation_id: string; token: string; role: string }>(result);
    invitationId = issued.invitation_id;
    invitationToken = issued.token;

    expect(issued.role).toBe('tenant');
    expect(invitationToken).toHaveLength(64);

    // Only the hash is stored. The plaintext appears nowhere in the table.
    const stored = must(db).asOwner(
      `select token_hash = encode(sha256(convert_to(${literal(invitationToken)}, 'UTF8')), 'hex')
         from public.organization_invitations where id = ${literal(invitationId)}::uuid`,
    );
    expect(stored.value).toBe('t');

    const plaintextAnywhere = must(db).asOwner(
      `select count(*) from public.organization_invitations
         where token_hash = ${literal(invitationToken)}`,
    );
    expect(plaintextAnywhere.value).toBe('0');
  });

  it('records the invitation in audit_logs without the invitee’s email address', () => {
    const audit = must(db).asOwner(
      `select metadata::text from public.audit_logs
         where organization_id = ${literal(organizationId)}::uuid
           and action = 'member.invited'`,
    );
    expect(audit.ok).toBe(true);
    expect(audit.value).toContain('tenant');
    // Personal data never enters an append-only table.
    expect(audit.value).not.toContain(invitee.email);
  });

  it('refuses a second live invitation for the same address', () => {
    const result = asAdmin(
      `select public.invite_member(${literal(organizationId)}::uuid, ${literal(invitee.email)}, 'tenant'::public.member_role)`,
    );
    expect(result.ok).toBe(false);
    expect(result.token).toBe('invitation_already_pending');
    expect(result.code).toBe('P0001');
  });

  /* ------------------------------ the column-level grant, for real -------- */

  it('fails `select *` on organization_invitations with a permission error', () => {
    // The contract this lane was briefed on, asserted against the live grant rather than
    // taken on trust. This is why `INVITATION_COLUMNS` exists.
    const star = asAdmin('select * from public.organization_invitations');
    expect(star.ok).toBe(false);
    expect(star.message).toContain('permission denied');
  });

  it('succeeds with exactly the columns this lane projects', () => {
    const named = asAdmin(
      `select count(*) from (select ${INVITATION_COLUMNS.join(', ')} from public.organization_invitations) q`,
    );
    expect(named.ok, named.message).toBe(true);
    expect(Number(named.value)).toBeGreaterThanOrEqual(1);
  });

  it('refuses token_hash specifically, not the table as a whole', () => {
    const hash = asAdmin('select token_hash from public.organization_invitations');
    expect(hash.ok).toBe(false);
    expect(hash.message).toContain('permission denied');
  });

  /* ---------------------------------- a non-admin cannot invite, live ----- */

  it('exit gate — a non-admin cannot invite: the database refuses with 42501', () => {
    // The invitee has no membership at all yet, and the outsider never will.
    for (const principal of [invitee, outsider]) {
      const result = must(db).asPrincipal(
        principal.authUserId,
        `select public.invite_member(${literal(organizationId)}::uuid, 'someone@w1l1.test', 'tenant'::public.member_role)`,
      );
      expect(result.ok).toBe(false);
      expect(result.token).toBe('member_invite_forbidden');
      // 42501 → FORBIDDEN → 403 (amendment A2).
      expect(result.code).toBe('42501');
    }
  });

  it('shows an outsider nothing of this organization at all', () => {
    const organizations = asOutsider(
      `select count(*) from public.organizations where id = ${literal(organizationId)}::uuid`,
    );
    expect(organizations.value).toBe('0');

    const members = asOutsider(
      `select count(*) from public.organization_members
         where organization_id = ${literal(organizationId)}::uuid`,
    );
    expect(members.value).toBe('0');

    const invitations = asOutsider(
      `select count(*) from (select ${INVITATION_COLUMNS.join(', ')} from public.organization_invitations) q`,
    );
    expect(invitations.value).toBe('0');
  });

  /* ------------------------------------------------------- 3. accept ----- */

  it('step 3 — refuses the token when the account email does not match', () => {
    // Possession of the token is necessary but not sufficient.
    const result = asOutsider(`select public.accept_invitation(${literal(invitationToken)})`);
    expect(result.ok).toBe(false);
    expect(result.token).toBe('invitation_recipient_mismatch');
    expect(result.code).toBe('42501');
  });

  it('step 3 — the invited account redeems the token and becomes a member', () => {
    const result = asInvitee(`select public.accept_invitation(${literal(invitationToken)})`);
    expect(result.ok, result.message).toBe(true);

    const accepted = jsonValue<{ organization_id: string; member_id: string; role: string }>(
      result,
    );
    expect(accepted.organization_id).toBe(organizationId);
    expect(accepted.role).toBe('tenant');

    const consumed = must(db).asOwner(
      `select status from public.organization_invitations where id = ${literal(invitationId)}::uuid`,
    );
    expect(consumed.value).toBe('accepted');
  });

  it('refuses a replay of the same token', () => {
    const result = asInvitee(`select public.accept_invitation(${literal(invitationToken)})`);
    expect(result.ok).toBe(false);
    // The same flat refusal an unknown or expired token gets: not a token oracle.
    expect(result.token).toBe('invitation_invalid_or_expired');
    expect(result.code).toBe('P0001');
  });

  it('writes an audit row for the acceptance', () => {
    const audit = must(db).asOwner(
      `select count(*) from public.audit_logs
         where organization_id = ${literal(organizationId)}::uuid
           and action = 'invitation.accepted'`,
    );
    expect(audit.value).toBe('1');
  });

  /* --------------------------- exit gate: the accepted member's visibility -- */

  it('exit gate — the accepted tenant sees exactly their own membership and no other', () => {
    const own = asInvitee('select count(*) from public.organization_members');
    // `organization_members_select_staff` excludes a tenant, so
    // `organization_members_select_self` is all that remains: one row, theirs.
    expect(own.value).toBe('1');

    const whose = asInvitee(`select role::text from public.organization_members`);
    expect(whose.value).toBe('tenant');

    const administrator = asAdmin('select count(*) from public.organization_members');
    // The same query, two roles, two answers — with no application code involved.
    expect(administrator.value).toBe('2');
  });

  it('exit gate — the accepted tenant sees no invitation, not even their own', () => {
    const invitations = asInvitee(
      `select count(*) from (select ${INVITATION_COLUMNS.join(', ')} from public.organization_invitations) q`,
    );
    expect(invitations.value).toBe('0');
  });

  it('exit gate — the accepted tenant reads their own profile and no other', () => {
    const profiles = asInvitee('select count(*) from public.profiles');
    expect(profiles.value).toBe('1');

    const email = asInvitee('select email from public.profiles');
    expect(email.value).toBe(invitee.email);
  });

  it('exit gate — the accepted tenant cannot read audit_logs', () => {
    // The §4 matrix gives `audit_logs` to organization_admin only.
    const audit = asInvitee('select count(*) from public.audit_logs');
    expect(audit.value).toBe('0');
  });

  it('exit gate — the accepted tenant cannot change their own role', () => {
    const escalation = asInvitee(
      `update public.organization_members set role = 'organization_admin'
         where organization_id = ${literal(organizationId)}::uuid`,
    );
    // No UPDATE policy applies, so the statement matches no row and writes nothing. It
    // does not error: a silent zero-row write is what RLS does on a denied update.
    const role = asInvitee('select role::text from public.organization_members');
    expect(escalation.ok || escalation.code === '42501').toBe(true);
    expect(role.value).toBe('tenant');
  });

  it('a tenant cannot read the administrator’s contact details', () => {
    const others = asInvitee(
      `select count(*) from public.profiles where email = ${literal(admin.email)}`,
    );
    expect(others.value).toBe('0');
  });

  /* ------------------------------------------------------- 4. revoke ----- */

  it('step 4 — an administrator revokes a pending invitation', () => {
    const issued = asAdmin(
      `select public.invite_member(${literal(organizationId)}::uuid, ${literal(revokee.email)}, 'property_manager'::public.member_role)`,
    );
    expect(issued.ok, issued.message).toBe(true);
    revokedInvitationId = jsonValue<{ invitation_id: string }>(issued).invitation_id;

    const revoked = asAdmin(
      `select public.revoke_invitation(${literal(revokedInvitationId)}::uuid)`,
    );
    expect(revoked.ok, revoked.message).toBe(true);
    expect(jsonValue<{ status: string }>(revoked).status).toBe('revoked');
  });

  it('archives rather than deletes — the row survives revocation', () => {
    const row = must(db).asOwner(
      `select status from public.organization_invitations where id = ${literal(revokedInvitationId)}::uuid`,
    );
    expect(row.value).toBe('revoked');
  });

  it('gives no role a DELETE path on invitations or memberships', () => {
    for (const table of ['organization_invitations', 'organization_members', 'organizations']) {
      const attempt = asAdmin(`delete from public.${table}`);
      // Either the grant is absent (42501) or the policy matches nothing. Neither may
      // remove a row, and the counts below prove nothing went.
      expect(attempt.ok === false || attempt.code === '42501').toBe(true);
    }

    const survived = must(db).asOwner(
      `select count(*) from public.organization_members where organization_id = ${literal(organizationId)}::uuid`,
    );
    expect(survived.value).toBe('2');
  });

  it('refuses to revoke an invitation that is no longer pending', () => {
    const again = asAdmin(`select public.revoke_invitation(${literal(revokedInvitationId)}::uuid)`);
    expect(again.ok).toBe(false);
    expect(again.token).toBe('invitation_not_pending');
    expect(again.code).toBe('P0001');
  });

  it('refuses revocation by anyone who is not an administrator of the owning organization', () => {
    const issued = asAdmin(
      `select public.invite_member(${literal(organizationId)}::uuid, 'another.${RUN}@w1l1.test', 'tenant'::public.member_role)`,
    );
    expect(issued.ok, issued.message).toBe(true);
    const id = jsonValue<{ invitation_id: string }>(issued).invitation_id;

    for (const principal of [invitee, outsider]) {
      const result = must(db).asPrincipal(
        principal.authUserId,
        `select public.revoke_invitation(${literal(id)}::uuid)`,
      );
      expect(result.ok).toBe(false);
      // The same refusal a non-existent id gets: not a cross-organization oracle.
      expect(result.token).toBe('invitation_revoke_forbidden');
      expect(result.code).toBe('42501');
    }
  });

  /* ------------------------------------------------------------ the audit -- */

  it('leaves one audit row per state change, in order', () => {
    const actions = must(db).asOwner(
      `select string_agg(action, ',' order by created_at, id) from public.audit_logs
         where organization_id = ${literal(organizationId)}::uuid`,
    );
    const recorded = actions.value.split(',');

    expect(recorded[0]).toBe('organization.created');
    expect(recorded).toContain('member.invited');
    expect(recorded).toContain('invitation.accepted');
    expect(recorded).toContain('member.invitation_revoked');
    // Exactly one organization was created, so exactly one such row exists.
    expect(recorded.filter((action) => action === 'organization.created')).toHaveLength(1);
  });

  it('gives no client a write path into audit_logs', () => {
    const attempt = asAdmin(
      `insert into public.audit_logs (organization_id, action, entity_type)
       values (${literal(organizationId)}::uuid, 'forged.action', 'organization')`,
    );
    expect(attempt.ok).toBe(false);
  });
});

/* ------------------------------------------------------------ the gate ----- */

describe('the live gate', () => {
  it(
    LIVE
      ? 'is enabled, and the live suite above ran'
      : 'is DISABLED — set PS_ORG_LIVE=1 to run the live lifecycle against Postgres',
    () => {
      if (!LIVE) {
        // Deliberately not an assertion about the database. The point of this test is
        // that the report says plainly whether the live proof ran.
        expect(POSSIBLE).toBe(false);
        return;
      }
      expect(POSSIBLE, 'PS_ORG_LIVE=1 was set but psql or .env.local is unavailable').toBe(true);
    },
  );
});
