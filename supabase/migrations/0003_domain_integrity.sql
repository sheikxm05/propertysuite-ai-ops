-- ============================================================================
-- 0003_domain_integrity.sql
--
-- Domain integrity for the PropertySuite AI Operations Assistant.
--
-- This migration is deliberately disjoint from 0002_rls_hardening.sql: 0002 owns
-- row-level security policies and the policy helper functions; 0003 owns triggers,
-- security-definer RPCs, structural schema fixes and the job queue. Nothing here
-- creates, drops or alters a policy.
--
-- Closes findings 6, 8, 9 and 10 of docs/implementation-plan.md §3, and encodes the
-- ticket state machine of §4.
--
-- Depends on, and only on, the frozen SQL helper signatures of
-- docs/parallel-execution-plan.md §5.3, created by 0002:
--   public.has_org_role(org uuid, roles public.member_role[]) returns boolean
--   public.is_org_staff(org uuid)                            returns boolean
--   public.current_tenant_id(org uuid)                       returns uuid
--   public.current_provider_id(org uuid)                     returns uuid
-- plus public.current_profile_id() and public.is_org_member(uuid) from 0001.
-- Every reference lives inside a plpgsql body, so the names bind at call time, not
-- at migration time: this file applies even if 0002 is replayed after it.
--
-- Idempotent: safe to re-run against a database that already has it.
--
-- ---------------------------------------------------------------------------
-- Error contract — SQLSTATE to API error code (docs/parallel-execution-plan.md §5.2)
-- ---------------------------------------------------------------------------
--   P0001  -> CONFLICT         409  illegal state transition, consumed/expired
--                                   invitation, taken slug, cross-organization
--                                   provider assignment, immutable-row mutation
--   42501  -> FORBIDDEN        403  caller authenticated but lacks the role,
--                                   assignment or identity the action requires
--   28000  -> UNAUTHENTICATED  401  no authenticated session
--   22023  -> VALIDATION_ERROR 400  malformed argument that Zod should have caught
--
-- Every raised message begins with a stable snake_case token before the colon, so
-- the runtime layer can switch on the token rather than on prose. Messages never
-- contain document text, message bodies, tokens or personal data.
--
-- Trusted-context rule: role constraints enforced here apply only when there IS an
-- authenticated session (auth.uid() is not null). Migrations, seeds, the job runner
-- and the service-role client have no JWT; they remain bound by the structural rules
-- (state machine, immutability, organization integrity) but not by role checks,
-- which they perform server-side instead. Immutability of maintenance_activities is
-- the single exception: it binds everyone, including service-role.
-- ============================================================================


-- ============================================================================
-- 1. Structural schema fixes
-- ============================================================================

-- Finding 9 — properties.owner_member_id FK omits organization_id, so an owner from
-- organization B can be attached to a property in organization A. A composite
-- foreign key makes that structurally impossible rather than merely disallowed.
--
-- The composite target needs a matching unique key on organization_members, which
-- 0001 does not declare (it has unique (organization_id, profile_id), not (organization_id, id)).
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.organization_members'::regclass
      and c.conname = 'organization_members_org_id_key'
  ) then
    alter table public.organization_members
      add constraint organization_members_org_id_key unique (organization_id, id);
  end if;
end;
$$;

-- Drop the single-column owner FK, whatever auto-generated name it carries.
do $$
declare
  v_attnum smallint;
  v_constraint record;
begin
  select a.attnum into v_attnum
  from pg_attribute a
  where a.attrelid = 'public.properties'::regclass
    and a.attname = 'owner_member_id'
    and not a.attisdropped;

  if v_attnum is null then
    raise exception 'properties.owner_member_id is missing; 0001_initial_schema.sql did not apply';
  end if;

  for v_constraint in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.properties'::regclass
      and c.contype = 'f'
      and c.confrelid = 'public.organization_members'::regclass
      and c.conkey = array[v_attnum]::smallint[]
  loop
    execute format('alter table public.properties drop constraint %I', v_constraint.conname);
  end loop;
