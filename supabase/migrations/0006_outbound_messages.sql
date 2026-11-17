-- =============================================================================
-- Migration 0006 — public.outbound_messages: a durable record of every message
--                  this system has sent to a tenant
--
-- Lane: the defect reported by the outbound/WhatsApp lane (w3-l6). Owns exactly
-- one file: this one. 0001–0005 are applied history and are not touched.
--
-- -----------------------------------------------------------------------------
-- THE DEFECT
-- -----------------------------------------------------------------------------
-- `services/integrations/whatsapp/outbound.ts` guarantees "a send happens at
-- most once per idempotency key" with `InMemoryIdempotencyStore`, and its own
-- doc comment is honest about what that is worth:
--
--     "this survives a retry inside one Node process and nothing else. On a
--      serverless platform two concurrent invocations have two maps, and a cold
--      start has an empty one."
--
-- So the acknowledgement a tenant receives when they message us is guarded by a
-- `Map` that a redeploy empties. Replay the webhook after a deploy — or run two
-- instances — and the tenant is messaged twice. The inbound half of the same
-- integration already does this correctly: 0004 §5 gives `webhook_events` a
-- `unique (provider, event_id)` and states the reason plainly — an application
-- check has a race between "have I seen this?" and "record that I have", and a
-- unique index has no such window. The outbound half had no such table.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES
-- -----------------------------------------------------------------------------
-- Creates the ledger, with the same posture the inbound side already has:
--
--   * Staff of the owning organization may SELECT. Nobody else — not the tenant
--     the message was sent to, not a property owner, not a service provider.
--     The predicate is `public.is_org_staff()` from 0002; no new predicate is
--     invented here, because a second predicate is a second thing to get wrong.
--   * No client INSERT, UPDATE or DELETE policy and no such privilege. The row
--     is written by whatever holds the service-role client. A staff member who
--     sends a reply does so through a route, not through PostgREST. A client
--     that could write this table could claim the system had said something to a
--     tenant that it never said, or erase something it did.
--   * A partial unique index on `(inbound_message_id) where kind =
--     'acknowledgement'` — the durable replacement for the in-memory store, for
--     the case that actually reaches a human. Postgres refuses the second
--     acknowledgement; no application code has to remember to.
--   * No DELETE path at all (CLAUDE.md rule 6). The record of what we said to a
--     person is exactly the kind of thing that must not be quietly removable.
--
-- -----------------------------------------------------------------------------
-- WHY organization_id IS NOT NULL HERE, WHEN IT IS NULLABLE ON inbound_messages
-- -----------------------------------------------------------------------------
-- 0004 §5 made `inbound_messages.organization_id` nullable on purpose: a message
-- ARRIVES from a phone number, and until that number resolves to exactly one
-- tenant we genuinely do not know whose data it is. Guessing is the cross-tenant
-- leak this project exists to prevent, so the row is written unattributed and is
-- visible to no organization (0005 then gave the platform-operator plane a way
-- to see that dead letter without any organization seeing it).
--
-- The outbound direction has no equivalent moment of ignorance. We never reply
-- to a message we could not attribute: if we did not resolve the sender we do
-- not know which organization's voice we would be speaking in, which tenant's
-- data we might quote, or which organization's audit trail should carry it. A
-- send decision that cannot name an organization is a send that must not happen.
-- Therefore there is no null case to model, `organization_id` is NOT NULL, and
-- the trigger in §4 additionally refuses to let an outbound row reference an
-- inbound message that is itself still unattributed — so the invariant holds
-- transitively, not just locally.
--
-- A happy consequence: 0005 §7 (1) — "no policy may admit a null-organization
-- row to a tenant-scoped role" — scopes itself to tables with a NULLABLE
-- `organization_id`, so this table is outside it by construction rather than by
-- passing a text match. Re-running 0005 after 0006 still passes.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
-- -----------------------------------------------------------------------------
--   * It adds no write RPC. The brief is that the service role writes these
--     rows; a `security definer` insert function would be a second, parallel
--     contract for six lanes already coding against the table itself.
--   * It does not alter `inbound_messages`, `tenants` or `profiles`. The
--     cross-organization integrity rules in §4 are enforced by a trigger ON THIS
--     TABLE reading those tables, rather than by composite foreign keys, so that
--     nothing in 0001–0005 changes shape underneath a concurrent lane. See the
--     note in §1 on what that costs.
--   * It does not write audit rows. An outbound message IS the audit row for
--     "we said this"; the decision that produced it is audited by the route that
--     made it, through `public.log_audit`.
-- =============================================================================


-- =============================================================================
-- 0. Preconditions — fail loudly before anything is created
-- =============================================================================
do $pre6$
declare
  v_dupes bigint := 0;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'inbound_messages'
  ) then
    raise exception
      'migration 0006: public.inbound_messages is missing. Apply 0004 before 0006 — an outbound message exists to answer an inbound one.'
      using errcode = '42P01';
  end if;

  if pg_catalog.to_regprocedure('public.is_org_staff(uuid)') is null then
    raise exception
      'migration 0006: public.is_org_staff(uuid) is missing. Apply 0002 before 0006. This migration must reuse that predicate rather than write a second one.'
      using errcode = '42883';
  end if;

  -- The read policy below is a copy of the posture 0004 chose for
  -- `inbound_messages`. If that policy has been renamed or removed, the premise
  -- has changed and a human should reconcile rather than let this file install a
  -- matching twin of something that is no longer there.
  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'inbound_messages'
      and p.policyname = 'inbound_messages_select_staff'
  ) then
    raise exception
      'migration 0006: policy inbound_messages_select_staff is missing. 0006 mirrors it deliberately; reconcile 0004/0005 before applying 0006.'
      using errcode = '42704';
  end if;

  -- §3 creates a UNIQUE index. On a re-apply against a table that somehow
  -- already holds two acknowledgements for one inbound message, index creation
  -- would fail with a bare 23505 naming nothing useful. Say what is wrong.
  --
  -- Through EXECUTE, not as a static query: PL/pgSQL plans every statement in a
  -- block the first time the block runs, so a direct reference to
  -- `public.outbound_messages` would fail to parse on the FIRST application —
  -- when the table does not exist yet — no matter what the guard around it says.
  if exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'outbound_messages'
  ) then
    execute $q$
      select count(*) from (
        select 1
        from public.outbound_messages o
        where o.kind = 'acknowledgement'
          and o.inbound_message_id is not null
        group by o.inbound_message_id
        having count(*) > 1
      ) d
    $q$ into v_dupes;
  end if;

  if v_dupes > 0 then
    raise exception
      'migration 0006: public.outbound_messages already holds more than one acknowledgement for a single inbound message. That is the duplicate send this migration exists to make impossible; investigate the rows before enforcing the constraint over them.'
      using errcode = '23505';
  end if;

  raise notice 'migration 0006: preconditions satisfied';
