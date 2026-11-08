-- =============================================================================
-- Migration 0002 — RLS hardening: helper functions and the fine-grained
--                  policy matrix.
--
-- Lane:    w0-l2. This file is the only artifact of that lane.
-- Reads:   supabase/migrations/0001_initial_schema.sql (frozen),
--          docs/implementation-plan.md §3 (findings) and §4 (the matrix),
--          docs/parallel-execution-plan.md §5.3 (frozen helper signatures).
--
-- Closes findings 1–8 of docs/implementation-plan.md §3:
--   1  organizations had no RLS           -> enabled, read restricted to own memberships
--   2  profiles had no RLS                -> enabled, self + same-org-staff visibility
--   3  policies only tested is_org_member -> role-, self- and assignment-scoped policies
--   4  providers had org-wide ticket read -> restricted to assigned_provider_id
--   5  `for all` policies granted DELETE  -> no DELETE policy anywhere, plus explicit revokes
--   6  activities immutable by omission   -> revoke update/delete (trigger pairs in 0003)
--   7  audit_logs readable by any member  -> organization_admin only
--   8  no INSERT on organizations/members -> intentional; onboarding and invitations
--                                            route through 0003's security definer RPCs.
--                                            No INSERT policy is added here, by design.
--
-- Plus one defect found only by attacking the live database, after every policy
-- in this file was already in place and verified:
--  11  TRUNCATE granted to authenticated   -> revoked in §4a by loop, and removed
--      on all 15 tenant-scoped tables.        from the schema default privileges.
--      TRUNCATE IGNORES RLS, so no policy     An authenticated principal with NO
--      here was ever in its path.             membership in ANY organization could
--                                             erase every tenant's data in 15
--                                             statements. §7 now asserts against it.
--
-- STANDING REQUIREMENT FOR LATER MIGRATIONS. §4a revokes TRUNCATE from every
-- table that exists when 0002 runs, and also strips it from the schema default
-- privileges so later tables do not inherit it. If the default-privileges step
-- emits its warning — it needs membership in the grantor role and the migration
-- role may not have it — then that second protection is absent, and ANY later
-- migration that creates a table in `public` MUST re-run the revoke loop from
-- §4a. The §7 assertion is the backstop: it fails the migration rather than
-- letting a single new table silently reopen total data destruction.
--
-- The default grant also carries REFERENCES and TRIGGER. Both were considered
-- and deliberately left in place; the reasoning is recorded in §4a so the next
-- reader can see the privilege enumeration was complete rather than partial.
--
-- ORCHESTRATOR AMENDMENTS to the §4 matrix, adjudicated after this lane reported
-- them as planning defects. The matrix in implementation-plan.md §4 is amended;
-- this file implements the amended form:
--   A  `profiles` gains a self-scoped UPDATE (a caller may edit only their own
--      row, and may not re-point auth_user_id at another user). There is still
--      no client INSERT: row creation happens in an auth.users AFTER INSERT
--      security definer trigger owned by 0003.
--   B  `service_provider` gains SELECT and INSERT on `documents`, scoped
--      strictly to a ticket assigned to them, so completion evidence is
--      possible. A provider still cannot reach a tenancy contract or a property
--      document. This depends on `documents.ticket_id`, which 0003 adds — see
--      the ORDERING DEPENDENCY note in §5 under `documents`.
--   C  `organization_admin` gains INSERT on `maintenance_activities` on the same
--      terms as property_manager. Without it an admin-performed ticket
--      transition could not write its activity row, and "an immutable history of
--      every transition" would quietly mean "every transition except an admin's".
--   D  The reporting tenant gains a cancel path on `maintenance_tickets` while
--      the ticket is still `open`, matching the state machine ruling below.
--
-- Ticket state machine as ruled for 0003, which nothing here contradicts:
-- the legal edge set includes `awaiting_approval -> in_progress` (rework;
-- admin/manager only), and `cancelled` is reachable by admin/manager from any
-- non-terminal state, by the reporting tenant only while `open`, and never by a
-- service provider or a property owner.
--
-- Acceptance criteria named in the per-policy comments below are the numbered
-- functional acceptance criteria in docs/requirements.md §6:
--   AC1  a user can authenticate and belong to an organization
--   AC2  organization A cannot read or modify organization B's records
--   AC3  authorized users can create and update properties and units
--   AC4  a manager can create and manage tenancies
--   AC5  a tenant can create a maintenance ticket for an authorized unit
--   AC6  a manager can assign a provider within the same organization
--   AC7  a provider can view only jobs assigned to them
--   AC8  AI classification is schema-valid and cannot bypass authorization
--   AC9  document extraction is unverified until a human reviews it
--   AC10 critical state changes create audit/activity records
--
-- Idempotency: every statement is `if not exists` / `or replace` /
-- `drop ... if exists` guarded, so the file applies to a fresh database and is a
-- no-op on re-run. Confirmed on a live Supabase Postgres 17: applied clean to a
-- pristine database and re-applied idempotently.
--
-- EXECUTION FOUND ONE DEFECT THAT STATIC REVIEW DID NOT, worth recording because
-- the shape generalises. An inline `exists (select ... from <other table>)` in a
-- policy body is subject to THAT table's RLS, so two tables whose policies read
-- each other form a cycle and Postgres raises
-- "infinite recursion detected in policy for relation ...". Here
-- maintenance_tickets_insert_tenant inline-read property_units, whose
-- property_units_select_provider reads maintenance_tickets back, and every
-- authenticated ticket INSERT failed. A bare SELECT on either table does not
-- close the cycle, so a read-only smoke test misses it entirely.
--
-- The rule now applied throughout: a policy may inline-read another table only
-- where the reference graph stays acyclic. Where it would not, the read goes
-- behind a `security definer` helper, which does not re-enter RLS. After the fix
-- no policy on `maintenance_tickets` inline-reads any table, making it a sink,
-- and the remaining 11 inline references form a DAG.
--
-- Every helper call inside a policy body is wrapped as `(select helper(...))` so
-- the planner evaluates it as a cached sub-plan per statement rather than per row.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------

-- Reserved for the deferred RAG slice (implementation-plan.md §9). Enabled now so
-- migration history stays linear when `document_chunks` is added later. No vector
-- column and no vector table is created by this migration.
create extension if not exists vector;


-- -----------------------------------------------------------------------------
-- 1. Enable row level security everywhere (findings 1 and 2)
-- -----------------------------------------------------------------------------
-- 0001 omitted `organizations` and `profiles`. Until this migration, any
-- authenticated user could enumerate every organization on the platform and read
-- every user's full name, email address and phone number. These two statements
-- are the most consequential lines in the file.

alter table public.organizations          enable row level security;  -- finding 1
alter table public.profiles               enable row level security;  -- finding 2

-- Re-asserted for completeness; already enabled in 0001. `enable row level
-- security` is idempotent.
alter table public.organization_members   enable row level security;
alter table public.properties             enable row level security;
alter table public.property_units         enable row level security;
alter table public.tenants                enable row level security;
alter table public.tenancies              enable row level security;
alter table public.service_providers      enable row level security;
alter table public.maintenance_tickets    enable row level security;
alter table public.maintenance_activities enable row level security;
alter table public.documents              enable row level security;
alter table public.ai_conversations       enable row level security;
alter table public.ai_messages            enable row level security;
alter table public.notifications          enable row level security;
alter table public.audit_logs             enable row level security;


-- -----------------------------------------------------------------------------
-- 2. Drop every baseline policy from 0001, by name (finding 3)
-- -----------------------------------------------------------------------------
-- All 26 baseline policies tested only `is_org_member()`. The effect was that a
-- tenant could read every other tenant's personal data, every tenancy and every
-- document in the organization, and the `for all` variants additionally granted
-- DELETE on tenancy and financial records (finding 5).

drop policy if exists "members can view organization membership" on public.organization_members;