end;
$$;

-- Add the composite FK. owner_member_id stays nullable: under the default MATCH
-- SIMPLE semantics a null owner satisfies the constraint, so unowned properties
-- remain legal. Referential action is left as NO ACTION, matching 0001 — a member
-- row that still owns a property cannot be removed, which is the desired outcome
-- for a system that archives rather than deletes.
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.properties'::regclass
      and c.conname = 'properties_owner_member_org_fkey'
  ) then
    alter table public.properties
      add constraint properties_owner_member_org_fkey
      foreign key (organization_id, owner_member_id)
      references public.organization_members (organization_id, id);
  end if;
end;
$$;

-- Finding 10 — documents records extracted fields but not the source text, so adding
-- retrieval later would mean reprocessing every stored document. This column is the
-- seam: W1-L6 populates it during extraction. It is never logged and never returned
-- to a client wholesale.
alter table public.documents
  add column if not exists extracted_text text;

comment on column public.documents.extracted_text is
  'Raw text extracted from the stored object. Retrieval seam (finding 10). Never log this column; never include it in an error message or an audit row.';


-- ============================================================================
-- 2. Job queue — service-role only
-- ============================================================================

-- Bounded retries and dead-lettering per docs/requirements.md §7. No organization_id
-- column: jobs are infrastructure, not tenant data, and the payload carries whatever
-- scope the handler needs. RLS is enabled with NO policies at all, so every client
-- role — anon and authenticated alike — is denied by default. Only the service-role
-- key, which bypasses RLS, can touch this table.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null default '{}',
  idempotency_key text unique,
  attempts int not null default 0 check (attempts >= 0),
  next_run_at timestamptz,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'failed', 'dead', 'done')),
  last_error text,
  created_at timestamptz not null default now()
);

alter table public.jobs enable row level security;

-- Belt and braces: Supabase default privileges grant table access to anon and
-- authenticated on creation. RLS with no policies already denies them; revoking the
-- grants means a future accidental policy cannot silently open the queue either.
revoke all on table public.jobs from anon;
revoke all on table public.jobs from authenticated;

create index if not exists idx_jobs_due on public.jobs (status, next_run_at);

comment on table public.jobs is
  'Asynchronous job queue. RLS enabled with no policies: service-role access only. Bounded retries via attempts; terminal failure status is dead.';


-- ============================================================================
-- 3. Invitations
-- ============================================================================

