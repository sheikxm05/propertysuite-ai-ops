-- =============================================================================
-- Migration 0005 — the unattributed inbound message, made visible without
--                  making it leakable
--
-- Lane: the defect reported by the inbox lane. Owns exactly one file: this one.
--
-- -----------------------------------------------------------------------------
-- THE DEFECT
-- -----------------------------------------------------------------------------
-- 0004 §5 made `public.inbound_messages.organization_id` nullable on purpose. A
-- WhatsApp number that resolves to zero tenants — or to two — is not attributed,
-- because attributing it by best effort is precisely the cross-tenant leak this
-- project exists to prevent. The row is written with a null organization and
-- status `'unmatched'`.
--
-- The only SELECT policy on that table is `inbound_messages_select_staff`, whose
-- first conjunct is `organization_id is not null`. So an unattributed row is
-- visible to NOBODY. It is written and then invisible — strictly worse than
-- dropping it, because the system looks like it handled something it did not.
--
-- -----------------------------------------------------------------------------
-- THE CHOICE, AND WHY — option (c)
-- -----------------------------------------------------------------------------
-- Chosen: **build the platform-operator plane for real, as a plane that is
-- disjoint from the tenant plane, and give it read access to exactly the rows
-- that belong to no organization — and to nothing else, ever.**
--
-- This is deliberately not option (a). Option (a) is "document the gap and wait
-- for an operator path that does not exist". The gap is closable here, in SQL,
-- without widening a single tenant-scoped policy, so closing it is the honest
-- answer. It is also not option (b): re-resolving attribution at write time is
-- another lane's file and cannot be done from this one (see THE DEFECT THIS
-- MIGRATION DOES NOT FIX, below).
--
-- The mechanism rests on one property, which is the whole idea:
--
--     A PLATFORM OPERATOR IS A PROFILE THAT IS A MEMBER OF NO ORGANIZATION.
--
-- `public.is_platform_operator()` returns true only when the caller holds an
-- active row in `public.platform_operators` AND holds no `active` or `invited`
-- row in `public.organization_members` at all. A trigger refuses the grant in
-- the first place if the profile is already a member, and the predicate re-checks
-- at every call, so adding an operator to an organization later silently REVOKES
-- their operator power rather than combining the two. Fails in the safe
-- direction.
--
-- The consequence is that the operator plane is provably isolation-preserving,
-- not merely carefully written:
--
--   * Every policy in 0001–0004 on every tenant-scoped table resolves through
--     `is_org_member` / `is_org_staff` / `current_tenant_id` /
--     `current_provider_id` / `owns_property`, and every one of those is false
--     or null for a profile with no membership. An operator session therefore
--     reads ZERO rows from every tenant-scoped table — properties, tenants,
--     tickets, documents, audit logs, attributed inbound messages. Not "is
--     trusted not to"; cannot.
--   * The four operator functions below are the operator's only elevated read
--     path, and each one carries `organization_id is null` as a non-optional
--     filter. The operator's reachable set is exactly the set of rows that
--     belong to no organization. Organization A's admin cannot reach this path,
--     and the operator cannot reach Organization A.
--
-- WHY FUNCTIONS AND NOT A POLICY. The obvious implementation is a second
-- permissive policy on `inbound_messages`:
--
--     using (organization_id is null and public.is_platform_operator())
--
-- It is rejected. A permissive policy is an OR arm bolted onto a tenant-scoped
-- table, and from that moment the isolation of that table depends on a predicate
-- that is not about organization membership. Any later widening of
-- `is_platform_operator` — one well-meant `or is_org_staff(...)` — becomes a
-- cross-tenant leak on the most sensitive table in the system, and nothing would
-- catch it. Keeping the elevated path in named SECURITY DEFINER functions means
-- the invariant stays mechanically checkable and absolute: **no policy anywhere
-- in this schema mentions `is_platform_operator`, and no policy anywhere in this
-- schema admits a row whose `organization_id` is null.** §7 (1) and §7 (2)
-- assert exactly that and raise if it stops being true.
--
-- -----------------------------------------------------------------------------
-- THREE DESIGNS THAT WERE REJECTED, AND THE REASON EACH ONE LEAKS
-- -----------------------------------------------------------------------------
-- 1. "Show unattributed messages to all staff of all organizations."
--    A cross-tenant leak by construction. The single worst available regression
--    in this codebase. Not considered further.
--
-- 2. "Show an unattributed message to each organization that holds a tenant with
--    that phone number — they already have the number, so nothing new is
--    disclosed."
--    Tempting, and wrong. The identifier is not the disclosure; the EVENT is. A
--    number is ambiguous precisely because it belongs to a tenant in
--    Organization A and to a contact in Organization B. Showing the arrival to A
--    tells A that their tenant sent a message at 14:03 — when the message was in
--    fact addressed to B, about B's property. That is A reading a fact about B's
--    tenancy. Rejected.
--
-- 3. "Expose only a content-free, organization-free count — '17 unattributed
--    messages in the last day' — to any staff member. An aggregate over the
--    whole platform is attributable to nobody."
--    Also wrong, and the reason is worth recording because it is not obvious.
--    The counter is a membership oracle on `tenants.phone` ACROSS ALL
--    ORGANIZATIONS. Send a message from a number you control, poll the counter:
--    if it does not move, that number resolves to exactly one tenant somewhere
--    on the platform; if it moves, it resolves to zero or to two or more. Repeat
--    over a number list and you have enumerated foreign tenancies through a
--    scalar. Rejected.
--
-- -----------------------------------------------------------------------------
-- WHAT IS AND IS NOT CLOSED — STATED PLAINLY
-- -----------------------------------------------------------------------------
-- CLOSED. An unattributed message is now reachable, triageable and disposable by
-- a named, provisioned, audited human, and every read of its content is recorded
-- in `public.platform_operator_events` with the operator's profile and the
-- message id.
--
-- NOT A GAP, BUT A DISCLOSED TRUST. A platform operator can read the body of a
-- message that belongs to no organization. That is unavoidable: somebody has to
-- look at a dead letter to decide what it is. It is bounded by construction —
-- the operator belongs to no organization, can read nothing that does, and can
-- never read an attributed message — and it is bounded in practice by the table
-- starting EMPTY. With zero operators provisioned, behaviour after this
-- migration is byte-for-byte identical to behaviour before it. The trust is
-- created by an explicit, reasoned, timestamped grant or it does not exist.
--
-- THE DEFECT THIS MIGRATION DOES NOT FIX, and which should be fixed next by the
-- lane that owns the webhook. `unmatched` is common only because attribution is
-- attempted by SENDER lookup (`services/integrations/server-only/
-- sender-resolution.ts`), which is inherently ambiguous: two organizations may
-- legitimately hold the same number. The non-ambiguous key is the DESTINATION —
-- the business channel the message arrived on, which an organization provisions
-- in advance and which belongs to exactly one of them. The WhatsApp envelope
-- already carries it (`metadata.phone_number_id`, normalised as
-- `NormalisedInboundMessage.phoneNumberId`) and the ingest path currently throws
-- it away. A `(provider, channel_identifier) -> organization_id` registry with a
-- GLOBAL unique constraint would make attribution a lookup rather than a guess
-- and would reduce `unmatched` to its true meaning — "arrived on a channel
-- nobody registered", which is an infrastructure dead letter and correctly
-- belongs to no organization. Reported as a cross-lane planning defect; this
-- file does not fabricate the column, because the writer that would populate it
-- lives in a file this lane does not own.
--
-- HOUSE RULES OBSERVED HERE (0004 header)
--   * Every function is `set search_path = ''` and fully schema-qualified.
--   * Every dollar quote uses a NAMED tag. A bare `$$` has already collapsed to
--     `$` once in this project's tooling.
--   * Idempotent throughout: `if not exists`, `create or replace`,
--     `drop policy if exists`, `drop trigger if exists`, `pg_constraint`-guarded
--     constraint adds.
--   * No DELETE grant and no DELETE path on anything tenant-scoped.
--   * TRUNCATE is re-revoked in §6. This migration adds two tables, so the
--     standing requirement from 0002 §4a / 0004 §7 applies again.
--   * No local copy of any shared helper (CLAUDE.md rule 4): `current_profile_id`,
--     `is_org_staff` and `log_audit` are used as they are.
--
-- CONSUMER NOTES
--   * Provision an operator with the SERVICE ROLE only:
--       insert into public.platform_operators (profile_id, reason)
--       values ('<profile uuid>', 'dead-letter triage, ticket OPS-123');
--     The grant is refused if that profile is a member of any organization.
--   * Operator read paths (caller-scoped client, never the service role — they
--     authorize a human and a service-role session has no human in it):
--       select * from public.unattributed_messages();            -- metadata only
--       select public.unattributed_message_body('<message uuid>'); -- audited
--   * Operator disposition:
--       select * from public.attribute_inbound_message('<msg>', '<org>');
--       select * from public.discard_unattributed_message('<msg>', 'spam');
--   * Attribution is ONE WAY and is enforced by a trigger for EVERY role,
--     service role included: a null organization may be filled in once; a
--     non-null organization can never be changed or cleared.
-- =============================================================================