drop policy if exists "members can view properties"              on public.properties;
drop policy if exists "members can insert properties"            on public.properties;
drop policy if exists "members can update properties"            on public.properties;

drop policy if exists "members can view units"                   on public.property_units;
drop policy if exists "members can manage units"                 on public.property_units;

drop policy if exists "members can view tenants"                 on public.tenants;
drop policy if exists "members can manage tenants"               on public.tenants;

drop policy if exists "members can view tenancies"               on public.tenancies;
drop policy if exists "members can manage tenancies"             on public.tenancies;

drop policy if exists "members can view providers"               on public.service_providers;
drop policy if exists "members can manage providers"             on public.service_providers;

drop policy if exists "members can view tickets"                 on public.maintenance_tickets;
drop policy if exists "members can create tickets"               on public.maintenance_tickets;
drop policy if exists "members can update tickets"               on public.maintenance_tickets;

drop policy if exists "members can view ticket activities"       on public.maintenance_activities;
drop policy if exists "members can add ticket activities"        on public.maintenance_activities;

drop policy if exists "members can view documents"               on public.documents;
drop policy if exists "members can manage documents"             on public.documents;

drop policy if exists "members can view conversations"           on public.ai_conversations;
drop policy if exists "members can manage conversations"         on public.ai_conversations;

drop policy if exists "members can view messages"                on public.ai_messages;
drop policy if exists "members can add messages"                 on public.ai_messages;

drop policy if exists "members can view notifications"           on public.notifications;
drop policy if exists "members can add notifications"            on public.notifications;

drop policy if exists "members can view audit logs"              on public.audit_logs;


-- -----------------------------------------------------------------------------
-- 3. Helper functions
--    (implementation-plan.md §4; signatures frozen in
--     parallel-execution-plan.md §5.3 — do not change a name or a parameter)
-- -----------------------------------------------------------------------------
-- `public.current_profile_id()` and `public.is_org_member(uuid)` already exist in
-- 0001 and are reused unchanged. They are NOT redefined here.
--
-- All six are `stable security definer set search_path = ''`:
--   * security definer, so a policy can resolve the caller's membership without
--     the caller needing read access to the row that proves it — and so these
--     lookups do not re-enter RLS and recurse,
--   * `set search_path = ''`, so a caller cannot shadow `public` and hijack the
--     body; that is why every reference inside is schema-qualified,
--   * stable, so the planner may hoist the call out of a per-row loop.
--
-- No seventh helper is introduced. Every other predicate is expressed inline in
-- the policy that needs it, so the cross-lane SQL surface stays exactly the
-- frozen six.

-- Does the caller hold any of `roles` as an active member of `org`?
create or replace function public.has_org_role(org uuid, roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.profile_id = public.current_profile_id()
      and m.status = 'active'
      and m.role = any (roles)
  )
$$;