end
$pre6$;


-- =============================================================================
-- 1. public.outbound_messages — the ledger
-- =============================================================================
--
-- THE COLUMN SET IS FROZEN. Six lanes are coding against exactly these names and
-- types; nothing here renames, adds or drops one. Everything this migration adds
-- on top is a CONSTRAINT, an INDEX, a POLICY or a TRIGGER — things that narrow
-- what may be stored without changing what may be referenced.
--
-- On the foreign keys, and what the frozen shape costs:
--
--   `inbound_message_id references inbound_messages(id)` and `tenant_id
--   references tenants(id)` are single-column references, so Postgres will
--   happily let an outbound row in Organization A point at Organization B's
--   inbound message or Organization B's tenant. 0001 avoids this everywhere
--   else by referencing `(organization_id, id)` — both `tenants` and
--   `maintenance_tickets` carry a `unique (organization_id, id)` precisely so
--   that composite foreign keys can pin the organization — and 0004 §5 went to
--   the trouble of adding `inbound_messages_ticket_requires_org` because a
--   MATCH SIMPLE composite key is not enforced at all when a referenced column
--   is null.
--
--   The composite form is not used here for two reasons. First, the column list
--   is frozen and `on delete set null` on a composite key would have to null
--   `organization_id` too, which is NOT NULL — Postgres's column-list form of
--   `on delete set null` would be needed, and that is version-dependent.
--   Second, `inbound_messages` has no `unique (organization_id, id)` to
--   reference, and adding one is a change to another lane's table.
--
--   So the cross-organization rule is enforced by the trigger in §4 instead. It
--   is strictly STRONGER than a composite foreign key would be (it also rejects
--   an inbound message that is unattributed, which a composite key cannot
--   express), and it is weaker in exactly one respect: it is checked at write
--   time rather than continuously. Nothing may move an `organization_id` after
--   the fact — 0003 §5.1 pins tickets, 0005 §3 pins inbound messages, and §4
--   below pins these rows — so there is no later moment at which a pairing that
--   was legal becomes illegal. Flagged in the lane report, not hidden here.
create table if not exists public.outbound_messages (
  id uuid primary key default gen_random_uuid(),

  -- NOT NULL, unlike inbound_messages. See the header: an unattributed message
  -- is never replied to, so there is no "we do not know whose this is" state to
  -- represent on this side. A send we cannot attribute is a send that must not
  -- happen, and the database is where that sentence is made unarguable.
  organization_id uuid not null references public.organizations(id) on delete cascade,

  inbound_message_id uuid references public.inbound_messages(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete set null,

  to_identifier text not null,
  body text not null,

  kind text not null check (kind in ('acknowledgement', 'staff_reply')),
  drafted_by text not null check (drafted_by in ('system', 'ai', 'human')),

  sent_by_profile_id uuid references public.profiles(id),

  provider text not null default 'whatsapp',
  provider_message_id text,

  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed')),

  created_at timestamptz not null default now(),
  sent_at timestamptz,

  -- -------------------------------------------------------------------------
  -- An acknowledgement must name the thing it acknowledges.
  --
  -- This is not tidiness; it closes the hole in §3's unique index. A unique
  -- index treats NULLs as distinct, so without this constraint an unbounded
  -- number of acknowledgement rows with a null `inbound_message_id` would
  -- satisfy it, and the idempotency guarantee could be bypassed by simply not
  -- filling in the column. The constraint makes the index total over the set it
  -- claims to cover.
  constraint outbound_messages_ack_names_inbound
    check (kind <> 'acknowledgement' or inbound_message_id is not null),

  -- -------------------------------------------------------------------------
  -- CLAUDE.md rule 7, in the schema: no model output reaches a tenant without
  -- an authenticated human in between. A row drafted by the model, or by a
  -- human, must name the profile that committed it. Only `system` — the
  -- automatic acknowledgement, whose text is a fixed template and not model
  -- output — may be sent with nobody's name on it.
  constraint outbound_messages_human_commits
    check (drafted_by = 'system' or sent_by_profile_id is not null),

  -- A staff reply with no staff member behind it is a contradiction in terms.
  constraint outbound_messages_staff_reply_has_sender
    check (kind <> 'staff_reply' or sent_by_profile_id is not null),

  -- -------------------------------------------------------------------------
  -- Shape checks, in the style of 0004's `btrim(provider) <> ''`.
  --
  -- `to_identifier` is documented as "E.164, canonicalised by the caller". The
  -- repository's own canonicaliser, `normalisePhone` in
  -- services/integrations/whatsapp/phone.ts, returns DIGITS WITH NO LEADING `+`
  -- (`E164_DIGITS = /^[1-9]\d{7,14}$/`), because that is what Meta's Cloud API
  -- wants on the wire, while "E.164" in prose normally means the `+`-prefixed
  -- form. The two conventions disagree, and this migration is not the place to
  -- pick a winner for six lanes, so the check accepts BOTH and rejects
  -- everything else: no blanks, no whitespace, no letters, no `whatsapp:`
  -- scheme prefix, no leading zero. The divergence is in the lane report.
  constraint outbound_messages_to_identifier_shape
    check (to_identifier ~ '^\+?[1-9][0-9]{7,14}$'),

  constraint outbound_messages_body_not_blank
    check (btrim(body) <> ''),

  constraint outbound_messages_provider_not_blank
    check (btrim(provider) <> ''),

  constraint outbound_messages_provider_message_id_not_blank
    check (provider_message_id is null or btrim(provider_message_id) <> '')
);


-- =============================================================================
-- 2. Row level security — staff of the owning organization read; nobody writes
-- =============================================================================
alter table public.outbound_messages enable row level security;

-- Goal 1 and Goal 2. `is_org_staff` is `organization_admin` or
-- `property_manager` (0002), resolved from the caller's own trusted
-- `organization_members` row — never from anything the client sent. A tenant is
-- not staff, so the tenant who RECEIVED the message cannot read it back here;
-- they have it on their phone, and the operational record of what the
-- organization said is an operational record, not a tenant-facing one. A
-- property owner is not staff either: 0004 §1 already established that owners
-- are kept away from tenant contact details, and a message addressed to a phone
-- number is a contact detail with a body attached.
--
-- `(select ...)` wraps the call so the planner evaluates it once per statement
-- rather than once per row — the same form every policy in 0002 and 0004 uses.
drop policy if exists outbound_messages_select_staff on public.outbound_messages;
create policy outbound_messages_select_staff
on public.outbound_messages
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- No INSERT, UPDATE or DELETE policy, and no such privilege. Two layers, for
-- the reason 0004 §6 spells out: a missing policy is quiet (zero rows affected),
-- a missing privilege is loud (42501), and the negative-write suite wants loud.
-- The REVOKE is also what keeps the absence of policies meaningful under
-- amendment — a well-meant policy added later still cannot open the path.
--
-- The writers are: the inbound job, which holds the service-role client and
-- inserts the acknowledgement; and the staff-reply route, which authenticates
-- the human, authorises them with `resolveMembership()`, and then writes with
-- the service-role client in that human's name via `sent_by_profile_id`. The
-- service role bypasses both RLS and these grants, which is exactly why the
-- integrity trigger in §4 exists: it is the only one of the three layers that
-- still applies to the service role.
revoke all on table public.outbound_messages from anon;
revoke insert, update, delete, truncate on table public.outbound_messages from authenticated;
grant select on table public.outbound_messages to authenticated;

-- The inbox reads an organization's send history newest-first.
create index if not exists idx_outbound_messages_org
  on public.outbound_messages (organization_id, created_at desc);

-- The thread view: "what did we send in reply to this message?"
create index if not exists idx_outbound_messages_inbound
  on public.outbound_messages (inbound_message_id)
  where inbound_message_id is not null;

-- The retry sweep looks only at work that has not finished. Partial, because
-- the overwhelming majority of rows are 'sent' and never need visiting again.
create index if not exists idx_outbound_messages_pending
  on public.outbound_messages (created_at)
  where status in ('queued', 'failed');

comment on table public.outbound_messages is
  'Durable ledger of messages this system has sent to tenants. Replaces the per-process idempotency map in services/integrations/whatsapp/outbound.ts: the partial unique index outbound_messages_one_ack_per_inbound makes a second acknowledgement for one inbound message impossible in the database rather than in a Map that a redeploy empties. Staff of the owning organization may SELECT; no client role may write.';
comment on column public.outbound_messages.organization_id is
  'NOT NULL, unlike inbound_messages.organization_id. We never reply to a message we could not attribute, so there is no unattributed state on the outbound side. The §4 trigger also refuses to reference an inbound message that is itself unattributed.';
comment on column public.outbound_messages.body is
  'The text sent to the tenant. Never log this (CLAUDE.md rule 8).';
comment on column public.outbound_messages.to_identifier is
  'Destination phone number, canonicalised by the caller. Personal data: never log it (CLAUDE.md rule 8). Accepted shapes are the +-prefixed E.164 form and the bare-digit form that services/integrations/whatsapp/phone.ts produces.';
comment on column public.outbound_messages.provider_message_id is
  'The provider''s own id for the delivered message — the wamid for WhatsApp. Write-once: filled when the provider accepts, never rewritten, because it is the only link between this row and the provider-side record.';
comment on column public.outbound_messages.sent_by_profile_id is
  'The human who committed the send. Required whenever drafted_by is not ''system'' (CLAUDE.md rule 7). Must be a member of organization_id, enforced by the §4 trigger.';
comment on column public.outbound_messages.status is
  'queued -> sent, or queued -> failed -> queued (a retry). ''sent'' is terminal: see the §4 trigger for why a row may never be moved back out of it.';


-- =============================================================================
-- 3. The uniqueness guarantee — a duplicate acknowledgement is impossible
-- =============================================================================
--
-- This index is the point of the whole migration.
--
-- The acknowledgement is the automatic "we have received your message" sent back
-- to a tenant. It is triggered by an inbound webhook delivery, and a webhook
-- delivery is retried by the provider whenever it does not see a timely 200 —
-- including when we did all the work and the acknowledgement was already on its
-- way. 0004 §5 already stops the DELIVERY being processed twice
-- (`webhook_events (provider, event_id)`), but a retry can also arrive as a
-- genuinely new delivery of the same message, and the job itself can crash
-- between "the provider accepted our reply" and "we recorded that it did". The
-- natural, stable key for "have we already answered this?" is the inbound
-- message, not the delivery.
--
-- PARTIAL, on `kind = 'acknowledgement'` only, because staff replies are the
-- opposite case: a human may legitimately send three messages about one inbound
-- complaint, and a unique index over all kinds would silently forbid the second.
--
-- The handler shape, matching the one 0004 §5 prescribes for webhook_events:
--
--     insert into public.outbound_messages
--       (organization_id, inbound_message_id, tenant_id, to_identifier, body,
--        kind, drafted_by)
--     values ($1, $2, $3, $4, $5, 'acknowledgement', 'system')
--     on conflict (inbound_message_id) where kind = 'acknowledgement'
--     do nothing
--     returning id;
--
-- An empty result means this inbound message has ALREADY been acknowledged. Do
-- not send. The row is claimed before the provider call, not after, so the
-- window the in-memory store had — between sending and recording — does not
-- exist: the claim is the transaction, and a crash after it leaves a 'queued'
-- row for the retry sweep rather than a second message on a tenant's phone.
--
-- A FAILED ACKNOWLEDGEMENT IS RETRIED BY UPDATING THIS ROW, NOT BY INSERTING
-- ANOTHER. That asymmetry is deliberate and it is the whole trade: this table
-- prefers "never twice" over "always at least once". Messaging a person twice
-- because a retry looked like a new event is a worse failure, for a system whose
-- entire premise is that it is careful with other people's data, than failing to
-- acknowledge and letting a human notice the un-replied thread in the inbox.
create unique index if not exists outbound_messages_one_ack_per_inbound
  on public.outbound_messages (inbound_message_id)
  where kind = 'acknowledgement';

comment on index public.outbound_messages_one_ack_per_inbound is
  'At most one acknowledgement per inbound message, enforced by Postgres. The durable replacement for InMemoryIdempotencyStore. Retry a failed acknowledgement by UPDATING the existing row; a second INSERT is meant to fail.';


-- =============================================================================
-- 4. Integrity that still applies to the service role
-- =============================================================================
--
-- Policies and privileges stop clients. The writer of this table is the service
-- role, which bypasses both — so if nothing else existed, a bug in the inbound
-- job could write Organization A's reply against Organization B's tenant, or
-- rewind a 'sent' row to 'queued' and send a tenant the same message again. The
-- same argument 0003 §5.1 and 0005 §3 make, applied to the same kind of risk.
--
-- A `before insert or update` trigger is the one layer that applies to every
-- writer, including the service role and including a future migration.
--
-- SECURITY DEFINER because the checks must read `inbound_messages`, `tenants`
-- and `organization_members` and reach the TRUE rows. Under the service role
-- that happens anyway; under any other writer, an RLS-filtered read would make
-- a legitimate row look absent and the trigger would reject a valid write for
-- the wrong reason. An integrity check that fails open on visibility is not an
-- integrity check. `search_path` is pinned to '' and every name below is
-- schema-qualified, which is what makes the definer rights safe to hold.
create or replace function public.outbound_message_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $omi6$
declare
  v_org uuid;
begin
  -- -------------------------------------------------------------------------
  -- (a) What may never change once written.
  --
  -- The value of a send ledger is that it says what was actually sent. A row
  -- whose body or destination can be edited afterwards records what someone
  -- later wished had been sent. `organization_id` is pinned for the stronger
  -- reason: moving a row between organizations is a cross-tenant transfer of
  -- the content of a message to a named person.
  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id then
      raise exception 'outbound_message_immutable: organization_id cannot change'
        using errcode = 'P0001',
              hint = 'A sent message belongs permanently to the organization that sent it. Moving it is a cross-tenant transfer of tenant content.';
    end if;

    if new.to_identifier is distinct from old.to_identifier
       or new.body is distinct from old.body
       or new.kind is distinct from old.kind
       or new.drafted_by is distinct from old.drafted_by
       or new.provider is distinct from old.provider
       or new.created_at is distinct from old.created_at then
      raise exception 'outbound_message_immutable: to_identifier, body, kind, drafted_by, provider and created_at are fixed at insert'
        using errcode = 'P0001',
              hint = 'This table records what was sent. Correct a mistake by sending another message, not by editing the record of the first one.';
    end if;

    -- Write-once columns: null may become a value, a value may never become a
    -- different value or null. Same one-way shape as 0005 §3.
    if old.inbound_message_id is not null
       and new.inbound_message_id is distinct from old.inbound_message_id then
      raise exception 'outbound_message_immutable: inbound_message_id may be filled in once and never changed or cleared'
        using errcode = 'P0001';
    end if;

    if old.tenant_id is not null and new.tenant_id is distinct from old.tenant_id then
      raise exception 'outbound_message_immutable: tenant_id may be filled in once and never changed or cleared'
        using errcode = 'P0001';
    end if;

    if old.sent_by_profile_id is not null
       and new.sent_by_profile_id is distinct from old.sent_by_profile_id then
      raise exception 'outbound_message_immutable: sent_by_profile_id may be filled in once and never changed or cleared'
        using errcode = 'P0001',
              hint = 'The named human is the human-confirmation evidence for CLAUDE.md rule 7. Reassigning it would relabel who approved a message to a tenant.';
    end if;

    if old.provider_message_id is not null
       and new.provider_message_id is distinct from old.provider_message_id then
      raise exception 'outbound_message_immutable: provider_message_id may be filled in once and never changed or cleared'
        using errcode = 'P0001';
    end if;

    -- -----------------------------------------------------------------------
    -- (b) 'sent' is terminal.
    --
    -- This is the second half of the duplicate-send defence and it is just as
    -- important as the unique index. §3 stops a SECOND acknowledgement row;
    -- this stops the FIRST one being rewound. A retry sweep that selects
    -- `status in ('queued','failed')` would otherwise pick up any row a bug had
    -- moved back out of 'sent', and send a tenant a message they already have.
    -- 'failed' -> 'queued' remains legal because a failed send genuinely did
    -- not reach anyone, and without it there would be no retry path at all.
    if old.status = 'sent' and new.status <> 'sent' then
      raise exception 'outbound_message_sent_is_terminal: a message that has been sent cannot return to % ', new.status
        using errcode = 'P0001',
              hint = 'Nothing can unsend a message. If it must be corrected, send another one. A row that leaves ''sent'' would be picked up by the retry sweep and the tenant would be messaged twice.';
    end if;
  end if;

  -- -------------------------------------------------------------------------
  -- (c) sent_at always agrees with status, without ever rejecting a caller for
  --     it. A route that writes `set status = 'sent', provider_message_id = $1`
  --     and forgets the timestamp gets a correct one; a row that is queued or
  --     failed has no send time, because it was not sent.
  if new.status = 'sent' then
    if new.sent_at is null then
      new.sent_at := now();
    end if;
  else
    new.sent_at := null;
  end if;

  -- -------------------------------------------------------------------------
  -- (d) Cross-organization integrity — the part a single-column foreign key
  --     cannot express. See the note in §1.
  if new.inbound_message_id is not null
     and (tg_op = 'INSERT' or new.inbound_message_id is distinct from old.inbound_message_id) then
    select m.organization_id into v_org
    from public.inbound_messages m
    where m.id = new.inbound_message_id;

    if v_org is null then
      -- Covers both "no such row" and "the row is still unattributed". The
      -- second is the one that matters: replying to a message whose sender we
      -- could not resolve means answering in an organization's name on the
      -- strength of a guess. 0005 exists because that guess is forbidden.
      raise exception 'outbound_message_inbound_unattributed: inbound message % is unattributed or absent, so nothing may be sent in reply to it', new.inbound_message_id
        using errcode = 'P0001',
              hint = 'Attribute the inbound message first. A reply to an unresolved sender would speak in an organization''s voice on the basis of a guess.';
    end if;

    if v_org <> new.organization_id then
      raise exception 'outbound_message_cross_organization: inbound message % belongs to another organization', new.inbound_message_id
        using errcode = 'P0001',
              hint = 'Organization A may not record a reply to Organization B''s message. This is the isolation boundary the project is judged on.';
    end if;
  end if;

  if new.tenant_id is not null
     and (tg_op = 'INSERT' or new.tenant_id is distinct from old.tenant_id) then
    select t.organization_id into v_org
    from public.tenants t
    where t.id = new.tenant_id;

    if v_org is null or v_org <> new.organization_id then
      raise exception 'outbound_message_cross_organization: tenant % does not belong to organization %', new.tenant_id, new.organization_id
        using errcode = 'P0001',
              hint = 'A tenant-scoped reference must stay inside its own organization. 0001 uses composite foreign keys for this everywhere it can; the frozen column list here cannot, so the rule lives in this trigger.';
    end if;
  end if;

  -- The named human must belong to the organization whose message they sent.
  -- Membership, not active membership: the check asks "could this person have
  -- been acting for this organization", which is the isolation question, and it
  -- fires only when the column is written. Whether they were in good standing at
  -- that instant is the route's authorization decision, made by
  -- `resolveMembership()` before the row is ever written.
  if new.sent_by_profile_id is not null
     and (tg_op = 'INSERT' or new.sent_by_profile_id is distinct from old.sent_by_profile_id) then
    if not exists (
      select 1 from public.organization_members om
      where om.profile_id = new.sent_by_profile_id
        and om.organization_id = new.organization_id
    ) then
      raise exception 'outbound_message_cross_organization: profile % is not a member of organization %', new.sent_by_profile_id, new.organization_id
        using errcode = 'P0001',
              hint = 'sent_by_profile_id is the human-confirmation evidence for this send. A human who is not a member of the organization cannot have confirmed on its behalf.';
    end if;
  end if;

  return new;
end
$omi6$;

comment on function public.outbound_message_integrity() is
  'Trigger function for public.outbound_messages. Enforces, against every writer including the service role: the record of a send is immutable; ''sent'' is terminal; sent_at agrees with status; and every reference (inbound message, tenant, sending human) stays inside organization_id. This is the only one of the three protection layers that the service role does not bypass.';

drop trigger if exists outbound_messages_integrity on public.outbound_messages;
create trigger outbound_messages_integrity
  before insert or update on public.outbound_messages
  for each row execute function public.outbound_message_integrity();


-- =============================================================================
-- 5. No DELETE path (CLAUDE.md rule 6), for any role
-- =============================================================================
-- §2 revoked DELETE from the client roles, but the service role writes this
-- table and is not stopped by a grant. There is no legitimate reason for any
-- code path to delete a record of something that was said to a person: the
-- lifecycle has no archival state to move to and no retention job in the plan.
-- A trigger is the layer that still applies.
--
-- `organizations ... on delete cascade` on `organization_id` is deliberately
-- NOT defeated by this: a row removed because its entire organization was
-- removed is a cascade, and `tg_op = 'DELETE'` on a cascade still fires here —
-- so the cascade would fail too. That is the correct outcome. Deleting an
-- organization that has messaged real people is not a routine operation, and if
-- it is ever performed deliberately it should be performed deliberately: drop
-- this trigger in a migration that says why, and recreate it afterwards.
create or replace function public.outbound_messages_no_delete()
returns trigger
language plpgsql
set search_path = ''
as $ond6$
begin
  raise exception 'outbound_messages_append_only: rows in public.outbound_messages are never deleted'
    using errcode = 'P0001',
          hint = 'This table is the record of what was said to a person (CLAUDE.md rule 6). There is no archive state because nothing here should ever need hiding; if a retention policy is adopted, it arrives as a migration that states its legal basis.';
  return null;
end
$ond6$;

comment on function public.outbound_messages_no_delete() is
  'Trigger function. Refuses every DELETE on public.outbound_messages, including by the service role and including an organizations cascade. CLAUDE.md rule 6.';

drop trigger if exists outbound_messages_block_delete on public.outbound_messages;
create trigger outbound_messages_block_delete
  before delete on public.outbound_messages
  for each row execute function public.outbound_messages_no_delete();

-- TRUNCATE ignores row level security, ignores DELETE triggers, and empties a
-- table in one statement. §6 revokes the privilege from the client roles; this
-- is the layer that also stops whoever holds it anyway.
create or replace function public.outbound_messages_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $ont6$
begin
  raise exception 'outbound_messages_append_only: public.outbound_messages cannot be truncated'
    using errcode = 'P0001';
  return null;
end
$ont6$;

drop trigger if exists outbound_messages_block_truncate on public.outbound_messages;
create trigger outbound_messages_block_truncate
  before truncate on public.outbound_messages
  for each statement execute function public.outbound_messages_no_truncate();


-- =============================================================================
-- 6. TRUNCATE — the standing requirement from 0002 §4a, 0004 §7 and 0005 §6
-- =============================================================================
-- Copied from 0005 §6 and re-run because this migration adds a table.
--
-- TRUNCATE ignores row level security completely, and Supabase's default
-- privileges grant it to `authenticated` and `anon` on every table at creation
-- time. 0002 found that a principal with no membership at all could truncate
-- `audit_logs` to zero, and 0004 recorded that `supabase_admin`'s default ACL
-- still carries the `D` and cannot be altered by the migration role — so
-- `public.outbound_messages` may well have arrived with that grant attached a
-- few hundred lines above. Re-run the loop over EVERY table in `public`, for the
-- same reason 0002, 0004 and 0005 did: a hand-written list is a hole waiting for
-- the next migration.
--
-- THIS IS NOT OPTIONAL AND IT IS NOT A COPY-PASTE ARTEFACT. Omitting it would
-- leave the new table truncatable by `anon`, and would also make a re-run of
-- 0005 §7 (11) fail, since that assertion sweeps the whole schema.
do $trunc6$
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
    'migration 0006: TRUNCATE revoked from authenticated and anon on % table(s) in schema public',
    touched;
end
$trunc6$;

do $defacl6$
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
      'migration 0006: still cannot revoke TRUNCATE from the default privileges of role(s) %. ANY LATER MIGRATION THAT ADDS A TABLE MUST RE-RUN THE REVOKE LOOP IN SECTION 6.',
      array_to_string(unreached, ', ');
  end if;
end
$defacl6$;


-- =============================================================================
-- 7. Self-check — refuse to ship a hole
-- =============================================================================
-- In the style of 0002 §7, 0004 §8 and 0005 §7: cheap, idempotent assertions
-- that RAISE rather than warn. Every one of them is written against the system
-- catalogue rather than against this file's own text, so it is still true after
-- someone else edits the table in a later migration.
do $check6$
declare
  offending text;
  missing   text;
begin
  -- ---------------------------------------------------------------------
  -- (1) The table exists and the frozen column contract is intact.
  --     Six lanes are coding against this exact list. A migration that
  --     renamed a column would compile fine and break all of them at runtime,
  --     so the contract is asserted rather than assumed.
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'outbound_messages' and c.relkind = 'r'
  ) then
    raise exception 'migration 0006: public.outbound_messages was not created.';
  end if;

  select string_agg(want.col, ', ' order by want.col)
    into missing
  from (values
    ('id'), ('organization_id'), ('inbound_message_id'), ('tenant_id'),
    ('to_identifier'), ('body'), ('kind'), ('drafted_by'),
    ('sent_by_profile_id'), ('provider'), ('provider_message_id'),
    ('status'), ('created_at'), ('sent_at')
  ) as want(col)
  where not exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'outbound_messages'
      and a.attname = want.col
      and a.attnum > 0
      and not a.attisdropped
  );

  if missing is not null then
    raise exception
      'migration 0006: the frozen column contract is broken — public.outbound_messages is missing: %. Six lanes code against this exact column list.', missing;
  end if;

  -- ---------------------------------------------------------------------
  -- (2) organization_id is NOT NULL. The header argues at length that there is
  --     no unattributed state on the outbound side; this is that argument made
  --     enforceable. If it ever becomes nullable, 0005 §7 (1) starts applying
  --     to this table and the SELECT policy below would fail it — but this
  --     assertion fires first and says why.
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'outbound_messages'
      and a.attname = 'organization_id'
      and a.attnotnull
  ) then
    raise exception
      'migration 0006: public.outbound_messages.organization_id is nullable. An outbound message that belongs to no organization is a message sent in nobody''s name; there is no such thing, and the SELECT policy has no null guard because there was not supposed to be a null case.';
  end if;

  -- ---------------------------------------------------------------------
  -- (3) Row level security is ON. Without this line every assertion about
  --     policies below is decoration.
  if not exists (
    select 1
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'outbound_messages'
      and c.relrowsecurity
  ) then
    raise exception
      'migration 0006: row level security is not enabled on public.outbound_messages. Every policy below is unenforced until it is.';
  end if;

  -- ---------------------------------------------------------------------
  -- (4) NO POLICY GRANTS A CLIENT INSERT, UPDATE OR DELETE.
  --     `ALL` counts: a policy `for all` covers writes even if whoever wrote it
  --     was only thinking about reads. RESTRICTIVE policies are excluded
  --     because they can only narrow, never admit.
  select string_agg(format('%s (%s, %s)', p.policyname, p.cmd, p.permissive), ', ' order by p.policyname)
    into offending
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'outbound_messages'
    and p.permissive = 'PERMISSIVE'
    and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL');

  if offending is not null then
    raise exception
      'migration 0006: a policy admits a client write to public.outbound_messages: %. This table is written by the service role only. A client that can write it can claim the system said something to a tenant that it never said.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (5) Exactly one policy, and it is the staff read policy resolving through
  --     is_org_staff. (4) proves nothing bad exists; this proves the right
  --     thing does, and that it has not been quietly rewritten to use some
  --     hand-rolled predicate instead of the one 0002 owns.
  select string_agg(p.policyname || ' (' || p.cmd || ')', ', ' order by p.policyname)
    into offending
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = 'outbound_messages'
    and p.policyname <> 'outbound_messages_select_staff';

  if offending is not null then
    raise exception
      'migration 0006: unexpected policy/policies on public.outbound_messages: %. It takes exactly one SELECT policy and no client write path.', offending;
  end if;

  if not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public'
      and p.tablename = 'outbound_messages'
      and p.policyname = 'outbound_messages_select_staff'
      and p.cmd = 'SELECT'
      and p.roles = array['authenticated']::name[]
      and coalesce(p.qual, '') like '%is_org_staff%'
  ) then
    raise exception
      'migration 0006: outbound_messages_select_staff is missing, is no longer SELECT-only, is granted to a role other than authenticated, or no longer resolves through public.is_org_staff(). The read boundary of this table is that one predicate.';
  end if;

  -- ---------------------------------------------------------------------
  -- (6) NO CLIENT ROLE HOLDS A WRITE PRIVILEGE, inherited grants included.
  --     `has_table_privilege` answers the real question — what can this role
  --     actually do — rather than what the ACL happens to list, so a privilege
  --     arriving through PUBLIC or through role membership is caught too.
  select string_agg(format('%s:%s', g.rolname, priv), ', ' order by g.rolname, priv)
    into offending
  from (
    select rolname from pg_catalog.pg_roles where rolname in ('authenticated', 'anon')
  ) g
  cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as priv
  where pg_catalog.has_table_privilege(g.rolname, 'public.outbound_messages', priv);

  if offending is not null then
    raise exception
      'migration 0006: a client role holds a write privilege on public.outbound_messages: %. Rows are written by the service role or a security definer function; a staff reply goes through a route, never through PostgREST.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (7) `anon` holds nothing at all — not even SELECT. An unauthenticated
  --     caller has no organization, so `is_org_staff` would return false for
  --     every row anyway; the revoke means the attempt fails loudly instead of
  --     returning an empty list that looks like "no messages".
  select string_agg(priv, ', ' order by priv)
    into offending
  from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
  where pg_catalog.has_table_privilege('anon', 'public.outbound_messages', priv);

  if offending is not null then
    raise exception
      'migration 0006: the anon role holds privilege(s) % on public.outbound_messages. An unauthenticated caller has no business touching a record of messages sent to named people.', offending;
  end if;

  -- ---------------------------------------------------------------------
  -- (8) And the lockdown did not overshoot: staff must still be able to READ,
  --     or the feature does not exist. A self-check that only ever asserts
  --     absence will happily pass on a table nobody can use.
  if not pg_catalog.has_table_privilege('authenticated', 'public.outbound_messages', 'SELECT') then
    raise exception
      'migration 0006: the authenticated role cannot SELECT public.outbound_messages. The organization''s own send history is invisible to its own staff.';
  end if;

  -- ---------------------------------------------------------------------
  -- (9) THE ACKNOWLEDGEMENT UNIQUENESS HOLDS — the reason this file exists.
  --     Asserted from pg_index, not from pg_indexes' text, so that "a unique
  --     index exists with this name" cannot be satisfied by a non-unique one.
  if not exists (
    select 1
    from pg_catalog.pg_index i
    join pg_catalog.pg_class ic on ic.oid = i.indexrelid
    join pg_catalog.pg_class tc on tc.oid = i.indrelid
    join pg_catalog.pg_namespace n on n.oid = tc.relnamespace
    where n.nspname = 'public'
      and tc.relname = 'outbound_messages'
      and ic.relname = 'outbound_messages_one_ack_per_inbound'
      and i.indisunique
      and i.indpred is not null
      and pg_catalog.pg_get_expr(i.indpred, i.indrelid) like '%acknowledgement%'
      and pg_catalog.pg_get_indexdef(i.indexrelid) like '%(inbound_message_id)%'
  ) then
    raise exception
      'migration 0006: outbound_messages_one_ack_per_inbound is missing, is not UNIQUE, is no longer partial on kind = ''acknowledgement'', or is no longer keyed on inbound_message_id. Without it the only thing preventing a tenant being messaged twice is a Map that a redeploy empties.';
  end if;

  -- The index alone is not sufficient, because a unique index treats NULLs as
  -- distinct: without this constraint, acknowledgements with a null
  -- inbound_message_id would be unlimited and the guarantee could be bypassed
  -- by omitting the column.
  if not exists (
    select 1
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'outbound_messages'
      and k.conname = 'outbound_messages_ack_names_inbound'
      and k.contype = 'c'
  ) then
    raise exception
      'migration 0006: constraint outbound_messages_ack_names_inbound is missing. The unique index in section 3 treats NULLs as distinct, so without it an unlimited number of acknowledgements with a null inbound_message_id would satisfy the "uniqueness" guarantee.';
  end if;

  -- And the data agrees with the constraint right now. Index creation would
  -- already have failed, but a later `alter index ... invalid` or a restore
  -- that skipped validation would not.
  if exists (
    select 1
    from public.outbound_messages o
    where o.kind = 'acknowledgement'
    group by o.inbound_message_id
    having count(*) > 1
  ) then
    raise exception
      'migration 0006: public.outbound_messages holds more than one acknowledgement for a single inbound message. At least one tenant has been messaged twice.';
  end if;

  -- ---------------------------------------------------------------------
  -- (10) CLAUDE.md rule 7 is enforced by a constraint, not by convention.
  if not exists (
    select 1
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'outbound_messages'
      and k.conname = 'outbound_messages_human_commits'
      and k.contype = 'c'
  ) then
    raise exception
      'migration 0006: constraint outbound_messages_human_commits is missing. Without it a row drafted by the model could be sent to a tenant with no human named anywhere, which is CLAUDE.md rule 7.';
  end if;

  if exists (
    select 1 from public.outbound_messages o
    where o.drafted_by <> 'system' and o.sent_by_profile_id is null
  ) then
    raise exception
      'migration 0006: a non-system-drafted outbound message names no human sender. AI drafts; humans commit.';
  end if;

  -- ---------------------------------------------------------------------
  -- (11) The integrity trigger exists and is ENABLED. A disabled trigger is
  --      present in the catalogue and does nothing, which is the worst of both
  --      worlds — so `tgenabled <> 'D'` is part of the assertion, as it is in
  --      0005 §7 (8).
  select string_agg(want, ', ' order by want)
    into offending
  from unnest(array[
    'outbound_messages_integrity',
    'outbound_messages_block_delete',
    'outbound_messages_block_truncate'
  ]) as want
  where not exists (
    select 1
    from pg_catalog.pg_trigger tg
    join pg_catalog.pg_class c on c.oid = tg.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'outbound_messages'
      and tg.tgname = want
      and not tg.tgisinternal
      and tg.tgenabled <> 'D'
  );

  if offending is not null then
    raise exception
      'migration 0006: missing or disabled trigger(s) on public.outbound_messages: %. These are the only protections the service role does not bypass.', offending;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_proc pr
    join pg_catalog.pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public'
      and pr.proname = 'outbound_message_integrity'
      and pr.prosecdef
      and coalesce(array_to_string(pr.proconfig, ','), '') like '%search_path=%'
  ) then
    raise exception
      'migration 0006: public.outbound_message_integrity() is not SECURITY DEFINER with a pinned search_path. Definer rights without a pinned search_path are a privilege-escalation path; definer rights are needed because the function must see the true inbound_messages, tenants and organization_members rows.';
  end if;

  -- ---------------------------------------------------------------------
  -- (12) TRUNCATE is gone everywhere in public, inherited grants included.
  --      Copied from 0005 §7 (11) and re-run because this migration created a
  --      table. TRUNCATE bypasses row level security entirely, so a single
  --      surviving grant voids every policy in 0002, 0004, 0005 and this file.
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
      'migration 0006: TRUNCATE is still granted in schema public: %. It ignores row level security, so one surviving grant voids every policy in 0002, 0004, 0005 and 0006.', offending;
  end if;

  raise notice 'migration 0006: self-check passed — RLS on, one staff-only SELECT policy, no client write policy or privilege, acknowledgement uniqueness enforced, integrity triggers live, TRUNCATE revoked';