-- =============================================================================
-- 0. Preconditions — fail loudly before anything is created
-- =============================================================================

do $pre5$
begin
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'inbound_messages'
  ) then
    raise exception
      'migration 0005: public.inbound_messages is missing. Apply 0004 before 0005.'
      using errcode = '42P01';
  end if;

  -- The whole file is a response to the shape of this one policy. If it is gone
  -- or renamed, the premise has changed and a human must re-reason rather than
  -- let this migration bolt an operator plane onto something else.
  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'inbound_messages'
      and p.policyname = 'inbound_messages_select_staff'
  ) then
    raise exception
      'migration 0005: policy inbound_messages_select_staff is missing. This migration exists to complement it; reconcile 0004 before applying 0005.'
      using errcode = '42704';
  end if;

  if pg_catalog.to_regprocedure('public.current_profile_id()')    is null
  or pg_catalog.to_regprocedure('public.is_org_staff(uuid)')      is null
  or pg_catalog.to_regprocedure('public.is_org_member(uuid)')     is null
  or pg_catalog.to_regprocedure('public.log_audit(text, text, uuid, jsonb, uuid)') is null
  then
    raise exception
      'migration 0005: a helper function from 0001/0002/0003 is missing. Apply 0001 through 0004 before 0005.'
      using errcode = '42883';
  end if;

  -- §3 adds `check (organization_id is not null or status not in (...))`. A
  -- constraint add validates existing rows, so a violating row would fail the
  -- migration with a bare 23514. Say what is wrong instead.
  if exists (
    select 1 from public.inbound_messages m
    where m.organization_id is null
      and m.status in ('classified', 'linked')
  ) then
    raise exception
      'migration 0005: public.inbound_messages holds row(s) with a null organization_id and status classified or linked. Those states mean "attributed", so the data contradicts the invariant §3 is about to enforce. Investigate before applying.'
      using errcode = '23514';
  end if;

  raise notice 'migration 0005: preconditions satisfied';
end
$pre5$;


-- =============================================================================
-- 1. The platform-operator plane
-- =============================================================================
--
-- NOTE THE ABSENCE OF `organization_id`. It is not an oversight and it is not a
-- simplification: it is the definition. A platform operator is not a member of
-- an organization, holds no role inside one, and is not reachable by any
-- organization's administrator. The table is a list of profiles that sit
-- OUTSIDE the tenant plane entirely.
--
-- `reason` is `not null` and non-blank because a privilege that nobody had to
-- justify is a privilege nobody will remember to revoke.
create table if not exists public.platform_operators (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'revoked')),
  reason text not null check (btrim(reason) <> ''),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint platform_operators_revocation_consistent
    check (
      (status = 'active'  and revoked_at is null)
      or (status = 'revoked' and revoked_at is not null)
    )
);

comment on table public.platform_operators is
  'Profiles permitted to triage inbound messages that belong to no organization. Deliberately has no organization_id: an operator is outside the tenant plane. A profile that is a member of ANY organization cannot be granted operator status and loses it if membership is added later — see public.is_platform_operator(). Written by the service role only; the table starts empty and with zero rows this plane does not exist.';
comment on column public.platform_operators.reason is
  'Why this grant was made. Operational text — never a tenant name, a phone number or a message body (CLAUDE.md rule 8).';


-- --------------------------------------------------------------------------
-- 1a. Guarded constraint adds
-- --------------------------------------------------------------------------
-- `create table if not exists` is a no-op against a table left by a partial
-- earlier run, and such a table could be missing the constraint that carries the
-- guarantee. Re-assert through pg_constraint so a re-run repairs rather than
-- assumes. Same shape as 0004 §3a.
do $cons5$
declare
  rec record;
begin
  for rec in
    select *
    from (values
      ('platform_operators', 'platform_operators_revocation_consistent',
       'check ((status = ''active'' and revoked_at is null) or (status = ''revoked'' and revoked_at is not null))'),
      ('inbound_messages', 'inbound_messages_attributed_status',
       'check (organization_id is not null or status not in (''classified'', ''linked''))')
    ) as t(tbl, cname, cdef)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = rec.tbl
    ) then
      continue;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_constraint k
      join pg_catalog.pg_class c on c.oid = k.conrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = rec.tbl
        and k.conname = rec.cname
    ) then
      execute format('alter table public.%I add constraint %I %s', rec.tbl, rec.cname, rec.cdef);
      raise notice 'migration 0005: added constraint %.%', rec.tbl, rec.cname;
    end if;
  end loop;