-- Staff = organization_admin or property_manager: the write role for property,
-- unit, tenant, tenancy, provider and ticket administration.
create or replace function public.is_org_staff(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.has_org_role(
    org,
    array['organization_admin', 'property_manager']::public.member_role[]
  )
$$;

-- The caller's `tenants` row in `org`, or null. A profile is linked to at most
-- one tenant record per organization.
create or replace function public.current_tenant_id(org uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select t.id
  from public.tenants t
  where t.organization_id = org
    and t.profile_id = public.current_profile_id()
  limit 1
$$;

-- The caller's ACTIVE `service_providers` row in `org`, or null. A deactivated
-- provider resolves to null and therefore loses access to its assigned work.
create or replace function public.current_provider_id(org uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select sp.id
  from public.service_providers sp
  where sp.organization_id = org
    and sp.profile_id = public.current_profile_id()
    and sp.status = 'active'
  limit 1
$$;

-- Is the caller the recorded owner of `property_id` in `org`? Ownership is the
-- `properties.owner_member_id` membership row resolving to the caller's profile.
-- Neither referenced table has a column named `property_id`, so the parameter
-- cannot be captured by a column reference.
create or replace function public.owns_property(org uuid, property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.properties p
    join public.organization_members m
      on m.id = p.owner_member_id
    where p.organization_id = org
      and p.id = property_id
      and m.organization_id = org
      and m.profile_id = public.current_profile_id()
      and m.status = 'active'
  )
$$;

-- Does the caller hold an ACTIVE tenancy on `unit_id` in `org`? This is the
-- single predicate that decides which unit a tenant may read and may open a
-- ticket against. A draft, expired or terminated tenancy grants nothing.
-- No referenced table has a column named `unit_id`.
create or replace function public.can_access_unit(org uuid, unit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenancies tn
    join public.tenants t
      on t.organization_id = tn.organization_id
     and t.id = tn.tenant_id
    where tn.organization_id = org
      and tn.property_unit_id = unit_id
      and tn.status = 'active'
      and t.profile_id = public.current_profile_id()
  )
$$;

-- Does `unit_id` exist inside `property_id` inside `org`?
--
-- WHY THIS IS A FUNCTION AND NOT AN INLINE EXISTS. This check began life as an
-- inline `exists (select 1 from public.property_units u ...)` inside
-- maintenance_tickets_insert_tenant, and that caused
-- "infinite recursion detected in policy for relation maintenance_tickets" on
-- EVERY authenticated ticket INSERT:
--
--   maintenance_tickets_insert_tenant (with check)
--     -> inline exists on property_units
--        -> property_units RLS applies to that subquery
--           -> property_units_select_provider (using)
--              -> exists on maintenance_tickets
--                 -> re-enters maintenance_tickets policy evaluation -> cycle
--
-- A bare SELECT on either table never closes the cycle, which is why only the
-- INSERT path failed. Moving the read behind a security definer boundary breaks
-- it: the function's read of property_units runs as the function owner and does
-- not re-enter RLS. Nothing is lost by doing so, because this predicate is
-- STRUCTURAL INTEGRITY — "the unit must belong to the stated property" — and not
-- an authorization decision. The authorization decision on the same statement is
-- `can_access_unit`, which stays exactly as it is.
--
-- WHY $1/$2/$3 AND NOT THE PARAMETER NAMES. `public.property_units` has a column
-- literally named `property_id`. In a SQL-language function a column name takes
-- precedence over a same-named parameter, so writing `u.property_id = property_id`
-- would silently compare the column to ITSELF — always true — and the integrity
-- check would be a no-op that looked correct in review. Positional parameters
-- cannot be captured by a column name, so they are used deliberately here.
-- (The other helpers reference parameters by name safely: no table they touch has
-- a column named `org`, `unit_id` or `property_id`.)
create or replace function public.unit_belongs_to_property(org uuid, unit_id uuid, property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $ubp$
  select exists (
    select 1
    from public.property_units u
    where u.organization_id = $1
      and u.id            = $2
      and u.property_id   = $3
  )
$ubp$;

-- Policy bodies are evaluated with the caller's privileges, so the caller needs
-- EXECUTE. Granted explicitly rather than relying on the default PUBLIC grant.
grant execute on function public.has_org_role(uuid, public.member_role[]) to authenticated, service_role;
grant execute on function public.is_org_staff(uuid)                       to authenticated, service_role;
grant execute on function public.current_tenant_id(uuid)                  to authenticated, service_role;
grant execute on function public.current_provider_id(uuid)                to authenticated, service_role;
grant execute on function public.owns_property(uuid, uuid)                to authenticated, service_role;
grant execute on function public.can_access_unit(uuid, uuid)              to authenticated, service_role;
grant execute on function public.unit_belongs_to_property(uuid, uuid, uuid) to authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 4. Table privileges: no DELETE anywhere (finding 5), activity history
--    immutable (finding 6), audit log append-only (finding 7)
-- -----------------------------------------------------------------------------
-- Omitting a DELETE policy already makes a client DELETE match zero rows, but it
-- fails silently. Revoking the privilege makes the database answer 42501
-- instead, so an accidental destructive endpoint fails loudly in development and
-- in w0-l6's negative-write suite. Archive is the deletion model throughout:
-- `properties` and `property_units` have a `status` column, `tenancies` have
-- 'terminated', `maintenance_tickets` have 'cancelled'.

revoke delete on public.organizations          from anon, authenticated;
revoke delete on public.profiles               from anon, authenticated;
revoke delete on public.organization_members   from anon, authenticated;
revoke delete on public.properties             from anon, authenticated;
revoke delete on public.property_units         from anon, authenticated;
revoke delete on public.tenants                from anon, authenticated;
revoke delete on public.tenancies              from anon, authenticated;
revoke delete on public.service_providers      from anon, authenticated;
revoke delete on public.maintenance_tickets    from anon, authenticated;
revoke delete on public.documents              from anon, authenticated;
revoke delete on public.ai_conversations       from anon, authenticated;
revoke delete on public.ai_messages            from anon, authenticated;
revoke delete on public.notifications          from anon, authenticated;

-- Finding 6. The immutable activity history must be immutable in privileges, not
-- merely in the absence of a policy. 0003 adds the matching block trigger so the
-- guarantee also holds for service-role, which bypasses RLS entirely.
revoke update, delete on public.maintenance_activities from anon, authenticated;

-- Finding 7 and AC10. The audit trail is append-only and is written by 0003's
-- `log_audit()` security definer helper or by the service-role client, never by a
-- client session. Organization admins read it; nobody edits it.
revoke insert, update, delete on public.audit_logs from anon, authenticated;


-- -----------------------------------------------------------------------------
-- 4a. TRUNCATE — finding 11, the most serious defect found in this project
-- -----------------------------------------------------------------------------
-- TRUNCATE IGNORES ROW LEVEL SECURITY COMPLETELY. It is not a filtered DELETE:
-- no policy is consulted, so none of the 69 policies in this file were ever in
-- its path. Supabase ships
--     alter default privileges in schema public grant all on tables to authenticated, anon
-- and "all" includes TRUNCATE, so every table arrived with it granted.
--
-- Proven live against an authenticated principal with NO membership in ANY
-- organization: `truncate public.audit_logs` succeeded and left zero audit rows.
-- Any authenticated user, including a brand-new signup, could have erased every
-- organization's properties, units, tenants, tenancies, tickets, documents,
-- memberships, profiles and the whole audit trail in fifteen statements. Total
-- multi-tenant data destruction, underneath the entire security model.
--
-- Why it survived review: §4 above revokes UPDATE and DELETE and those were
-- verified, and the plan recorded TRUNCATE only for `maintenance_activities`,
-- where 0003's trigger happens to cover it. Nothing said "enumerate every
-- privilege Supabase grants by default".
--
-- PRIVILEGE ENUMERATION, done deliberately so the next reader knows it was not
-- partial. Supabase's default grant covers SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES and TRIGGER:
--   * SELECT/INSERT/UPDATE  — intended, and governed by the policies above.
--   * DELETE                — revoked in §4. Archive is the model.
--   * TRUNCATE              — revoked here. Bypasses RLS; no legitimate client use.
--   * REFERENCES            — CONSIDERED AND DEFERRED. Lets a client add a foreign
--                             key pointing at these tables. Not a read, write or
--                             destruction path on its own; the worst case is
--                             nuisance referential coupling from a table the
--                             client would also have to own. Left granted.
--   * TRIGGER               — CONSIDERED AND DEFERRED. Lets a client attach a
--                             trigger to a table it owns. `authenticated` owns no
--                             table in this schema, so it has nothing to attach a
--                             trigger to. Left granted.
-- If either is ever revisited, revoke it in a later migration, not by editing
-- this block.

-- Revoked by LOOP, not by a hand-written list of fifteen tables: a future
-- migration that adds a tenant-scoped table would silently reopen the hole.
-- Covers 'r' (ordinary) and 'p' (partitioned) relations.
do $trunc$
declare
  rec record;
  touched int := 0;
begin
  for rec in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by c.relname
  loop
    execute format(
      'revoke truncate on public.%I from authenticated, anon', rec.relname
    );
    touched := touched + 1;
  end loop;

  raise notice
    'migration 0002: TRUNCATE revoked from authenticated and anon on % table(s) in schema public',
    touched;
end
$trunc$;

-- Fix the SOURCE as well as the symptom: without this, a table created by 0004
-- or later inherits TRUNCATE from the default privileges and the hole reopens
-- for that table alone — which the loop above, having already run, would not
-- catch.
--
-- ALTER DEFAULT PRIVILEGES is per grantor role, so revoking it for the current
-- role is not sufficient: it must be revoked for every role that holds a default
-- ACL on tables in `public` (on Supabase typically `postgres` and/or
-- `supabase_admin`). Doing that requires membership in each such role, which the
-- migration role may not have — so each attempt is made individually and a
-- failure DOWNGRADES TO A WARNING rather than aborting the migration. If the
-- warning fires, the standing requirement in the header applies: any later
-- migration that adds a table must re-run the revoke loop above.
do $defacl$
declare
  grantor   text;
  unreached text[] := '{}';
  reached   int    := 0;
begin
  for grantor in
    select distinct pg_catalog.pg_get_userbyid(d.defaclrole)
    from pg_catalog.pg_default_acl d
    join pg_catalog.pg_namespace ns on ns.oid = d.defaclnamespace
    where ns.nspname = 'public'
      and d.defaclobjtype = 'r'
  loop
    begin
      execute format(
        'alter default privileges for role %I in schema public '
        'revoke truncate on tables from authenticated, anon',
        grantor
      );
      reached := reached + 1;
    exception
      when insufficient_privilege then
        unreached := unreached || grantor;
    end;
  end loop;

  -- Also pin it for the migration role itself, which may hold no default ACL yet
  -- and therefore not appear in the loop above.
  begin
    execute 'alter default privileges in schema public '
            'revoke truncate on tables from authenticated, anon';
  exception
    when insufficient_privilege then
      unreached := unreached || current_user::text;
  end;

  if array_length(unreached, 1) is not null then
    raise warning
      'migration 0002: could not revoke TRUNCATE from the default privileges of role(s) %. A table created later by those roles will inherit TRUNCATE for authenticated/anon. Any migration that adds a table MUST re-run the revoke loop in section 4a.',
      array_to_string(unreached, ', ');
  else
    raise notice
      'migration 0002: TRUNCATE removed from the default privileges of % grantor role(s); tables added later do not inherit it',
      reached;
  end if;
end
$defacl$;

-- The same default grant reaches `storage.objects`, where a TRUNCATE would erase
-- every file's metadata for every organization at once. This lane does not own
-- the storage schema and cannot be certain the migration role may alter its
-- privileges, so the attempt is best-effort and warns instead of aborting.
-- REPORTED TO THE ORCHESTRATOR for live measurement — treat the warning, if it
-- appears, as an open finding rather than noise.
do $trunc_storage$
declare
  rec record;
begin
  for rec in
    select c.relname
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'storage'
      and c.relkind in ('r', 'p')
    order by c.relname
  loop
    begin
      execute format(
        'revoke truncate on storage.%I from authenticated, anon', rec.relname
      );
    exception
      when insufficient_privilege then
        raise warning
          'migration 0002: could not revoke TRUNCATE on storage.% from authenticated/anon - verify this privilege on the live database.',
          rec.relname;
    end;
  end loop;
end
$trunc_storage$;


-- =============================================================================
-- 5. The policy matrix (implementation-plan.md §4)
--
-- One policy per table, per operation, per role. No `for all` policy exists in
-- this file — `for all` is what produced findings 3 and 5. Every policy is
-- `to authenticated`, so the `anon` role reaches nothing at all.
--
-- Postgres ORs multiple permissive policies for the same command, so each policy
-- below is a single grant of access and is safe to read in isolation.
-- =============================================================================


-- -- organizations ------------------------------------------------------------
-- Matrix: R own, for every role. No role may write — not even
-- organization_admin; creation routes through 0003's `create_organization` RPC
-- (finding 8).

-- AC1 (a user belongs to an organization), AC2 (no cross-organization read).
-- Closes finding 1: replaces platform-wide enumeration with own-membership only.
drop policy if exists organizations_select_member on public.organizations;
create policy organizations_select_member
on public.organizations
for select
to authenticated
using ((select public.is_org_member(id)));

-- No organizations_insert_*, _update_* or _delete_* policy exists, deliberately.


-- -- profiles -----------------------------------------------------------------
-- Matrix: admin/manager/owner R self + same-org; tenant and provider R self
-- only. Closes finding 2.

-- AC1. A caller may always read their own profile; `resolveMembership()` depends
-- on this and on nothing else.
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self
on public.profiles
for select
to authenticated
using (id = (select public.current_profile_id()));

-- AC2 and goal 2 (role boundaries inside an organization). Staff and owners see
-- the profiles of fellow active members; a tenant or a service provider sees
-- nobody but themselves, so no tenant can read another tenant's name, email or
-- phone number.
-- The scan of organization_members is itself RLS-filtered. That is intentional
-- and sufficient: organization_members_select_staff below grants exactly these
-- three roles whole-organization visibility of membership rows, and a nested RLS
-- filter can only narrow this predicate, never widen it.
drop policy if exists profiles_select_same_org_staff on public.profiles;
create policy profiles_select_same_org_staff
on public.profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.organization_members m
    where m.profile_id = profiles.id
      and m.status = 'active'
      and (select public.has_org_role(
             m.organization_id,
             array['organization_admin', 'property_manager', 'property_owner']::public.member_role[]
           ))
  )
);

-- AC1. Amendment A. A caller may maintain their OWN profile and nothing else.
-- The `using` clause pins the target row to the caller. The `with check` clause
-- re-pins it AND requires auth_user_id to remain the caller's own Supabase user,
-- so the row cannot be re-pointed at another identity: without that clause a user
-- could rewrite auth_user_id and silently take over a different person's profile,
-- which would hand them that person's memberships, tenancies and tickets.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = (select public.current_profile_id()))
with check (
  id = (select public.current_profile_id())
  and auth_user_id = (select auth.uid())
);

-- Still NO client INSERT policy on profiles, per amendment A: row creation
-- happens in 0003's auth.users AFTER INSERT security definer trigger, which keeps
-- profile creation off the client entirely. A client that could insert its own
-- profile row could choose its own id and pre-empt a pending invitation.


-- -- organization_members -----------------------------------------------------
-- Matrix: admin RW, manager R, owner R, tenant R self, provider R self.
-- No INSERT policy: invitations route through 0003's `invite_member` and
-- `accept_invitation` RPCs (finding 8).

-- AC1. Every role reads its own membership row. This is the trusted source for
-- server-side organization and role resolution, so a client-supplied
-- organization_id is never needed or believed.
drop policy if exists organization_members_select_self on public.organization_members;
create policy organization_members_select_self
on public.organization_members
for select
to authenticated
using (profile_id = (select public.current_profile_id()));

-- AC1, AC2. Admins, managers and owners see the member roster of their own
-- organizations only. Tenants and providers are excluded here and fall back to
-- the self policy above.
drop policy if exists organization_members_select_staff on public.organization_members;
create policy organization_members_select_staff
on public.organization_members
for select
to authenticated
using (
  (select public.has_org_role(
     organization_id,
     array['organization_admin', 'property_manager', 'property_owner']::public.member_role[]
   ))
);

-- AC1. Only an organization_admin changes a member's role or status, and only
-- within an organization where they are themselves an admin. `with check`
-- re-tests the predicate against the new row, so a membership cannot be moved
-- into another organization (AC2).
drop policy if exists organization_members_update_admin on public.organization_members;
create policy organization_members_update_admin
on public.organization_members
for update
to authenticated
using (
  (select public.has_org_role(
     organization_id, array['organization_admin']::public.member_role[]
   ))
)
with check (
  (select public.has_org_role(
     organization_id, array['organization_admin']::public.member_role[]
   ))
);


-- -- properties ---------------------------------------------------------------
-- Matrix: admin RWA, manager RWA, owner R owned, tenant R via tenancy,
--         provider R via assigned ticket.

-- AC2, AC3. Staff read the whole portfolio of their own organization.
drop policy if exists properties_select_staff on public.properties;
create policy properties_select_staff
on public.properties
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC2. A property owner reads only the properties recorded against their own
-- membership row — not the rest of the organization's portfolio.
drop policy if exists properties_select_owner on public.properties;
create policy properties_select_owner
on public.properties
for select
to authenticated
using ((select public.owns_property(organization_id, id)));

-- AC5. A tenant reads only the property containing a unit they actively lease,
-- which is the context they need in order to raise a ticket.
drop policy if exists properties_select_tenant on public.properties;
create policy properties_select_tenant
on public.properties
for select
to authenticated
using (
  exists (
    select 1
    from public.property_units u
    where u.organization_id = properties.organization_id
      and u.property_id = properties.id
      and (select public.can_access_unit(properties.organization_id, u.id))
  )
);

-- AC7. A service provider reads only the property behind a job assigned to them.
drop policy if exists properties_select_provider on public.properties;
create policy properties_select_provider
on public.properties
for select
to authenticated
using (
  exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = properties.organization_id
      and k.property_id = properties.id
      and k.assigned_provider_id = (select public.current_provider_id(properties.organization_id))
  )
);

-- AC3. Only staff create properties, and only inside their own organization — a
-- client-supplied organization_id belonging to another tenant fails the check
-- (AC2).
drop policy if exists properties_insert_staff on public.properties;
create policy properties_insert_staff
on public.properties
for insert
to authenticated
with check ((select public.is_org_staff(organization_id)));

-- AC3. Staff update and archive (status -> 'archived'). `using` proves the old
-- row is theirs; `with check` proves the new row still is, so a row cannot be
-- pushed across an organization boundary (AC2). No DELETE policy: archive only.
drop policy if exists properties_update_staff on public.properties;
create policy properties_update_staff
on public.properties
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));