end
$check6$;


-- =============================================================================
-- 8. Live corroboration — try the duplicate send for real, then roll it back
-- =============================================================================
-- §7 is a structural argument about the catalogue. This is the experiment, in
-- the style of 0005 §8.
--
-- It plants two throwaway organizations, an attributed inbound message and a
-- tenant, and then attempts the four things this migration exists to prevent:
--
--   A. a second acknowledgement for one inbound message   -> expect 23505
--   B. moving a 'sent' row back to 'queued'               -> expect P0001
--   C. an acknowledgement in org X naming org Y's tenant  -> expect P0001
--   D. real staff of a real organization reading org X's rows -> expect 0
--
-- Everything runs inside a PL/pgSQL subtransaction unwound by a deliberate
-- exception, so nothing it creates survives and no DELETE is ever issued (which
-- is just as well — §5 would refuse it). PL/pgSQL variables are not
-- transactional, so the outcomes survive the rollback and can be asserted on.
--
-- A FAILURE TO PREVENT IS FATAL. An inability to RUN the experiment is a NOTICE:
-- a migration that refuses to apply to an empty database is a worse failure than
-- one that reports it could not corroborate what it already proved structurally.
do $live6$
declare
  v_org_x  uuid;
  v_org_y  uuid;
  v_msg1   uuid;
  v_msg2   uuid;
  v_tenant uuid;
  v_row    uuid;
  v_uid    uuid;
  v_a      text;   -- sqlstate of the duplicate acknowledgement attempt
  v_b      text;   -- sqlstate of the sent -> queued attempt
  v_c      text;   -- sqlstate of the cross-organization attempt
  v_d      int;    -- rows of org X visible to unrelated real staff
  v_err    text;
  v_tag    text := 'migration-0006-selfcheck';