end
$cons5$;

comment on constraint inbound_messages_attributed_status on public.inbound_messages is
  'Added by 0005. `classified` and `linked` both mean "we know whose this is", so neither is reachable while organization_id is null. Keeps the set of unattributed rows exactly equal to the set this migration''s operator path can see.';


-- --------------------------------------------------------------------------
-- 1b. A member of an organization may not be an operator
-- --------------------------------------------------------------------------
-- The predicate in §1c re-checks this at every call, so the system is safe
-- without this trigger. The trigger exists so the GRANT fails loudly at the
-- moment someone makes the mistake, instead of producing an operator row that
-- silently never works.
--
-- `invited` counts as membership: otherwise an organization could park an
-- invitation on an operator's profile and accept it later, turning a dormant
-- cross-organization reader into an organization insider at a time of its
-- choosing.
create or replace function public.reject_operator_with_membership()
returns trigger
language plpgsql
set search_path = ''
as $row5$
begin
  if new.status = 'active' and exists (
    select 1
    from public.organization_members m
    where m.profile_id = new.profile_id
      and m.status in ('active', 'invited')
  ) then
    raise exception 'platform_operator_is_org_member: a profile that belongs to an organization cannot hold platform operator status'
      using errcode = '42501',
            hint = 'The operator plane is disjoint from the tenant plane by design. Use a dedicated profile with no organization membership.';
  end if;
  return new;
end
$row5$;

drop trigger if exists platform_operators_reject_org_member on public.platform_operators;
create trigger platform_operators_reject_org_member
  before insert or update on public.platform_operators
  for each row execute function public.reject_operator_with_membership();


-- --------------------------------------------------------------------------
-- 1c. public.is_platform_operator — the predicate
-- --------------------------------------------------------------------------
--
-- Two conjuncts, both load-bearing:
--   * an active grant exists, and
--   * the caller is a member of no organization, in any status that could
--     become active.
--
-- A service-role session has no `auth.uid()`, so `current_profile_id()` is null,
-- so the first conjunct is false. The service role does not need this function:
-- it bypasses row level security and reads the table directly.
--
-- THIS FUNCTION MUST NEVER APPEAR IN A POLICY. §7 (2) raises if it ever does.
create or replace function public.is_platform_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $ipo5$
  select exists (
      select 1
      from public.platform_operators o
      where o.profile_id = public.current_profile_id()
        and o.status = 'active'
    )
    and not exists (
      select 1
      from public.organization_members m
      where m.profile_id = public.current_profile_id()
        and m.status in ('active', 'invited')
    )
$ipo5$;

comment on function public.is_platform_operator() is
  'True when the caller holds an active platform_operators grant AND is a member of no organization. The second conjunct is what makes the operator plane disjoint from the tenant plane: an operator reads zero rows from every tenant-scoped table because every policy in 0001-0004 resolves through organization membership. Never reference this from a row level security policy — the self-check in 0005 §7 (2) raises if you do.';

revoke all on function public.is_platform_operator() from public;
revoke all on function public.is_platform_operator() from anon;
grant execute on function public.is_platform_operator() to authenticated, service_role;


-- --------------------------------------------------------------------------
-- 1d. Row level security on the grant list
-- --------------------------------------------------------------------------
alter table public.platform_operators enable row level security;

-- Self-read only. The application needs to know whether to render the triage
-- surface, and a caller learning a fact about themselves discloses nothing. The
-- roster as a whole is not readable by any client: who holds cross-organization
-- reach is operational information, and an enumerable list of them is a target
-- list.
drop policy if exists platform_operators_select_self on public.platform_operators;
create policy platform_operators_select_self
on public.platform_operators
for select
to authenticated
using (profile_id = (select public.current_profile_id()));

-- No client write path of any kind. Granting yourself cross-organization reach
-- must require the service role, which means a deliberate out-of-band action.
revoke all on table public.platform_operators from anon;
revoke insert, update, delete, truncate on table public.platform_operators from authenticated;
grant select on table public.platform_operators to authenticated;