-- -- property_units -----------------------------------------------------------
-- Matrix: admin RWA, manager RWA, owner R owned, tenant R leased,
--         provider R via assigned ticket.

-- AC2, AC3.
drop policy if exists property_units_select_staff on public.property_units;
create policy property_units_select_staff
on public.property_units
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC2. An owner sees the units of owned properties only.
drop policy if exists property_units_select_owner on public.property_units;
create policy property_units_select_owner
on public.property_units
for select
to authenticated
using ((select public.owns_property(organization_id, property_id)));

-- AC5. A tenant sees exactly the unit they actively lease.
drop policy if exists property_units_select_tenant on public.property_units;
create policy property_units_select_tenant
on public.property_units
for select
to authenticated
using ((select public.can_access_unit(organization_id, id)));

-- AC7. A provider sees only the unit behind a job assigned to them.
drop policy if exists property_units_select_provider on public.property_units;
create policy property_units_select_provider
on public.property_units
for select
to authenticated
using (
  exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = property_units.organization_id
      and k.property_unit_id = property_units.id
      and k.assigned_provider_id = (select public.current_provider_id(property_units.organization_id))
  )
);

-- AC3. The composite foreign key on (organization_id, property_id) already makes
-- a cross-organization parent impossible; this adds the role requirement.
drop policy if exists property_units_insert_staff on public.property_units;
create policy property_units_insert_staff
on public.property_units
for insert
to authenticated
with check ((select public.is_org_staff(organization_id)));