-- Finding 8 is intentional: organizations and organization_members have no client
-- INSERT policy, so onboarding and invitation run through the security-definer RPCs
-- in section 6. accept_invitation(token) needs somewhere to hold the pending
-- invitation, and 0001 has no table for it — organization_members cannot carry it
-- because profile_id is NOT NULL and an invitee may not have signed up yet.
--
-- Only the hash of the token is stored, so a database read cannot be replayed as an
-- acceptance. The plaintext token is returned exactly once, to the caller of
-- invite_member.
--
-- Writes go only through the RPCs in section 6, which run as the table owner. Reads
-- are policy-governed: an organization_admin of the owning organization may list its
-- own invitations, so w1-l1 needs no extra RPC to render a pending-invitation list
-- (orchestrator ruling 2).
--
-- This is the only policy in 0003, and it is not a boundary crossing with 0002: 0002
-- owns policies on the tables 0001 created; this lane owns policies on the table it
-- introduced.
create table if not exists public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.member_role not null,
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked')),
  invited_by_profile_id uuid references public.profiles(id),
  accepted_profile_id uuid references public.profiles(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

alter table public.organization_invitations enable row level security;

revoke all on table public.organization_invitations from anon;
revoke all on table public.organization_invitations from authenticated;

-- Column-level SELECT, deliberately omitting token_hash. A SHA-256 hash of 256 bits
-- of entropy is not reversible, so this is not about secrecy: it makes "no client
-- ever reads the token column" structural rather than conventional. No route, view,
-- log line or `select *` can leak that column, and that stays true even if what the
-- column holds ever changes.
--
-- CONSUMER NOTE for w1-l1: `select *` on this table WILL fail with a permission
-- error. List invitations with exactly these columns:
--   id, organization_id, email, role, status, invited_by_profile_id,
--   accepted_profile_id, expires_at, accepted_at, created_at
grant select (
  id,
  organization_id,
  email,
  role,
  status,
  invited_by_profile_id,
  accepted_profile_id,
  expires_at,
  accepted_at,
  created_at
) on table public.organization_invitations to authenticated;

-- Acceptance criteria 1 and 2: an organization_admin sees only their own
-- organization's invitations; every other role, and every other organization, sees
-- nothing at all. No INSERT, UPDATE or DELETE policy exists, so every write still
-- goes through the audited RPCs. Helper call wrapped as (select ...) so the planner
-- caches it per statement instead of evaluating it per row.
drop policy if exists "organization admins can view their invitations" on public.organization_invitations;
create policy "organization admins can view their invitations"
on public.organization_invitations for select
using (
  (select public.has_org_role(organization_id, array['organization_admin']::public.member_role[]))
);

-- One live invitation per address per organization.
create unique index if not exists uq_invitations_pending
  on public.organization_invitations (organization_id, email)
  where status = 'pending';

create index if not exists idx_invitations_org
  on public.organization_invitations (organization_id, status, created_at desc);

comment on table public.organization_invitations is
  'Organization invitations. Written only by public.invite_member, public.accept_invitation and public.revoke_invitation; readable by an organization_admin of the owning organization, minus token_hash. Stores a SHA-256 hash of the token, never the token itself.';


-- ============================================================================
-- 4. Helper functions
-- ============================================================================

-- Audit-write helper for the RPCs below (acceptance criterion 10).
--
-- audit_logs.organization_id is NOT NULL but the briefed signature is
-- log_audit(action, entity_type, entity_id, metadata); the organization is therefore
-- accepted either as a fifth argument or as metadata.organization_id, so the
-- four-argument call spelling stays valid. Reported as a planning note.
--
-- audit_logs has a SELECT policy but no INSERT policy, by design, so this must be
-- security definer. An authenticated caller may only write an audit row for an
-- organization they are an active member of — otherwise any member could forge
-- another tenant's audit trail.
create or replace function public.log_audit(
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_metadata jsonb default '{}'::jsonb,
  p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  v_org := coalesce(p_organization_id, nullif(p_metadata ->> 'organization_id', '')::uuid);

  if v_org is null then
    raise exception 'audit_organization_required: pass the organization as the fifth argument or as metadata.organization_id'
      using errcode = '22023';
  end if;

  if auth.uid() is not null and not coalesce(public.is_org_member(v_org), false) then
    raise exception 'audit_forbidden: caller is not an active member of that organization'
      using errcode = '42501';
  end if;

  insert into public.audit_logs (
    organization_id, actor_profile_id, action, entity_type, entity_id, metadata
  )
  values (
    v_org,
    public.current_profile_id(),
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.log_audit(text, text, uuid, jsonb, uuid) is
  'Appends an audit row (acceptance criterion 10). Metadata must never contain document text, message bodies, tokens or personal data.';


-- Generic updated_at touch.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ============================================================================
-- 5. Triggers
-- ============================================================================

-- --------------------------------------------------------------------------
-- 5.1 maintenance_activities is append-only (finding 6)
-- --------------------------------------------------------------------------
-- 0002 revokes UPDATE and DELETE from authenticated. That stops clients; it does not
-- stop the service-role client, a migration or a psql session. A trigger does, which
-- is what makes "immutable history" a guarantee rather than an omission.
-- Deliberately has no auth.uid() escape hatch.
create or replace function public.block_activity_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'maintenance_activities_immutable: % is not permitted on maintenance_activities', tg_op
    using errcode = 'P0001',
          hint = 'Ticket history is append-only. Record a correcting activity row instead.';
end;
$$;

drop trigger if exists maintenance_activities_block_update on public.maintenance_activities;
create trigger maintenance_activities_block_update
  before update on public.maintenance_activities
  for each row execute function public.block_activity_mutation();

drop trigger if exists maintenance_activities_block_delete on public.maintenance_activities;
create trigger maintenance_activities_block_delete
  before delete on public.maintenance_activities
  for each row execute function public.block_activity_mutation();

-- A blocked DELETE is worthless if TRUNCATE still empties the table.
drop trigger if exists maintenance_activities_block_truncate on public.maintenance_activities;
create trigger maintenance_activities_block_truncate
  before truncate on public.maintenance_activities
  for each statement execute function public.block_activity_mutation();


-- --------------------------------------------------------------------------
-- 5.2 assigned_provider_id must belong to the ticket's organization
-- --------------------------------------------------------------------------
-- 0001 already declares a composite FK (organization_id, assigned_provider_id) ->
-- service_providers(organization_id, id), so this is defence in depth: it fails
-- earlier, with a message the API can map to a 409 instead of a raw FK violation,
-- and it keeps holding if that FK is ever relaxed.
--
-- security definer so the lookup is not filtered by RLS; the message is identical
-- whether the provider belongs to another organization or does not exist at all, so
-- the trigger cannot be used as a cross-tenant existence oracle.
create or replace function public.assert_ticket_provider_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider_org uuid;
begin
  if new.assigned_provider_id is null then
    return new;
  end if;

  select sp.organization_id
    into v_provider_org
  from public.service_providers sp
  where sp.id = new.assigned_provider_id;

  if v_provider_org is null or v_provider_org <> new.organization_id then
    raise exception 'ticket_provider_organization_mismatch: assigned_provider_id must reference a service provider in this organization'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists maintenance_tickets_assert_provider_org on public.maintenance_tickets;
create trigger maintenance_tickets_assert_provider_org
  before insert or update of organization_id, assigned_provider_id
  on public.maintenance_tickets
  for each row execute function public.assert_ticket_provider_organization();


-- --------------------------------------------------------------------------
-- 5.3 Ticket state machine (implementation-plan.md §4)
-- --------------------------------------------------------------------------
-- open -> assigned -> in_progress -> awaiting_approval -> completed, with cancelled
-- reachable from any non-terminal status. completed and cancelled are terminal.
-- This table must agree exactly with ALLOWED_TRANSITIONS in packages/shared.
--
--   from              | to
--   ------------------+--------------------------------
--   open              | assigned, cancelled
--   assigned          | in_progress, cancelled
--   in_progress       | awaiting_approval, cancelled
--   awaiting_approval | completed, cancelled
--   completed         | (terminal)
--   cancelled         | (terminal)
--
-- Role constraints, authenticated callers only:
--   * a service_provider may drive only assigned -> in_progress and
--     in_progress -> awaiting_approval, and only on a ticket assigned to them
--   * only organization_admin / property_manager (is_org_staff) or the reporting
--     tenant may close a ticket to completed
--
-- Structural validity is checked for every caller, service-role included. Illegal
-- transition raises P0001 (-> 409); a role violation raises 42501 (-> 403).
create or replace function public.enforce_ticket_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_valid boolean;
  v_is_staff boolean;
  v_is_provider boolean;
  v_is_reporting_tenant boolean;
begin
  -- A ticket never changes tenant. Without this an actor holding membership in two
  -- organizations could walk a record across the isolation boundary.
  if new.organization_id is distinct from old.organization_id then
    raise exception 'ticket_organization_immutable: a ticket cannot be moved between organizations'
      using errcode = 'P0001';
  end if;

  if new.status = old.status then
    return new;
  end if;

  v_valid := case old.status
    when 'open'              then new.status in ('assigned', 'cancelled')
    when 'assigned'          then new.status in ('in_progress', 'cancelled')
    when 'in_progress'       then new.status in ('awaiting_approval', 'cancelled')
    when 'awaiting_approval' then new.status in ('completed', 'cancelled')
    else false
  end;

  if not v_valid then
    raise exception 'ticket_status_transition_invalid: % -> % is not an allowed transition', old.status, new.status
      using errcode = 'P0001',
            hint = 'open -> assigned -> in_progress -> awaiting_approval -> completed; cancelled from any non-terminal status; completed and cancelled are terminal.';
  end if;

  -- Trusted server contexts carry no JWT. They are bound by the state machine above
  -- and by their own server-side authorization, not by the role rules below.
  if auth.uid() is null then
    return new;
  end if;

  v_is_staff := coalesce(public.is_org_staff(new.organization_id), false);
  v_is_provider := coalesce(
    public.has_org_role(new.organization_id, array['service_provider']::public.member_role[]),
    false
  );
  -- coalesce matters: current_tenant_id() returns null for a caller who is not a
  -- tenant, and an uncoalesced null would make the `completed` guard below evaluate
  -- to null, which IF treats as false — silently allowing the very transition the
  -- guard exists to block.
  v_is_reporting_tenant := coalesce(
    new.tenant_id is not null
      and new.tenant_id = public.current_tenant_id(new.organization_id),
    false
  );

  if v_is_provider and not v_is_staff then
    if not (
      (old.status = 'assigned'    and new.status = 'in_progress') or
      (old.status = 'in_progress' and new.status = 'awaiting_approval')
    ) then
      raise exception 'ticket_status_transition_forbidden_for_role: a service provider may not drive % -> %', old.status, new.status
        using errcode = '42501',
              hint = 'A service provider may only move a ticket assigned to them from assigned to in_progress and from in_progress to awaiting_approval.';
    end if;

    -- Acceptance criterion 7: a provider acts only on their own assigned work.
    if new.assigned_provider_id is null
       or new.assigned_provider_id is distinct from public.current_provider_id(new.organization_id) then
      raise exception 'ticket_status_transition_forbidden_for_role: only the assigned service provider may advance this ticket'
        using errcode = '42501';
    end if;
  end if;

  if new.status = 'completed' and not (v_is_staff or v_is_reporting_tenant) then
    raise exception 'ticket_status_transition_forbidden_for_role: only a manager or the reporting tenant may complete a ticket'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists maintenance_tickets_enforce_transition on public.maintenance_tickets;
create trigger maintenance_tickets_enforce_transition
  before update on public.maintenance_tickets
  for each row execute function public.enforce_ticket_transition();


-- The state machine starts at open. Without this, an insert could be used to jump
-- straight to completed and skip the machine entirely. Authenticated callers only,
-- so seeds and fixtures can still construct tickets in any status directly.
create or replace function public.enforce_ticket_initial_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if new.status <> 'open' then
    raise exception 'ticket_initial_status_invalid: a ticket must be created with status open, not %', new.status
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists maintenance_tickets_enforce_initial_status on public.maintenance_tickets;
create trigger maintenance_tickets_enforce_initial_status
  before insert on public.maintenance_tickets
  for each row execute function public.enforce_ticket_initial_status();


-- --------------------------------------------------------------------------
-- 5.4 updated_at touch triggers
-- --------------------------------------------------------------------------
drop trigger if exists properties_touch_updated_at on public.properties;
create trigger properties_touch_updated_at
  before update on public.properties
  for each row execute function public.touch_updated_at();

drop trigger if exists maintenance_tickets_touch_updated_at on public.maintenance_tickets;
create trigger maintenance_tickets_touch_updated_at
  before update on public.maintenance_tickets
  for each row execute function public.touch_updated_at();


-- ============================================================================
-- 6. Onboarding and invitation RPCs (finding 8)
-- ============================================================================
-- organizations and organization_members have no client INSERT policy on purpose.
-- These three functions are the only write path, each validating the caller from
-- trusted rows — never from an argument — and each writing an audit row.
--
-- All three return jsonb, so the shape PostgREST hands back is unambiguous:
--   create_organization -> { id, name, slug, status, created_at }
--   invite_member       -> { invitation_id, token, role, expires_at }
--   accept_invitation   -> { organization_id, member_id, role }

-- --------------------------------------------------------------------------
-- 6.1 create_organization
-- --------------------------------------------------------------------------
-- Creates the organization and makes the caller its organization_admin. The caller's
-- identity comes from auth.uid() via current_profile_id(); there is no argument by
-- which a caller could name someone else.
create or replace function public.create_organization(p_name text, p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_org public.organizations;
begin
  if auth.uid() is null then
    raise exception 'authentication_required: create_organization needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'organization_name_invalid: name must be 2 to 120 characters'
      using errcode = '22023';
  end if;

  if length(v_slug) < 2 or length(v_slug) > 63 or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'organization_slug_invalid: slug must be 2 to 63 lowercase alphanumeric characters, hyphen separated'
      using errcode = '22023';
  end if;

  begin
    insert into public.organizations (name, slug)
    values (v_name, v_slug)
    returning * into v_org;
  exception when unique_violation then
    raise exception 'organization_slug_taken: that slug is already in use'
      using errcode = 'P0001';
  end;

  insert into public.organization_members (organization_id, profile_id, role, status)
  values (v_org.id, v_profile, 'organization_admin', 'active');

  perform public.log_audit(
    'organization.created',
    'organization',
    v_org.id,
    jsonb_build_object('slug', v_org.slug, 'role', 'organization_admin'),
    v_org.id
  );

  return jsonb_build_object(
    'id', v_org.id,
    'name', v_org.name,
    'slug', v_org.slug,
    'status', v_org.status,
    'created_at', v_org.created_at
  );
end;
$$;

comment on function public.create_organization(text, text) is
  'Creates an organization and an active organization_admin membership for the authenticated caller. Only write path for public.organizations (finding 8).';


-- --------------------------------------------------------------------------
-- 6.2 invite_member
-- --------------------------------------------------------------------------
-- organization_admin only, verified against organization_members through the frozen
-- has_org_role helper — the org argument selects the target, it never grants access.
-- Returns the plaintext token once; only its hash is stored. The audit row records
-- the role but never the invitee's email address, which is personal data.
create or replace function public.invite_member(
  p_org uuid,
  p_email text,
  p_role public.member_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text;
  v_invitation_id uuid;
  v_expires_at timestamptz := now() + interval '7 days';
begin
  if auth.uid() is null then
    raise exception 'authentication_required: invite_member needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  if p_org is null or p_role is null then
    raise exception 'member_invite_invalid: organization and role are required'
      using errcode = '22023';
  end if;

  if not coalesce(
    public.has_org_role(p_org, array['organization_admin']::public.member_role[]),
    false
  ) then
    raise exception 'member_invite_forbidden: only an organization_admin may invite members'
      using errcode = '42501';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' or length(v_email) > 320 then
    raise exception 'member_email_invalid: a valid email address is required'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.organization_members m
    join public.profiles pr on pr.id = m.profile_id
    where m.organization_id = p_org
      and lower(pr.email) = v_email
      and m.status <> 'disabled'
  ) then
    raise exception 'member_already_exists: that address already has a membership in this organization'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.organization_invitations i
    where i.organization_id = p_org
      and i.email = v_email
      and i.status = 'pending'
      and i.expires_at > now()
  ) then
    raise exception 'invitation_already_pending: a live invitation for that address already exists'
      using errcode = 'P0001';
  end if;

  -- Retire any expired pending invitation so the partial unique index stays clean.
  update public.organization_invitations
     set status = 'revoked'
   where organization_id = p_org
     and email = v_email
     and status = 'pending';

  -- 256 bits of randomness from two gen_random_uuid() values, so no pgcrypto
  -- dependency and no assumption about which schema pgcrypto landed in. Only the
  -- SHA-256 hash is persisted.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.organization_invitations (
    organization_id, email, role, token_hash, invited_by_profile_id, expires_at
  )
  values (
    p_org,
    v_email,
    p_role,
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    v_profile,
    v_expires_at
  )
  returning id into v_invitation_id;

  perform public.log_audit(
    'member.invited',
    'organization_invitation',
    v_invitation_id,
    jsonb_build_object('role', p_role),
    p_org
  );

  return jsonb_build_object(
    'invitation_id', v_invitation_id,
    'token', v_token,
    'role', p_role,
    'expires_at', v_expires_at
  );
end;
$$;

comment on function public.invite_member(uuid, text, public.member_role) is
  'organization_admin only. Issues an invitation and returns its plaintext token exactly once; the table stores only a SHA-256 hash. Never log the returned token.';


-- --------------------------------------------------------------------------
-- 6.3 accept_invitation
-- --------------------------------------------------------------------------
-- The invited user only: the authenticated identity's verified email must match the
-- invitation. An unknown, consumed or expired token yields one indistinguishable
-- error, so the function is not a token or membership oracle.
create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile uuid;
  v_token text := btrim(coalesce(p_token, ''));
  v_caller_email text;
  v_invitation public.organization_invitations;
  v_member_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication_required: accept_invitation needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  if v_token = '' then
    raise exception 'invitation_invalid_or_expired: the invitation is not valid'
      using errcode = 'P0001';
  end if;

  select i.* into v_invitation
  from public.organization_invitations i
  where i.token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex')
  for update;

  if v_invitation.id is null
     or v_invitation.status <> 'pending'
     or v_invitation.expires_at <= now() then
    raise exception 'invitation_invalid_or_expired: the invitation is not valid'
      using errcode = 'P0001';
  end if;

  select lower(coalesce(u.email, pr.email, ''))
    into v_caller_email
  from public.profiles pr
  left join auth.users u on u.id = pr.auth_user_id
  where pr.id = v_profile;

  if coalesce(v_caller_email, '') <> v_invitation.email then
    raise exception 'invitation_recipient_mismatch: this invitation was issued to a different account'
      using errcode = '42501';
  end if;

  insert into public.organization_members (organization_id, profile_id, role, status)
  values (v_invitation.organization_id, v_profile, v_invitation.role, 'active')
  on conflict (organization_id, profile_id) do update
    set role = excluded.role,
        status = 'active'
  returning id into v_member_id;

  update public.organization_invitations
     set status = 'accepted',
         accepted_at = now(),
         accepted_profile_id = v_profile
   where id = v_invitation.id;

  perform public.log_audit(
    'invitation.accepted',
    'organization_member',
    v_member_id,
    jsonb_build_object('role', v_invitation.role),
    v_invitation.organization_id
  );

  return jsonb_build_object(
    'organization_id', v_invitation.organization_id,
    'member_id', v_member_id,
    'role', v_invitation.role
  );
end;
$$;

comment on function public.accept_invitation(text) is
  'Accepted by the invited user only: the authenticated account email must match the invitation. Activates the membership and consumes the invitation.';


-- ============================================================================
-- 7. Execute grants
-- ============================================================================
-- Functions are granted to PUBLIC by default. Revoke that, then grant deliberately.
-- anon gets nothing: every one of these requires an authenticated session.

revoke all on function public.log_audit(text, text, uuid, jsonb, uuid) from public;
revoke all on function public.create_organization(text, text) from public;
revoke all on function public.invite_member(uuid, text, public.member_role) from public;
revoke all on function public.accept_invitation(text) from public;

grant execute on function public.log_audit(text, text, uuid, jsonb, uuid) to authenticated, service_role;
grant execute on function public.create_organization(text, text) to authenticated, service_role;
grant execute on function public.invite_member(uuid, text, public.member_role) to authenticated, service_role;
grant execute on function public.accept_invitation(text) to authenticated, service_role;

-- The five trigger functions above are left at their default grants on purpose.
-- They return `trigger` and error out unless invoked from a trigger context, so a
-- direct call buys an attacker nothing, and narrowing their grants is not worth the
-- risk of interfering with trigger execution.