-- =============================================================================
-- 2. public.platform_operator_events — the operator plane's own audit trail
-- =============================================================================
--
-- WHY NOT `public.audit_logs`. `audit_logs.organization_id` is `not null`
-- (0001), and `public.log_audit` raises `audit_organization_required` without
-- one and `audit_forbidden` when the caller is not a member of the organization
-- named. An operator is a member of nothing and the rows they read belong to
-- nobody, so neither condition can ever be satisfied. Writing operator activity
-- into `audit_logs` is therefore not merely awkward, it is impossible — and
-- forcing it would mean either relaxing a `not null` on the audit table or
-- giving operators a membership, both of which are worse than a second table.
--
-- A second table is also the right shape: this is a different trail, read by
-- different people, about a plane that is outside every organization. Keeping it
-- separate means no organization admin's audit view ever acquires rows about
-- another organization.
--
-- APPEND-ONLY, enforced by trigger for every role including the service role,
-- exactly as 0003 §5.1 does for maintenance_activities. An audit trail the
-- audited party can edit is decoration.
create table if not exists public.platform_operator_events (
  id uuid primary key default gen_random_uuid(),
  operator_profile_id uuid not null references public.profiles(id),
  action text not null check (btrim(action) <> ''),
  entity_type text not null check (btrim(entity_type) <> ''),
  entity_id uuid,
  -- Present only for `inbound_message.attributed`: the organization the operator
  -- moved the message into. Null for every read event, because a read event is
  -- about a row that belongs to no organization.
  organization_id uuid references public.organizations(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.platform_operator_events is
  'Append-only record of every privileged action taken through the platform-operator path in 0005. Separate from public.audit_logs because audit_logs.organization_id is not null and the operator plane has no organization. Service-role readable only; there is no policy and no client privilege.';
comment on column public.platform_operator_events.metadata is
  'Identifiers and counts only. Never a message body, a phone number or any other personal data (CLAUDE.md rule 8).';

create index if not exists idx_platform_operator_events_recent
  on public.platform_operator_events (created_at desc);
create index if not exists idx_platform_operator_events_operator
  on public.platform_operator_events (operator_profile_id, created_at desc);

create or replace function public.block_operator_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $boe5$
begin
  raise exception 'platform_operator_events_immutable: % is not permitted on platform_operator_events', tg_op
    using errcode = 'P0001',
          hint = 'The operator audit trail is append-only. Record a correcting event row instead.';
end
$boe5$;

drop trigger if exists platform_operator_events_block_update on public.platform_operator_events;
create trigger platform_operator_events_block_update
  before update on public.platform_operator_events
  for each row execute function public.block_operator_event_mutation();

drop trigger if exists platform_operator_events_block_delete on public.platform_operator_events;
create trigger platform_operator_events_block_delete
  before delete on public.platform_operator_events
  for each row execute function public.block_operator_event_mutation();

-- A blocked DELETE is worthless if TRUNCATE still empties the table.
drop trigger if exists platform_operator_events_block_truncate on public.platform_operator_events;
create trigger platform_operator_events_block_truncate
  before truncate on public.platform_operator_events
  for each statement execute function public.block_operator_event_mutation();

-- Row level security with NO policy: every client role reaches zero rows. The
-- revokes are belt and braces so that a future accidental policy still cannot
-- open it.
alter table public.platform_operator_events enable row level security;
revoke all on table public.platform_operator_events from anon;
revoke all on table public.platform_operator_events from authenticated;


-- =============================================================================
-- 3. Attribution is one way — enforced for every role
-- =============================================================================
--
-- A message may go from "belonging to nobody" to "belonging to Organization A"
-- exactly once. It may never go from A to B, and it may never go back to
-- nobody. The first is a cross-tenant transfer of content — the exact failure
-- this project is judged on — and the second would make an already-delivered
-- message reappear in the operator's dead-letter queue, where its body would
-- then be legitimately readable by a human outside the organization that
-- already owns it.
--
-- A trigger rather than a policy, deliberately, for the same reason 0003 §5.1
-- used one: policies and privileges stop clients. The writer here is the
-- service role, which bypasses both. A `before update` trigger does not.
--
-- `before update of organization_id` fires only when that column appears in the
-- statement's SET list, so the two legitimate update paths that do not touch it
-- (`status`/`ticket_id` bookkeeping in features/inbox/domain/repository.ts) do
-- not pay for it at all. The resolution job in
-- services/integrations/server-only/inbound-job.ts does list it, and its write
-- is null -> value, which is permitted.
create or replace function public.inbound_attribution_is_one_way()
returns trigger
language plpgsql
set search_path = ''
as $iow5$
begin
  if old.organization_id is not null
     and new.organization_id is distinct from old.organization_id then
    raise exception 'inbound_message_attribution_immutable: organization_id may be filled in once and never changed or cleared'
      using errcode = 'P0001',
            hint = 'An attributed message belongs to one organization permanently. If it was attributed wrongly, archive it with status ignored and investigate the resolver; do not move tenant content between organizations.';
  end if;
  return new;
end
$iow5$;

comment on function public.inbound_attribution_is_one_way() is
  'Trigger function. Makes public.inbound_messages.organization_id write-once: null may become a value, a value may never become a different value or null. Applies to the service role too, which is the only writer that could otherwise do it.';

drop trigger if exists inbound_messages_attribution_one_way on public.inbound_messages;
create trigger inbound_messages_attribution_one_way
  before update of organization_id on public.inbound_messages
  for each row execute function public.inbound_attribution_is_one_way();


-- =============================================================================
-- 4. The operator read path — the dead letter, made visible
-- =============================================================================
--
-- Two functions, split on purpose. Triage is mostly a metadata activity: how
-- many are queued, how old is the oldest, is this the same number over and over.
-- Only occasionally does a human need the text. Returning bodies in the listing
-- would mean every glance at the queue is a bulk read of other people's words,
-- so the listing returns `body_length` and the body has its own, individually
-- audited call.
--
-- BOTH ARE SECURITY DEFINER, so row level security is NOT in force inside them.
-- `m.organization_id is null` is therefore not a convenience filter — it is the
-- only thing standing between the operator and every message in the system. It
-- is not optional and §7 (6) asserts that it is still textually present.

-- --------------------------------------------------------------------------
-- 4a. The queue
-- --------------------------------------------------------------------------
-- VOLATILE, not STABLE: it writes an audit row. A privileged cross-organization
-- read that leaves no trace is not a privileged read, it is an unmonitored one.
create or replace function public.unattributed_messages(
  p_limit int default 50,
  p_before timestamptz default null,
  p_include_disposed boolean default false
)
returns table (
  message_id uuid,
  provider text,
  from_identifier text,
  received_at timestamptz,
  status text,
  body_length int
)
language plpgsql
security definer
set search_path = ''
as $um5$
declare
  v_profile uuid;
  v_limit   int;
  v_count   int;
begin
  if auth.uid() is null then
    raise exception 'authentication_required: unattributed_messages authorizes a human and needs an authenticated session. A service-role caller should query public.inbound_messages directly.'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  -- Refuse, do not silently return nothing. An empty queue and a denial are
  -- different answers and the caller is entitled to tell them apart.
  if not public.is_platform_operator() then
    raise exception 'platform_operator_required: only a provisioned platform operator may read messages that belong to no organization'
      using errcode = '42501';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 50), 1), 200);

  select count(*)
    into v_count
  from public.inbound_messages m
  where m.organization_id is null
    and (p_include_disposed or m.status <> 'ignored')
    and (p_before is null or m.received_at < p_before);

  insert into public.platform_operator_events (
    operator_profile_id, action, entity_type, entity_id, organization_id, metadata
  )
  values (
    v_profile,
    'inbound_message.dead_letter_listed',
    'inbound_message',
    null,
    null,
    jsonb_build_object('matching', v_count, 'limit', v_limit, 'include_disposed', coalesce(p_include_disposed, false))
  );

  return query
    select m.id,
           m.provider,
           m.from_identifier,
           m.received_at,
           m.status,
           char_length(coalesce(m.body, ''))
    from public.inbound_messages m
    where m.organization_id is null
      and (p_include_disposed or m.status <> 'ignored')
      and (p_before is null or m.received_at < p_before)
    order by m.received_at desc, m.id
    limit v_limit;
end
$um5$;

comment on function public.unattributed_messages(int, timestamptz, boolean) is
  'The dead-letter queue: inbound messages that belong to no organization. Platform operators only; raises 42501 for everyone else including every organization admin. Returns metadata and the body LENGTH, never the body — use public.unattributed_message_body for that. Every call writes a public.platform_operator_events row.';

revoke all on function public.unattributed_messages(int, timestamptz, boolean) from public;
revoke all on function public.unattributed_messages(int, timestamptz, boolean) from anon;
grant execute on function public.unattributed_messages(int, timestamptz, boolean) to authenticated, service_role;