-- AC3. Update and archive (status -> 'inactive'). No DELETE policy.
drop policy if exists property_units_update_staff on public.property_units;
create policy property_units_update_staff
on public.property_units
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));


-- -- tenants ------------------------------------------------------------------
-- Matrix: admin RW, manager RW, owner —, tenant R self only,
--         provider R name only via assignment.
-- This table holds the personal data that finding 3 exposed organization-wide.

-- AC2, AC4. Staff manage tenant records for their own organization.
drop policy if exists tenants_select_staff on public.tenants;
create policy tenants_select_staff
on public.tenants
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- Goal 2: a tenant cannot see another tenant's personal data. Exactly one row is
-- visible — their own. Property owners get no policy on this table at all.
drop policy if exists tenants_select_self on public.tenants;
create policy tenants_select_self
on public.tenants
for select
to authenticated
using (profile_id = (select public.current_profile_id()));

-- AC7. A provider may see the tenant behind a job assigned to them, so they know
-- whom to contact. The matrix narrows this to the tenant's NAME; a row-level
-- policy cannot express a column subset, so the column projection
-- (id, organization_id, full_name) is enforced in the provider read path by
-- w0-l5/w1-l4. RLS here is the floor, not the whole control.
drop policy if exists tenants_select_provider_assigned on public.tenants;
create policy tenants_select_provider_assigned
on public.tenants
for select
to authenticated
using (
  exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = tenants.organization_id
      and k.tenant_id = tenants.id
      and k.assigned_provider_id = (select public.current_provider_id(tenants.organization_id))
  )
);

-- AC4.
drop policy if exists tenants_insert_staff on public.tenants;
create policy tenants_insert_staff
on public.tenants
for insert
to authenticated
with check ((select public.is_org_staff(organization_id)));

-- AC4. No DELETE policy: a tenant record is history, not scratch data.
drop policy if exists tenants_update_staff on public.tenants;
create policy tenants_update_staff
on public.tenants
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));


-- -- tenancies ----------------------------------------------------------------
-- Matrix: admin RW, manager RW, owner R owned, tenant R own, provider —.

-- AC4.
drop policy if exists tenancies_select_staff on public.tenancies;
create policy tenancies_select_staff
on public.tenancies
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC2. An owner sees the tenancies on units of properties they own, and no
-- others.
drop policy if exists tenancies_select_owner on public.tenancies;
create policy tenancies_select_owner
on public.tenancies
for select
to authenticated
using (
  exists (
    select 1
    from public.property_units u
    where u.organization_id = tenancies.organization_id
      and u.id = tenancies.property_unit_id
      and (select public.owns_property(tenancies.organization_id, u.property_id))
  )
);

-- Goal 2. A tenant sees their own tenancy and provably not another's —
-- including rent amount and contract number, which are personal financial data.
drop policy if exists tenancies_select_own on public.tenancies;
create policy tenancies_select_own
on public.tenancies
for select
to authenticated
using (tenant_id = (select public.current_tenant_id(organization_id)));

-- AC4. Service providers get no policy on this table in any operation.
drop policy if exists tenancies_insert_staff on public.tenancies;
create policy tenancies_insert_staff
on public.tenancies
for insert
to authenticated
with check ((select public.is_org_staff(organization_id)));

-- AC4. Lifecycle transitions draft -> active -> expired/terminated happen here.
-- No DELETE policy: a terminated tenancy is archived, never removed (finding 5).
drop policy if exists tenancies_update_staff on public.tenancies;
create policy tenancies_update_staff
on public.tenancies
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));


-- -- service_providers --------------------------------------------------------
-- Matrix: admin RW, manager RW, owner —, tenant —, provider R self.

-- AC6. Staff read the provider directory in order to assign work.
drop policy if exists service_providers_select_staff on public.service_providers;
create policy service_providers_select_staff
on public.service_providers
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC7. A provider reads their own record only — not the competitor list.
drop policy if exists service_providers_select_self on public.service_providers;
create policy service_providers_select_self
on public.service_providers
for select
to authenticated
using (profile_id = (select public.current_profile_id()));

-- AC6.
drop policy if exists service_providers_insert_staff on public.service_providers;
create policy service_providers_insert_staff
on public.service_providers
for insert
to authenticated
with check ((select public.is_org_staff(organization_id)));

-- AC6. Includes deactivation (status -> 'inactive'). No DELETE policy.
drop policy if exists service_providers_update_staff on public.service_providers;
create policy service_providers_update_staff
on public.service_providers
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));


-- -- maintenance_tickets ------------------------------------------------------
-- Matrix: admin RW, manager RW, owner R owned, tenant CR own + confirm
--         completion, provider R + U assigned only, within a status subset.
-- Closes finding 4.

-- AC6. Staff triage, prioritize and assign across their own organization.
drop policy if exists maintenance_tickets_select_staff on public.maintenance_tickets;
create policy maintenance_tickets_select_staff
on public.maintenance_tickets
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC2. An owner sees tickets on owned properties only.
drop policy if exists maintenance_tickets_select_owner on public.maintenance_tickets;
create policy maintenance_tickets_select_owner
on public.maintenance_tickets
for select
to authenticated
using ((select public.owns_property(organization_id, property_id)));

-- AC5. The reporting tenant sees their own tickets and no one else's.
drop policy if exists maintenance_tickets_select_own_tenant on public.maintenance_tickets;
create policy maintenance_tickets_select_own_tenant
on public.maintenance_tickets
for select
to authenticated
using (tenant_id = (select public.current_tenant_id(organization_id)));

-- AC7 and finding 4. The provider isolation policy: a service provider sees
-- exactly the tickets whose assigned_provider_id is their own provider record,
-- and zero unassigned or otherwise-assigned work. `current_provider_id` returns
-- null for a non-provider or a deactivated provider, and `= null` matches no row.
drop policy if exists maintenance_tickets_select_assigned_provider on public.maintenance_tickets;
create policy maintenance_tickets_select_assigned_provider
on public.maintenance_tickets
for select
to authenticated
using (assigned_provider_id = (select public.current_provider_id(organization_id)));

-- AC6. Staff may raise a ticket on behalf of a tenant (source 'admin').
drop policy if exists maintenance_tickets_insert_staff on public.maintenance_tickets;
create policy maintenance_tickets_insert_staff
on public.maintenance_tickets
for insert
to authenticated
with check ((select public.is_org_staff(organization_id)));

-- AC5 and AC8. A tenant may create a ticket ONLY for a unit they actively lease,
-- only in their own name, only in the initial 'open' state, and never
-- pre-assigned. The final clause rejects a unit that does not belong to the
-- stated property — the 0001 foreign keys validate those two references
-- independently but not their consistency with each other.
-- This is also the gate that keeps AI intake honest: the confirm route creates
-- the ticket as the authenticated tenant, so model output cannot widen its
-- reach (CLAUDE.md rule 7).
drop policy if exists maintenance_tickets_insert_tenant on public.maintenance_tickets;
create policy maintenance_tickets_insert_tenant
on public.maintenance_tickets
for insert
to authenticated
with check (
  tenant_id = (select public.current_tenant_id(organization_id))
  and (select public.can_access_unit(organization_id, property_unit_id))
  and status = 'open'::public.ticket_status
  and assigned_provider_id is null
  and (select public.unit_belongs_to_property(organization_id, property_unit_id, property_id))
);

-- AC6. Staff own triage, priority and assignment. `with check` keeps the row in
-- the same organization (AC2); 0003's triggers additionally assert that
-- assigned_provider_id belongs to the ticket's organization and that the status
-- transition is legal.
drop policy if exists maintenance_tickets_update_staff on public.maintenance_tickets;
create policy maintenance_tickets_update_staff
on public.maintenance_tickets
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));