begin
  begin
    -- ---- plant -----------------------------------------------------------
    insert into public.organizations (name, slug)
    values (v_tag, v_tag || '-x-' || gen_random_uuid()::text)
    returning id into v_org_x;

    insert into public.organizations (name, slug)
    values (v_tag, v_tag || '-y-' || gen_random_uuid()::text)
    returning id into v_org_y;

    insert into public.inbound_messages (
      organization_id, provider, external_message_id, from_identifier, body, status
    )
    values (v_org_x, v_tag, v_tag || '-1-' || gen_random_uuid()::text,
            '971500000001', 'selfcheck inbound', 'received')
    returning id into v_msg1;

    insert into public.inbound_messages (
      organization_id, provider, external_message_id, from_identifier, body, status
    )
    values (v_org_x, v_tag, v_tag || '-2-' || gen_random_uuid()::text,
            '971500000002', 'selfcheck inbound', 'received')
    returning id into v_msg2;

    insert into public.tenants (organization_id, full_name)
    values (v_org_y, v_tag)
    returning id into v_tenant;

    insert into public.outbound_messages (
      organization_id, inbound_message_id, to_identifier, body, kind, drafted_by
    )
    values (v_org_x, v_msg1, '971500000001', 'selfcheck acknowledgement',
            'acknowledgement', 'system')
    returning id into v_row;

    -- ---- A. the duplicate acknowledgement --------------------------------
    begin
      insert into public.outbound_messages (
        organization_id, inbound_message_id, to_identifier, body, kind, drafted_by
      )
      values (v_org_x, v_msg1, '971500000001', 'selfcheck duplicate',
              'acknowledgement', 'system');
      v_a := 'ACCEPTED';
    exception
      when others then v_a := sqlstate;
    end;

    -- ---- B. unsending ----------------------------------------------------
    update public.outbound_messages
       set status = 'sent', provider_message_id = v_tag || '-wamid'
     where id = v_row;

    begin
      update public.outbound_messages set status = 'queued' where id = v_row;
      v_b := 'ACCEPTED';
    exception
      when others then v_b := sqlstate;
    end;

    -- ---- C. the cross-organization reference -----------------------------
    begin
      insert into public.outbound_messages (
        organization_id, inbound_message_id, tenant_id, to_identifier, body,
        kind, drafted_by
      )
      values (v_org_x, v_msg2, v_tenant, '971500000002', 'selfcheck cross-org',
              'acknowledgement', 'system');
      v_c := 'ACCEPTED';
    exception
      when others then v_c := sqlstate;
    end;

    -- ---- D. can real staff of a real organization see any of it? ---------
    -- Best effort only: needs the authenticated role, auth.users, and at least
    -- one seeded staff member. v_d stays null when the switch cannot be made.
    if pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER') then
      begin
        select u.id into v_uid
        from public.organization_members m
        join public.profiles p on p.id = m.profile_id
        join auth.users u on u.id = p.auth_user_id
        where m.status = 'active'
          and m.role in ('organization_admin', 'property_manager')
          and m.organization_id not in (v_org_x, v_org_y)
        order by m.created_at
        limit 1;

        if v_uid is not null then
          perform set_config('role', 'authenticated', true);
          perform set_config(
            'request.jwt.claims',
            json_build_object('sub', v_uid::text, 'role', 'authenticated')::text,
            true
          );

          select count(*) into v_d
          from public.outbound_messages o
          where o.organization_id in (v_org_x, v_org_y);

          perform set_config('role', 'none', true);
        end if;
      exception
        when others then
          v_d := null;
      end;
    end if;

    -- ---- unwind ----------------------------------------------------------
    raise exception 'migration-0006-selfcheck-unwind' using errcode = 'P0001';
  exception
    when others then
      v_err := sqlstate || ' ' || sqlerrm;
  end;

  perform set_config('role', 'none', true);

  if v_a is null then
    raise notice
      'migration 0006: live corroboration could not run (%). The structural assertions in section 7 still hold.',
      coalesce(v_err, 'unknown');
    return;
  end if;

  if v_a <> '23505' then
    raise exception
      'migration 0006: LIVE DUPLICATE SEND. A second acknowledgement for one inbound message was % — expected unique_violation (23505). The idempotency guarantee this migration exists to provide is not in force.',
      v_a;
  end if;

  if v_b <> 'P0001' then
    raise exception
      'migration 0006: a message that had been sent was moved back to queued (%). The retry sweep would message the tenant a second time.',
      v_b;
  end if;

  if v_c <> 'P0001' then
    raise exception
      'migration 0006: CROSS-TENANT REFERENCE ACCEPTED (%). An outbound message in one organization was allowed to name another organization''s tenant.',
      v_c;
  end if;

  if v_d is null then
    raise notice
      'migration 0006: read-isolation corroboration skipped — no unrelated active staff member is seeded, or the authenticated role is unavailable. The policy assertions in section 7 (3)-(8) still hold.';
  elsif v_d <> 0 then
    raise exception
      'migration 0006: LIVE LEAK. A staff member of an unrelated organization can see % outbound message(s) belonging to the throwaway organizations planted by this check.',
      v_d;
  end if;

  if v_err is not null and v_err not like '%migration-0006-selfcheck-unwind%' then
    raise notice
      'migration 0006: live corroboration unwound on an unexpected error (%), but every attempt it completed was refused as required.',
      v_err;
  end if;

  raise notice
    'migration 0006: live corroboration passed — duplicate acknowledgement refused (23505), unsend refused, cross-organization reference refused, and every planted row rolled back';
end
$live6$;


-- =============================================================================
-- End of migration 0006.
-- =============================================================================