-- --------------------------------------------------------------------------
-- 4b. The body, one message at a time, individually audited
-- --------------------------------------------------------------------------
-- A missing message and an ATTRIBUTED message raise the same 42501 with the same
-- message. Distinguishing them would turn this into an existence oracle: an
-- operator could probe message ids and learn which ones some organization owns.
create or replace function public.unattributed_message_body(p_message_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $umb5$
declare
  v_profile uuid;
  v_body    text;
  v_found   boolean;
begin
  if p_message_id is null then
    raise exception 'inbound_message_id_required: p_message_id must be supplied'
      using errcode = '22023';
  end if;

  if auth.uid() is null then
    raise exception 'authentication_required: unattributed_message_body authorizes a human and needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  if not public.is_platform_operator() then
    raise exception 'platform_operator_required: only a provisioned platform operator may read a message that belongs to no organization'
      using errcode = '42501';
  end if;

  select m.body, true
    into v_body, v_found
  from public.inbound_messages m
  where m.id = p_message_id
    and m.organization_id is null;

  if not coalesce(v_found, false) then
    raise exception 'unattributed_message_not_found: no unattributed message with that id is readable through this path'
      using errcode = '42501',
            hint = 'An attributed message belongs to an organization and is readable only by that organization''s staff.';
  end if;

  -- The event records WHICH message was read and by whom. It must not record
  -- the text (CLAUDE.md rule 8) — that would defeat the point of the split in
  -- 4a by copying every body into a second table.
  insert into public.platform_operator_events (
    operator_profile_id, action, entity_type, entity_id, organization_id, metadata
  )
  values (
    v_profile,
    'inbound_message.dead_letter_body_read',
    'inbound_message',
    p_message_id,
    null,
    jsonb_build_object('body_length', char_length(coalesce(v_body, '')))
  );

  return v_body;
end
$umb5$;

comment on function public.unattributed_message_body(uuid) is
  'Reads the body of ONE message that belongs to no organization. Platform operators only. Raises 42501 for an attributed message and for a non-existent one, with the same wording, so it cannot be used as an existence oracle. Writes a public.platform_operator_events row naming the message read.';

revoke all on function public.unattributed_message_body(uuid) from public;
revoke all on function public.unattributed_message_body(uuid) from anon;
grant execute on function public.unattributed_message_body(uuid) to authenticated, service_role;


-- =============================================================================
-- 5. Disposition — a queue nobody can empty is still a leak of a different kind
-- =============================================================================
-- Visibility without disposition means the dead letter grows forever and every
-- operator re-reads the same bodies. Two terminal moves, both one way, both
-- audited.

-- --------------------------------------------------------------------------
-- 5a. Attribute it to the organization a human determined it belongs to
-- --------------------------------------------------------------------------
--
-- IS THIS THE "GUESS" 0004 REFUSED TO MAKE? No, and the difference is the whole
-- doctrine of this project. The resolver refused because a MACHINE cannot tell
-- two candidate organizations apart from a phone number. This is an
-- authenticated human making an explicit decision, recorded against their
-- profile with a reason. That is the same shape as
-- public.approve_agent_proposal: the system proposes nothing and commits
-- nothing; a person does, and it is written down.
--
-- The new status is `classified`, NOT `received`. `received` is the state the
-- resolution job acts on, and re-running the resolver on a message a human has
-- already attributed would at best waste work and at worst try to write
-- organization_id back to null — which §3's trigger would reject, turning a
-- human decision into a permanently retrying background job.
create or replace function public.attribute_inbound_message(
  p_message_id uuid,
  p_organization_id uuid,
  p_reason text default null
)
returns public.inbound_messages
language plpgsql
security definer
set search_path = ''
as $aim5$
declare
  v_profile uuid;
  v_message public.inbound_messages;
begin
  if p_message_id is null or p_organization_id is null then
    raise exception 'attribution_arguments_required: p_message_id and p_organization_id must both be supplied'
      using errcode = '22023';
  end if;

  if auth.uid() is null then
    raise exception 'authentication_required: attributing a message is a human act and needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  if not public.is_platform_operator() then
    raise exception 'platform_operator_required: only a provisioned platform operator may attribute a message that belongs to no organization'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = p_organization_id and o.status = 'active'
  ) then
    raise exception 'attribution_organization_invalid: no active organization with that id'
      using errcode = '22023';
  end if;

  -- `for update` and the `organization_id is null` predicate together make this
  -- safe against the resolution job attributing the same row concurrently: one
  -- of the two statements sees a non-null organization and refuses.
  select m.* into v_message
  from public.inbound_messages m
  where m.id = p_message_id
    and m.organization_id is null
  for update;

  if not found then
    raise exception 'unattributed_message_not_found: no unattributed message with that id is writable through this path'
      using errcode = '42501',
            hint = 'Attribution is one way. A message that already belongs to an organization can never be moved to another one.';
  end if;

  update public.inbound_messages m
     set organization_id = p_organization_id,
         status          = 'classified'
   where m.id = p_message_id
     and m.organization_id is null
  returning m.* into v_message;

  insert into public.platform_operator_events (
    operator_profile_id, action, entity_type, entity_id, organization_id, metadata
  )
  values (
    v_profile,
    'inbound_message.attributed',
    'inbound_message',
    p_message_id,
    p_organization_id,
    jsonb_build_object(
      'provider', v_message.provider,
      'previous_status', 'unattributed',
      -- Operational free text supplied by the operator. Truncated hard because
      -- an audit field is exactly where somebody eventually pastes a message
      -- body (CLAUDE.md rule 8).
      'reason', left(coalesce(p_reason, ''), 200)
    )
  );

  return v_message;
end
$aim5$;

comment on function public.attribute_inbound_message(uuid, uuid, text) is
  'Moves ONE message from belonging to nobody to belonging to one organization, as an explicit decision by an authenticated platform operator. Only null -> value; §3''s trigger makes value -> other value impossible for every role. Sets status to classified so the organization''s staff see it and the resolver does not re-run. Audited in public.platform_operator_events.';

revoke all on function public.attribute_inbound_message(uuid, uuid, text) from public;
revoke all on function public.attribute_inbound_message(uuid, uuid, text) from anon;
grant execute on function public.attribute_inbound_message(uuid, uuid, text) to authenticated, service_role;


-- --------------------------------------------------------------------------
-- 5b. Discard it — it belongs to nobody because it belongs to nobody
-- --------------------------------------------------------------------------
-- The common case. A wrong number, a marketing blast, a person who has never
-- been a tenant anywhere. `ignored` and NOT a delete: CLAUDE.md rule 6 forbids a
-- DELETE path on a tenant-scoped table, and the fact that a message arrived and
-- was judged irrelevant is itself evidence worth keeping. The row keeps its null
-- organization and simply stops appearing in the queue.
create or replace function public.discard_unattributed_message(
  p_message_id uuid,
  p_reason text default null
)
returns public.inbound_messages
language plpgsql
security definer
set search_path = ''
as $dum5$
declare
  v_profile uuid;
  v_message public.inbound_messages;