-- AC7. A provider may drive only its own assigned job, and only within the
-- status subset assigned -> in_progress -> awaiting_approval. `using` bounds the
-- states they may act from; `with check` bounds the states they may write — so a
-- provider can never close a ticket to 'completed', cancel it, or hand it to
-- another provider. Exact transition legality is enforced again by 0003's
-- trigger.
drop policy if exists maintenance_tickets_update_assigned_provider on public.maintenance_tickets;
create policy maintenance_tickets_update_assigned_provider
on public.maintenance_tickets
for update
to authenticated
using (
  assigned_provider_id = (select public.current_provider_id(organization_id))
  and status in ('assigned'::public.ticket_status, 'in_progress'::public.ticket_status)
)
with check (
  assigned_provider_id = (select public.current_provider_id(organization_id))
  and status in ('in_progress'::public.ticket_status, 'awaiting_approval'::public.ticket_status)
);

-- AC5, AC10. The reporting tenant confirms completion: the single transition
-- awaiting_approval -> completed on their own ticket, and nothing else.
drop policy if exists maintenance_tickets_update_tenant_confirm on public.maintenance_tickets;
create policy maintenance_tickets_update_tenant_confirm
on public.maintenance_tickets
for update
to authenticated
using (
  tenant_id = (select public.current_tenant_id(organization_id))
  and status = 'awaiting_approval'::public.ticket_status
)
with check (
  tenant_id = (select public.current_tenant_id(organization_id))
  and status = 'completed'::public.ticket_status
);

-- AC5. Amendment D. The reporting tenant may withdraw their own request, but
-- only while it is still `open` — once a provider has been assigned, cancelling
-- is a manager decision. `using` pins the ticket to the caller and to the
-- `open` state; `with check` permits exactly one destination state. This is the
-- tenant's only other write path, and it matches the 0003 state machine ruling:
-- cancel is admin/manager from any non-terminal state, the reporting tenant only
-- while open, and never a provider or an owner.
drop policy if exists maintenance_tickets_update_tenant_cancel on public.maintenance_tickets;
create policy maintenance_tickets_update_tenant_cancel
on public.maintenance_tickets
for update
to authenticated
using (
  tenant_id = (select public.current_tenant_id(organization_id))
  and status = 'open'::public.ticket_status
)
with check (
  tenant_id = (select public.current_tenant_id(organization_id))
  and status = 'cancelled'::public.ticket_status
  and assigned_provider_id is null
);

-- No DELETE policy. A ticket is cancelled, never deleted (finding 5).


-- -- maintenance_activities ---------------------------------------------------
-- Matrix: admin R, manager CR, owner R owned, tenant CR own tickets,
--         provider CR assigned tickets.
-- UPDATE and DELETE are revoked from client roles in §4 above (finding 6) and
-- 0003's trigger extends that immutability to service-role. There is
-- deliberately no UPDATE and no DELETE policy here either — belt and braces.
-- Read visibility mirrors ticket visibility one for one.

-- AC10. Admin and manager read the full history for their organization.
drop policy if exists maintenance_activities_select_staff on public.maintenance_activities;
create policy maintenance_activities_select_staff
on public.maintenance_activities
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC2, AC10. An owner reads the history of tickets on owned properties.
drop policy if exists maintenance_activities_select_owner on public.maintenance_activities;
create policy maintenance_activities_select_owner
on public.maintenance_activities
for select
to authenticated
using (
  exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = maintenance_activities.organization_id
      and k.id = maintenance_activities.ticket_id
      and (select public.owns_property(maintenance_activities.organization_id, k.property_id))
  )
);

-- AC5, AC10. A tenant reads the timeline of their own tickets only.
drop policy if exists maintenance_activities_select_tenant on public.maintenance_activities;
create policy maintenance_activities_select_tenant
on public.maintenance_activities
for select
to authenticated
using (
  exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = maintenance_activities.organization_id
      and k.id = maintenance_activities.ticket_id
      and k.tenant_id = (select public.current_tenant_id(maintenance_activities.organization_id))
  )
);

-- AC7, AC10. A provider reads the timeline of assigned jobs only.
drop policy if exists maintenance_activities_select_provider on public.maintenance_activities;
create policy maintenance_activities_select_provider
on public.maintenance_activities
for select
to authenticated
using (
  exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = maintenance_activities.organization_id
      and k.id = maintenance_activities.ticket_id
      and k.assigned_provider_id = (select public.current_provider_id(maintenance_activities.organization_id))
  )
);

-- AC10. A manager appends an activity row, always in their own name. Forging
-- another actor is rejected, which is what makes the history evidential.
-- Per the §4 matrix organization_admin has R and not C on this table;
-- admin-side state changes are recorded in audit_logs by 0003's log_audit().
drop policy if exists maintenance_activities_insert_manager on public.maintenance_activities;
create policy maintenance_activities_insert_manager
on public.maintenance_activities
for insert
to authenticated
with check (
  (select public.has_org_role(
     organization_id, array['property_manager']::public.member_role[]
   ))
  and actor_profile_id = (select public.current_profile_id())
);

-- AC10. Amendment C. An organization_admin appends on the same terms as a
-- property_manager. The §4 matrix originally gave admin R without C, but an admin
-- has RW on maintenance_tickets, so an admin-performed transition would have been
-- unable to write its activity row — making the "immutable history of every
-- transition" silently mean "every transition except an admin's". Kept as a
-- separate per-role policy rather than widening the manager policy, so the matrix
-- stays readable row by row.
drop policy if exists maintenance_activities_insert_admin on public.maintenance_activities;
create policy maintenance_activities_insert_admin
on public.maintenance_activities
for insert
to authenticated
with check (
  (select public.has_org_role(
     organization_id, array['organization_admin']::public.member_role[]
   ))
  and actor_profile_id = (select public.current_profile_id())
);

-- AC5, AC10. A tenant appends to their own tickets only, in their own name.
drop policy if exists maintenance_activities_insert_tenant on public.maintenance_activities;
create policy maintenance_activities_insert_tenant
on public.maintenance_activities
for insert
to authenticated
with check (
  actor_profile_id = (select public.current_profile_id())
  and exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = maintenance_activities.organization_id
      and k.id = maintenance_activities.ticket_id
      and k.tenant_id = (select public.current_tenant_id(maintenance_activities.organization_id))
  )
);

-- AC7, AC10. A provider appends to assigned jobs only, in their own name.
drop policy if exists maintenance_activities_insert_provider on public.maintenance_activities;
create policy maintenance_activities_insert_provider
on public.maintenance_activities
for insert
to authenticated
with check (
  actor_profile_id = (select public.current_profile_id())
  and exists (
    select 1
    from public.maintenance_tickets k
    where k.organization_id = maintenance_activities.organization_id
      and k.id = maintenance_activities.ticket_id
      and k.assigned_provider_id = (select public.current_provider_id(maintenance_activities.organization_id))
  )
);


-- -- documents ----------------------------------------------------------------
-- Matrix (as amended, B): admin RW, manager RW, owner R owned,
--         tenant R own tenancy, provider CR on assigned-ticket evidence only.

-- AC9. Staff read and manage documents for their own organization.
drop policy if exists documents_select_staff on public.documents;
create policy documents_select_staff
on public.documents
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC2. An owner reads documents attached to a property they own, or to a tenancy
-- on a unit of a property they own.
drop policy if exists documents_select_owner on public.documents;
create policy documents_select_owner
on public.documents
for select
to authenticated
using (
  (property_id is not null
    and (select public.owns_property(organization_id, property_id)))
  or exists (
    select 1
    from public.tenancies tn
    join public.property_units u
      on u.organization_id = tn.organization_id
     and u.id = tn.property_unit_id
    where tn.organization_id = documents.organization_id
      and tn.id = documents.tenancy_id
      and (select public.owns_property(documents.organization_id, u.property_id))
  )
);