begin
  if p_message_id is null then
    raise exception 'inbound_message_id_required: p_message_id must be supplied'
      using errcode = '22023';
  end if;

  if auth.uid() is null then
    raise exception 'authentication_required: discarding a message is a human act and needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  if not public.is_platform_operator() then
    raise exception 'platform_operator_required: only a provisioned platform operator may dispose of a message that belongs to no organization'
      using errcode = '42501';
  end if;

  update public.inbound_messages m
     set status = 'ignored'
   where m.id = p_message_id
     and m.organization_id is null
     and m.status <> 'ignored'
  returning m.* into v_message;

  if not found then
    raise exception 'unattributed_message_not_found: no undisposed unattributed message with that id is writable through this path'
      using errcode = '42501';
  end if;

  insert into public.platform_operator_events (
    operator_profile_id, action, entity_type, entity_id, organization_id, metadata
  )
  values (
    v_profile,
    'inbound_message.dead_letter_discarded',
    'inbound_message',
    p_message_id,
    null,
    jsonb_build_object('provider', v_message.provider, 'reason', left(coalesce(p_reason, ''), 200))
  );

  return v_message;
end
$dum5$;

comment on function public.discard_unattributed_message(uuid, text) is
  'Marks an unattributed message ignored so it leaves the dead-letter queue. The row and its null organization are kept: there is no DELETE path on a tenant-scoped table (CLAUDE.md rule 6). Audited in public.platform_operator_events.';

revoke all on function public.discard_unattributed_message(uuid, text) from public;
revoke all on function public.discard_unattributed_message(uuid, text) from anon;
grant execute on function public.discard_unattributed_message(uuid, text) to authenticated, service_role;


-- =============================================================================
-- 6. TRUNCATE — the standing requirement from 0002 §4a and 0004 §7
-- =============================================================================
-- TRUNCATE ignores row level security completely, and Supabase's default
-- privileges grant it to `authenticated` and `anon` on every table at creation
-- time. 0004 recorded that `supabase_admin`'s default ACL still carries the `D`,
-- so the two tables created above may have arrived with it. Re-run the loop over
-- EVERY table in `public`, for the same reason 0002 and 0004 did: a hand-written
-- list is a hole waiting for the next migration.
do $trunc5$
declare
  rec     record;
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
    'migration 0005: TRUNCATE revoked from authenticated and anon on % table(s) in schema public',
    touched;
end
$trunc5$;

do $defacl5$
declare
  grantor   text;
  unreached text[] := '{}';
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
    exception
      when insufficient_privilege then
        unreached := unreached || grantor;
    end;
  end loop;

  if array_length(unreached, 1) is not null then
    raise warning
      'migration 0005: still cannot revoke TRUNCATE from the default privileges of role(s) %. ANY LATER MIGRATION THAT ADDS A TABLE MUST RE-RUN THE REVOKE LOOP IN SECTION 6.',
      array_to_string(unreached, ', ');
  end if;
end
$defacl5$;


-- =============================================================================
-- 7. Self-check — refuse to ship a hole
-- =============================================================================
-- In the style of 0002 §7 and 0004 §8: cheap, idempotent assertions that raise.
-- Item (1) is the one this migration was required to prove. It is written
-- generically over the whole schema rather than against `inbound_messages` by
-- name, so the day a second nullable `organization_id` appears anywhere in
-- `public` it is held to the same rule automatically.

do $check5$
declare
  offending text;
  mine      text[] := array['platform_operators', 'platform_operator_events'];
begin
  -- ---------------------------------------------------------------------
  -- (1) THE CENTRAL ASSERTION.
  --     No row level security policy anywhere in `public` permits a
  --     tenant-scoped role to READ a row whose `organization_id` is null.
  --
  --     Scope: every table in `public` carrying a NULLABLE `organization_id`,
  --     and every PERMISSIVE policy on it whose command is SELECT or ALL and
  --     whose role list includes a client role. (A RESTRICTIVE policy can only
  --     narrow, so it cannot admit anything.)
  --
  --     Test: the policy's USING expression must contain the literal guard
  --     `organization_id IS NOT NULL`, and the REMAINDER of the expression —
  --     with that guard removed — must contain no ` OR ` and no ` NOT `.
  --
  --     Why that is sound rather than merely suggestive: if the expression is a
  --     pure conjunction (no disjunction, no negation) and one of its conjuncts
  --     is `organization_id IS NOT NULL`, then for any row with a null
  --     organization the whole expression is false, so the policy admits no such
  --     row. The textual form is conservative and it is MEANT to be brittle: a
  --     policy complex enough to defeat this check is a policy a human must
  --     re-reason about before it ships, and failing the migration is how that
  --     conversation gets started.
  select string_agg(format('%s.%s', t.tablename, t.policyname), ', ' order by t.tablename, t.policyname)
    into offending
  from (
    select p.tablename, p.policyname
    from pg_policies p
    where p.schemaname = 'public'
      and p.permissive = 'PERMISSIVE'
      and p.cmd in ('SELECT', 'ALL')
      and p.roles && array['authenticated', 'anon', 'public']::name[]
      and exists (
        select 1
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = p.tablename
          and c.relkind in ('r', 'p')
          and a.attname = 'organization_id'
          and a.attnum > 0
          and not a.attisdropped
          and not a.attnotnull
      )
      and (
        coalesce(p.qual, '') not like '%organization_id IS NOT NULL%'
        or replace(coalesce(p.qual, ''), 'organization_id IS NOT NULL', '') like '% OR %'
        or replace(coalesce(p.qual, ''), 'organization_id IS NOT NULL', '') like '% NOT %'
      )
  ) t;

  if offending is not null then
    raise exception
      'migration 0005: a policy on a table with a NULLABLE organization_id may admit rows that belong to no organization, to a tenant-scoped role: %. An unattributed inbound message must be readable by no organization at all; read it through public.unattributed_messages() instead.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (2) The operator predicate is nowhere near a policy. This is the rule that
  --     keeps assertion (1) meaningful forever: the cheapest way to "fix" a
  --     future complaint about invisible dead letters would be to add
  --     `or public.is_platform_operator()` to the staff policy, and that one
  --     edit would put a non-membership predicate on the isolation path of the
  --     most sensitive table in the system.
  select string_agg(format('%s.%s', p.tablename, p.policyname), ', ' order by p.tablename, p.policyname)
    into offending
  from pg_policies p
  where p.schemaname = 'public'
    and (coalesce(p.qual, '') like '%is_platform_operator%'
      or coalesce(p.with_check, '') like '%is_platform_operator%');

  if offending is not null then
    raise exception
      'migration 0005: public.is_platform_operator() is referenced by policy/policies %. The operator plane must stay out of row level security entirely — it reaches rows through named SECURITY DEFINER functions so that the policy layer remains purely organization-scoped.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (3) inbound_messages still has exactly one policy, the one 0004 wrote.
  --     Assertion (1) checks the shape of whatever policies exist; this checks
  --     that no additional one appeared at all.
  select string_agg(p.policyname || ' (' || p.cmd || ')', ', ' order by p.policyname)
    into offending
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'inbound_messages'
    and p.policyname <> 'inbound_messages_select_staff';

  if offending is not null then
    raise exception
      'migration 0005: unexpected policy/policies on public.inbound_messages: %. 0004 deliberately gives it one SELECT policy and no client write path.', offending;
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'inbound_messages'
      and p.policyname = 'inbound_messages_select_staff'
      and p.cmd <> 'SELECT'
  ) then
    raise exception
      'migration 0005: inbound_messages_select_staff is no longer a SELECT-only policy.';
  end if;

  -- ---------------------------------------------------------------------
  -- (4) No client write privilege on inbound_messages, so the one-way
  --     attribution trigger in §3 is the only thing that has to hold the line
  --     against the service role rather than against everyone.
  select string_agg(format('%s:%s', g.rolname, priv), ', ' order by g.rolname, priv)
    into offending
  from (
    select rolname from pg_catalog.pg_roles where rolname in ('authenticated', 'anon')
  ) g
  cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as priv
  where pg_catalog.has_table_privilege(g.rolname, 'public.inbound_messages', priv);

  if offending is not null then
    raise exception
      'migration 0005: a client role holds a write privilege on public.inbound_messages: %. A client that can write that table can forge the evidence a classification was based on.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (5) The operator plane exists, is locked down, and has no organization.
  if pg_catalog.to_regprocedure('public.is_platform_operator()') is null then
    raise exception 'migration 0005: public.is_platform_operator() is missing.';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'platform_operators'
      and a.attname = 'organization_id'
      and a.attnum > 0
      and not a.attisdropped
  ) then
    raise exception
      'migration 0005: public.platform_operators has acquired an organization_id column. An operator scoped to an organization is an organization role, and the disjointness argument this migration rests on collapses.';
  end if;

  select string_agg(c.relname, ', ' order by c.relname)
    into offending
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (mine)
    and c.relrowsecurity is false;

  if offending is not null then
    raise exception 'migration 0005: row level security is not enabled on: %', offending;
  end if;

  select string_agg(format('%s.%s', p.tablename, p.policyname), ', ' order by p.policyname)
    into offending
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = any (mine)
    and (p.cmd in ('DELETE', 'ALL', 'INSERT', 'UPDATE')
      or (p.tablename = 'platform_operator_events'));

  if offending is not null then
    raise exception
      'migration 0005: unexpected policy on the operator plane: %. platform_operators takes exactly one self-scoped SELECT policy; platform_operator_events takes none at all.', offending;
  end if;

  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'platform_operators'
      and p.policyname = 'platform_operators_select_self'
      and p.cmd = 'SELECT'
      and coalesce(p.qual, '') like '%current_profile_id%'
  ) then
    raise exception
      'migration 0005: platform_operators_select_self is missing or is no longer scoped to the caller''s own profile. The operator roster must not be enumerable by a client.';
  end if;

  select string_agg(format('%s:%s', g.rolname, priv), ', ' order by g.rolname, priv)
    into offending
  from (
    select rolname from pg_catalog.pg_roles where rolname in ('authenticated', 'anon')
  ) g
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as priv
  where pg_catalog.has_table_privilege(g.rolname, 'public.platform_operator_events', priv);

  if offending is not null then
    raise exception
      'migration 0005: a client role holds a privilege on public.platform_operator_events: %. The operator audit trail is service-role only; an audited party that can read or edit their own trail is not audited.', offending;
  end if;

  select string_agg(format('%s:%s', g.rolname, priv), ', ' order by g.rolname, priv)
    into offending
  from (
    select rolname from pg_catalog.pg_roles where rolname in ('authenticated', 'anon')
  ) g
  cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as priv
  where pg_catalog.has_table_privilege(g.rolname, 'public.platform_operators', priv);

  if offending is not null then
    raise exception
      'migration 0005: a client role can write public.platform_operators: %. Granting yourself cross-organization reach must require the service role.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (6) Every elevated read path still restricts itself to rows that belong to
  --     no organization, and still runs as definer with a pinned search_path.
  --     The body test is textual and therefore brittle; that is deliberate, for
  --     the same reason as (1). These four functions bypass row level security,
  --     so that one predicate is the entire boundary.
  select string_agg(t.sig, ', ' order by t.sig)
    into offending
  from (
    select format('%s(%s)', pr.proname, pg_catalog.pg_get_function_identity_arguments(pr.oid)) as sig
    from pg_catalog.pg_proc pr
    join pg_catalog.pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public'
      and pr.proname in (
        'unattributed_messages', 'unattributed_message_body',
        'attribute_inbound_message', 'discard_unattributed_message'
      )
      and (
        not pr.prosecdef
        or pr.prosrc not like '%organization_id is null%'
        or pr.prosrc not like '%is_platform_operator%'
        or coalesce(array_to_string(pr.proconfig, ','), '') not like '%search_path=%'
      )
  ) t;

  if offending is not null then
    raise exception
      'migration 0005: an operator function has lost its boundary: %. Each of the four must be SECURITY DEFINER with a pinned search_path, must gate on public.is_platform_operator(), and must filter on organization_id is null — nothing else keeps it away from attributed tenant content.', offending;
  end if;

  if (select count(*)
      from pg_catalog.pg_proc pr
      join pg_catalog.pg_namespace n on n.oid = pr.pronamespace
      where n.nspname = 'public'
        and pr.proname in (
          'unattributed_messages', 'unattributed_message_body',
          'attribute_inbound_message', 'discard_unattributed_message'
        )) <> 4
  then
    raise exception
      'migration 0005: the operator path is not four functions. One of them is missing, or an overload has been added that the checks above did not inspect.';
  end if;

  -- ---------------------------------------------------------------------
  -- (7) The operator predicate still excludes organization members. Without
  --     this conjunct an operator could be an organization admin, and the
  --     disjointness that makes assertion (1) sufficient would be gone.
  if not exists (
    select 1
    from pg_catalog.pg_proc pr
    join pg_catalog.pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public'
      and pr.proname = 'is_platform_operator'
      and pr.prosrc like '%organization_members%'
      and pr.prosrc like '%not exists%'
  ) then
    raise exception
      'migration 0005: public.is_platform_operator() no longer excludes organization members. An operator who is also a member of an organization can combine cross-organization dead-letter reads with organization-scoped reads, which is the combination this design exists to prevent.';
  end if;

  -- And no such grant exists in the data right now. The §1b trigger should make
  -- this unreachable; if it is reachable, the trigger is gone.
  select string_agg(o.profile_id::text, ', ' order by o.profile_id::text)
    into offending
  from public.platform_operators o
  where o.status = 'active'
    and exists (
      select 1 from public.organization_members m
      where m.profile_id = o.profile_id and m.status in ('active', 'invited')
    );

  if offending is not null then
    raise exception
      'migration 0005: active platform operator(s) % are members of an organization. Revoke the grant or remove the membership; they may not hold both.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (8) Attribution is one way, and the trigger that makes it so is enabled.
  if not exists (
    select 1
    from pg_catalog.pg_trigger tg
    join pg_catalog.pg_class c on c.oid = tg.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'inbound_messages'
      and tg.tgname = 'inbound_messages_attribution_one_way'
      and not tg.tgisinternal
      and tg.tgenabled <> 'D'
  ) then
    raise exception
      'migration 0005: trigger inbound_messages_attribution_one_way is missing or disabled. Without it the service role can move a message from one organization to another, which is a cross-tenant transfer of tenant content.';
  end if;

  -- ---------------------------------------------------------------------
  -- (9) The operator audit trail is append-only for every role.
  select string_agg(want, ', ' order by want)
    into offending
  from unnest(array[
    'platform_operator_events_block_update',
    'platform_operator_events_block_delete',
    'platform_operator_events_block_truncate'
  ]) as want
  where not exists (
    select 1
    from pg_catalog.pg_trigger tg
    join pg_catalog.pg_class c on c.oid = tg.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'platform_operator_events'
      and tg.tgname = want
      and not tg.tgisinternal
      and tg.tgenabled <> 'D'
  );

  if offending is not null then
    raise exception
      'migration 0005: operator audit trail is not append-only; missing or disabled trigger(s): %', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (10) `classified` and `linked` cannot coexist with a null organization, so
  --      the dead-letter queue and the set of unattributed rows are the same set.
  if not exists (
    select 1
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'inbound_messages'
      and k.conname = 'inbound_messages_attributed_status'
      and k.contype = 'c'
  ) then
    raise exception
      'migration 0005: constraint inbound_messages_attributed_status is missing.';
  end if;

  -- ---------------------------------------------------------------------
  -- (11) TRUNCATE is gone everywhere in public, inherited grants included.
  select string_agg(format('%s(%s)', t.relname, t.who), ', ' order by t.relname, t.who)
    into offending
  from (
    select c.relname, g.rolname as who
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join (
      select rolname from pg_catalog.pg_roles where rolname in ('authenticated', 'anon')
    ) g
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and pg_catalog.has_table_privilege(g.rolname, c.oid, 'TRUNCATE')
  ) t;

  if offending is not null then
    raise exception
      'migration 0005: TRUNCATE is still granted in schema public, which bypasses row level security and voids every policy in 0002, 0004 and 0005: %', offending;
  end if;

  raise notice 'migration 0005: self-check passed — no policy admits a null-organization row, the operator plane is disjoint from every organization, attribution is one way, the operator trail is append-only';