-- Goal 2. A tenant reads documents for their own tenancy only — never another
-- tenant's contract. Documents with no tenancy link are invisible to tenants.
drop policy if exists documents_select_own_tenancy on public.documents;
create policy documents_select_own_tenancy
on public.documents
for select
to authenticated
using (
  tenancy_id is not null
  and exists (
    select 1
    from public.tenancies tn
    where tn.organization_id = documents.organization_id
      and tn.id = documents.tenancy_id
      and tn.tenant_id = (select public.current_tenant_id(documents.organization_id))
  )
);

-- AC9. Staff register an uploaded document, always in their own name. New rows
-- are 'pending' by the column default; this policy neither asserts nor can
-- assert verification — see documents_update_staff.
drop policy if exists documents_insert_staff on public.documents;
create policy documents_insert_staff
on public.documents
for insert
to authenticated
with check (
  (select public.is_org_staff(organization_id))
  and uploaded_by = (select public.current_profile_id())
);

-- AC9. Human verification happens here and only here: extraction writes
-- 'pending' fields and an authenticated staff member moves verification_status
-- to 'verified' or 'rejected'. No model output path reaches this UPDATE without
-- that human action (CLAUDE.md rule 7).
-- No DELETE policy: a document is a record.
drop policy if exists documents_update_staff on public.documents;
create policy documents_update_staff
on public.documents
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));

-- -- documents: the service_provider evidence policies (amendment B) ----------
--
-- ORDERING DEPENDENCY — READ THIS BEFORE APPLYING.
--
-- These two policies scope a provider to `documents.ticket_id`, a column that
-- migration 0003 adds. Migrations apply in ascending order, so on a FRESH
-- database 0002 runs BEFORE that column exists and the policies cannot be
-- created yet. Of the two options offered, this lane chose to GUARD the creation
-- rather than declare that 0002 requires 0003 — because "0002 requires 0003" is
-- unsatisfiable when 0002 runs first.
--
-- Consequences, stated plainly so nobody discovers them on first apply:
--   * On a fresh 0001 -> 0002 -> 0003 apply the guard is FALSE. The two policies
--     are NOT created, and a `raise warning` says so in the migration output.
--     The failure mode is fail-closed: a provider simply cannot upload evidence.
--     It is a functionality gap, never an access leak.
--   * The fix is one line in 0003, AFTER it adds the column:
--         select public.ensure_document_provider_policies();
--     That function is defined here so w0-l3 does not have to re-implement the
--     policies, and so the predicate lives in exactly one file — this one.
--   * The self-check in §7 fails the migration if the column exists while the
--     policies do not, so the gap cannot survive once 0003 has landed.
--
-- This is reported to the orchestrator as a residual ordering defect: the clean
-- resolution is the one-line call in 0003, or moving these two policies into a
-- later migration. It is NOT resolved by this file alone.

create or replace function public.ensure_document_provider_policies()
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'documents'
      and a.attname = 'ticket_id'
      and a.attnum > 0
      and not a.attisdropped
  ) then
    raise warning 'migration 0002: public.documents.ticket_id does not exist yet, so the service_provider evidence policies were NOT created. 0003 must add the column and then call: select public.ensure_document_provider_policies();';
    return;
  end if;

  -- AC7, AC9. A provider reads ONLY documents attached to a ticket assigned to
  -- them. The `ticket_id is not null` clause is what keeps a provider out of
  -- tenancy contracts and property documents: those rows have a null ticket_id,
  -- so they can never satisfy this predicate. A provider must never reach a
  -- tenancy contract.
  execute $p$drop policy if exists documents_select_provider_assigned on public.documents$p$;
  execute $p$
    create policy documents_select_provider_assigned
    on public.documents
    for select
    to authenticated
    using (
      ticket_id is not null
      and exists (
        select 1
        from public.maintenance_tickets k
        where k.organization_id = documents.organization_id
          and k.id = documents.ticket_id
          and k.assigned_provider_id = (select public.current_provider_id(documents.organization_id))
      )
    )
  $p$;

  -- AC7, AC9, AC10. A provider uploads completion evidence against an assigned
  -- ticket, in their own name. property_id and tenancy_id are forced null: a
  -- provider must not be able to staple their row onto an arbitrary tenancy or
  -- property in the organization, which would expose it to that tenancy's tenant
  -- and that property's owner through the policies above. Evidence is
  -- ticket-scoped and nothing else.
  execute $p$drop policy if exists documents_insert_provider_assigned on public.documents$p$;
  execute $p$
    create policy documents_insert_provider_assigned
    on public.documents
    for insert
    to authenticated
    with check (
      uploaded_by = (select public.current_profile_id())
      and ticket_id is not null
      and property_id is null
      and tenancy_id is null
      and exists (
        select 1
        from public.maintenance_tickets k
        where k.organization_id = documents.organization_id
          and k.id = documents.ticket_id
          and k.assigned_provider_id = (select public.current_provider_id(documents.organization_id))
      )
    )
  $p$;
end
$fn$;

-- This function creates policies, so it must never be reachable from a client
-- session. Revoked from PUBLIC (the default grant), anon and authenticated; only
-- the owner, which is the migration runner, may call it.
revoke all on function public.ensure_document_provider_policies() from public;
revoke all on function public.ensure_document_provider_policies() from anon, authenticated;

-- Attempt creation now. No-op with a warning on a fresh database; effective on
-- any apply where 0003 has already added the column.
select public.ensure_document_provider_policies();

-- A provider still gets no UPDATE and no DELETE on documents in any form: they
-- may add evidence and read it back, never revise or remove it.


-- -- ai_conversations ---------------------------------------------------------
-- Matrix: admin R, manager R, owner —, tenant CR own, provider —.

-- AC8. Staff may review AI intake transcripts for their organization. Read only:
-- a transcript is evidence of what the model was told and what it answered.
drop policy if exists ai_conversations_select_staff on public.ai_conversations;
create policy ai_conversations_select_staff
on public.ai_conversations
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC8. A tenant reads their own conversations only.
drop policy if exists ai_conversations_select_own_tenant on public.ai_conversations;
create policy ai_conversations_select_own_tenant
on public.ai_conversations
for select
to authenticated
using (
  user_profile_id = (select public.current_profile_id())
  and (select public.has_org_role(
         organization_id, array['tenant']::public.member_role[]
       ))
);

-- AC8. A tenant opens a conversation in their own name, in their own
-- organization. No UPDATE and no DELETE policy: from the client's point of view
-- the transcript is append-only.
drop policy if exists ai_conversations_insert_own_tenant on public.ai_conversations;
create policy ai_conversations_insert_own_tenant
on public.ai_conversations
for insert
to authenticated
with check (
  user_profile_id = (select public.current_profile_id())
  and (select public.has_org_role(
         organization_id, array['tenant']::public.member_role[]
       ))
);


-- -- ai_messages --------------------------------------------------------------
-- Matrix: admin R, manager R, owner —, tenant CR own, provider —.

-- AC8.
drop policy if exists ai_messages_select_staff on public.ai_messages;
create policy ai_messages_select_staff
on public.ai_messages
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- AC8. A tenant reads the messages of their own conversations only.
drop policy if exists ai_messages_select_own_tenant on public.ai_messages;
create policy ai_messages_select_own_tenant
on public.ai_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.ai_conversations c
    where c.organization_id = ai_messages.organization_id
      and c.id = ai_messages.conversation_id
      and c.user_profile_id = (select public.current_profile_id())
  )
);

-- AC8 and CLAUDE.md rule 7. A tenant may append only their OWN turn
-- (sender_type = 'user') to their OWN conversation. Assistant and system turns
-- are written server-side with the service-role client, so a client cannot forge
-- a model or system message that a later request would replay into the model
-- context as trusted instruction. No UPDATE and no DELETE policy.
drop policy if exists ai_messages_insert_own_tenant on public.ai_messages;
create policy ai_messages_insert_own_tenant
on public.ai_messages
for insert
to authenticated
with check (
  sender_type = 'user'
  and exists (
    select 1
    from public.ai_conversations c
    where c.organization_id = ai_messages.organization_id
      and c.id = ai_messages.conversation_id
      and c.user_profile_id = (select public.current_profile_id())
  )
);