end
$check5$;


-- =============================================================================
-- 8. Live corroboration — plant an unattributed row, try to read it as real
--    staff, roll the whole thing back
-- =============================================================================
-- §7 (1) is a structural argument about policy text. This is the experiment.
--
-- It takes a REAL active staff member from `organization_members`, plants an
-- unattributed `inbound_messages` row, switches to the `authenticated` role with
-- that person's `sub` claim, and counts what they can see. The expected answer
-- is zero. The whole block runs inside a PL/pgSQL subtransaction that is
-- unwound by a deliberate exception, so the planted row never exists outside it
-- and no DELETE is issued. PL/pgSQL variables are not transactional, so the
-- count survives the rollback and can be asserted on afterwards.
--
-- A LEAK IS FATAL. An inability to RUN the experiment — no staff seeded yet, no
-- membership in the `authenticated` role, no `auth.uid()` — is a NOTICE, because
-- a migration that refuses to apply to an empty database is a worse failure than
-- one that reports it could not corroborate a check it already proved
-- structurally.
do $live5$
declare
  v_uid    uuid;
  v_org    uuid;
  v_msg    uuid;
  v_seen   int;
  v_allnul int;
  v_err    text;
begin
  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER') then
    raise notice 'migration 0005: live corroboration skipped — % is not a member of the authenticated role', current_user;
    return;
  end if;

  -- `auth.users` is a Supabase-managed table. On a stack where it is absent or
  -- unreadable the experiment cannot run, and that is a notice rather than a
  -- failed deploy.
  begin
    select u.id, m.organization_id
      into v_uid, v_org
    from public.organization_members m
    join public.profiles p on p.id = m.profile_id
    join auth.users u on u.id = p.auth_user_id
    where m.status = 'active'
      and m.role in ('organization_admin', 'property_manager')
    order by m.created_at
    limit 1;
  exception
    when others then
      raise notice 'migration 0005: live corroboration skipped — could not read auth.users (% %)', sqlstate, sqlerrm;
      return;
  end;

  if v_uid is null then
    raise notice 'migration 0005: live corroboration skipped — no active organization_admin or property_manager is seeded yet';
    return;
  end if;

  begin
    insert into public.inbound_messages (
      organization_id, provider, external_message_id, from_identifier, body, status
    )
    values (
      null,
      'migration-0005-selfcheck',
      -- Unqualified deliberately: this DO block does not pin search_path, and
      -- `gen_random_uuid` is a pg_catalog builtin in Postgres 13+ regardless of
      -- which schema 0001's pgcrypto landed in.
      'migration-0005-selfcheck-' || gen_random_uuid()::text,
      'selfcheck',
      'selfcheck body that no organization may read',
      'unmatched'
    )
    returning id into v_msg;

    perform set_config('role', 'authenticated', true);
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
      true
    );

    -- Can a real, active staff member see the planted row?
    select count(*) into v_seen
    from public.inbound_messages m
    where m.id = v_msg;

    -- And can they see ANY unattributed row, planted or otherwise?
    select count(*) into v_allnul
    from public.inbound_messages m
    where m.organization_id is null;

    -- Unwind. Everything above — the row, the role, the claims — goes away with
    -- this subtransaction.
    raise exception 'migration-0005-selfcheck-unwind' using errcode = 'P0001';
  exception
    when others then
      v_err := sqlstate || ' ' || sqlerrm;
  end;

  perform set_config('role', 'none', true);

  if v_seen is null or v_allnul is null then
    raise notice
      'migration 0005: live corroboration could not run (%). The structural assertion in section 7 (1) still holds.',
      coalesce(v_err, 'unknown');
    return;
  end if;

  if v_seen <> 0 or v_allnul <> 0 then
    raise exception
      'migration 0005: LIVE LEAK. An active staff member of organization % can see % unattributed row(s), including % planted one(s). A message that belongs to no organization is being shown to one.',
      v_org, v_allnul, v_seen;
  end if;

  if v_err is not null and v_err not like '%migration-0005-selfcheck-unwind%' then
    raise notice
      'migration 0005: live corroboration unwound on an unexpected error (%), but the reads it did complete showed zero rows.',
      v_err;
  end if;

  raise notice
    'migration 0005: live corroboration passed — real staff of organization % saw 0 unattributed messages; the planted row was invisible and has been rolled back',
    v_org;
end
$live5$;


-- =============================================================================
-- End of migration 0005.
-- =============================================================================