-- -- notifications ------------------------------------------------------------
-- Matrix: R own, for every role.

-- AC10. A member reads only notifications addressed to them. There is no INSERT
-- policy: notifications are produced by server-side workflows through the
-- service-role client, so no client can fabricate one for another user. No
-- UPDATE and no DELETE policy.
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
on public.notifications
for select
to authenticated
using (recipient_profile_id = (select public.current_profile_id()));


-- -- audit_logs ---------------------------------------------------------------
-- Matrix: admin R. Every other role: nothing. Closes finding 7.

-- AC2, AC10. Only an organization_admin reads the audit trail, and only for
-- their own organization: tenants, providers, owners and managers cannot see it
-- at all. INSERT, UPDATE and DELETE are revoked from client roles in §4 above,
-- so the trail is append-only and written exclusively by 0003's log_audit()
-- security definer helper or by the service-role client.
drop policy if exists audit_logs_select_admin on public.audit_logs;
create policy audit_logs_select_admin
on public.audit_logs
for select
to authenticated
using (
  (select public.has_org_role(
     organization_id, array['organization_admin']::public.member_role[]
   ))
);


-- =============================================================================
-- 6. Storage: one private bucket, organization derived from path segment 1
-- =============================================================================
-- Frozen in parallel-execution-plan.md §5.7 and implementation-plan.md §4:
-- object path `{organization_id}/{entity}/{uuid}.pdf`, application/pdf only,
-- 10 MB cap, signed URLs with a 60 second TTL issued server-side. No public
-- bucket exists anywhere in this project.
--
-- Bucket id 'documents'. NOTE: the bucket name is not listed in the §5 interface
-- freeze. This lane fixes it here and reports it as a planning defect so the
-- orchestrator can propagate the value to w1-l6 and w0-l6 rather than have each
-- lane guess.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760, array['application/pdf'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = 10485760,
      allowed_mime_types = array['application/pdf'];

-- Path segment 1 is the organization id. It is attacker-controlled text, so it is
-- validated against the uuid shape inside a CASE before being cast: CASE
-- guarantees evaluation order, so a malformed prefix yields NULL rather than a
-- cast error, and `is_org_member(null)` is false. A boolean AND guard would not
-- guarantee that ordering.

-- AC2, AC9. Reading an object — which is what issuing a signed URL checks —
-- requires active membership of the organization owning path segment 1.
-- Organization B's administrator cannot sign a URL for organization A's
-- contract, and an expired or forged path resolves to no membership.
drop policy if exists documents_objects_select_member on storage.objects;
create policy documents_objects_select_member
on storage.objects
for select
to authenticated
using (
  bucket_id = 'documents'
  and (select public.is_org_member(
    case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
    end
  ))
);

-- AC9. Uploading requires active membership of the organization in segment 1,
-- and the object must sit at exactly {organization_id}/{entity}/ and end in
-- `.pdf`. The depth check stops an object being parked at the bucket root, where
-- no organization could be derived from it.
drop policy if exists documents_objects_insert_member on storage.objects;
create policy documents_objects_insert_member
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'documents'
  and array_length(storage.foldername(name), 1) = 2
  and name like '%.pdf'
  and (select public.is_org_member(
    case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
    end
  ))
);

-- AC9. Overwriting an existing object is a staff action: a tenant or a provider
-- must not be able to replace a stored contract or a piece of completion
-- evidence after the fact. Both clauses pin the object to the same organization,
-- so an object cannot be moved across the tenant boundary (AC2).
drop policy if exists documents_objects_update_staff on storage.objects;
create policy documents_objects_update_staff
on storage.objects
for update
to authenticated
using (
  bucket_id = 'documents'
  and (select public.is_org_staff(
    case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
    end
  ))
)
with check (
  bucket_id = 'documents'
  and array_length(storage.foldername(name), 1) = 2
  and name like '%.pdf'
  and (select public.is_org_staff(
    case
      when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        then ((storage.foldername(name))[1])::uuid
    end
  ))
);

-- No DELETE policy on storage.objects for this bucket: stored documents are
-- retained, consistent with the no-hard-delete rule (finding 5).


-- =============================================================================
-- 7. Self-check — fail the migration loudly rather than ship a hole
-- =============================================================================
-- Cheap, idempotent assertions that the defects this file exists to close are in
-- fact closed. If a future migration disables RLS, or reintroduces a `for all`
-- or DELETE policy on a tenant-scoped table, this block stops the deploy.

do $check$
declare
  missing   text;
  offending text;
  scoped    text[] := array[
    'organizations', 'profiles', 'organization_members', 'properties',
    'property_units', 'tenants', 'tenancies', 'service_providers',
    'maintenance_tickets', 'maintenance_activities', 'documents',
    'ai_conversations', 'ai_messages', 'notifications', 'audit_logs'
  ];
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (scoped)
    and c.relrowsecurity is false;

  if missing is not null then
    raise exception
      'migration 0002: row level security is not enabled on: %', missing;
  end if;

  select string_agg(format('%s.%s', p.tablename, p.policyname), ', ' order by p.policyname)
    into offending
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = any (scoped)
    and p.cmd in ('DELETE', 'ALL');

  if offending is not null then
    raise exception
      'migration 0002: DELETE or FOR ALL policy present on a tenant-scoped table: %', offending;
  end if;

  -- Finding 11. TRUNCATE bypasses RLS entirely, so a single grant here voids
  -- every policy in this file at once. This is the assertion that would have
  -- caught the original hole on the very first apply, and it is deliberately
  -- stricter than the revoke above in two ways: it covers EVERY table in
  -- `public` rather than the 15 known tenant-scoped ones, and it tests the
  -- EFFECTIVE privilege via has_table_privilege, so a grant inherited through
  -- PUBLIC or through role membership is caught and not just a direct grant.
  -- Only roles that actually exist are probed, because has_table_privilege
  -- errors on an unknown role name.
  select string_agg(format('%s(%s)', t.relname, t.who), ', ' order by t.relname, t.who)
    into offending
  from (
    select c.relname, g.rolname as who
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace ns on ns.oid = c.relnamespace
    cross join (
      select rolname
      from pg_catalog.pg_roles
      where rolname in ('authenticated', 'anon')
    ) g
    where ns.nspname = 'public'
      and c.relkind in ('r', 'p')
      and pg_catalog.has_table_privilege(g.rolname, c.oid, 'TRUNCATE')
  ) t;

  if offending is not null then
    raise exception
      'migration 0002: TRUNCATE is still granted in schema public, which bypasses RLS and voids every policy in this migration: %', offending;
  end if;

  -- Amendment B, ordering guard. Once 0003 has added documents.ticket_id there is
  -- no excuse for the provider evidence policies to be missing, so from that
  -- moment on their absence is a hard failure rather than a warning.
  if exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'documents'
      and a.attname = 'ticket_id'
      and a.attnum > 0
      and not a.attisdropped
  ) then
    select string_agg(want, ', ' order by want)
      into offending
    from unnest(array[
      'documents_select_provider_assigned',
      'documents_insert_provider_assigned'
    ]) as want
    where not exists (
      select 1
      from pg_policies p2
      where p2.schemaname = 'public'
        and p2.tablename = 'documents'
        and p2.policyname = want
    );

    if offending is not null then
      raise exception
        'migration 0002: documents.ticket_id exists but the service_provider evidence policies are missing: %. Call select public.ensure_document_provider_policies();', offending;
    end if;
  end if;
end
$check$;


-- =============================================================================
-- End of migration 0002.
-- =============================================================================
