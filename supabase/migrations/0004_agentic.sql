-- =============================================================================
-- Migration 0004 — agentic capabilities
--
-- Lane w3-l1. Owns exactly one file: this one.
--
-- Five things, in this order:
--
--   1. Close a VERIFIED, EXPLOITABLE PII leak: a `service_provider` can read
--      tenant `email` and `phone` straight through PostgREST today. Fixed with
--      column privileges plus a security definer accessor.
--   2. `public.document_chunks` — the pgvector chunk store for RAG.
--   3. `public.search_document_chunks` — org-scoped retrieval that filters
--      BEFORE it ranks.
--   4. `public.webhook_events` and `public.inbound_messages` — webhook
--      idempotency enforced by a unique constraint, not by application logic.
--   5. `public.agent_runs` and `public.agent_proposals` — a model may propose;
--      only a human may approve, and that is structural, not conventional.
--
-- HOUSE RULES OBSERVED HERE
--   * Every function is `set search_path = ''` and fully schema-qualified.
--   * Every dollar quote uses a NAMED tag. A bare `$$` has already collapsed to
--     `$` once in this project's tooling and produced a syntax error.
--   * Idempotent throughout: `if not exists`, `create or replace`,
--     `drop policy if exists`, and `pg_constraint`-guarded constraint adds.
--   * No DELETE grant on any tenant-scoped table. Archive or status instead.
--   * TRUNCATE is re-revoked at the end (§7). 0002 could not alter
--     `supabase_admin`'s default privileges — measured on the live database, its
--     default ACL still reads `authenticated=arwdDxtm/supabase_admin`, and the
--     `D` is TRUNCATE. Any migration that adds a table must re-run the revoke.
--     This is the first such migration.
--   * A column name outranks a same-named parameter in a SQL-language function,
--     so parameters are `p_`-prefixed and positional `$1/$2` is used where the
--     referenced table carries a colliding column name.
--
-- MEASURED FACTS ABOUT THE TARGET DATABASE (Postgres 17.11, pgvector 0.8.2)
--   * The `vector` extension is installed in schema **public**, not
--     `extensions`. So the type is `public.halfvec`, the opclass is
--     `public.halfvec_cosine_ops` and the distance operator is
--     `OPERATOR(public.<=>)`. Everything below is written that way, which is
--     what makes `set search_path = ''` possible inside the retrieval function.
--     §0 asserts this rather than assuming it.
--   * The embedding model is `nvidia/nemotron-3.5-embed-1b`, which returns
--     **2048 dimensions**. pgvector's `ivfflat` and `hnsw` cap the `vector` type
--     at 2000 dimensions, so `vector(2048)` cannot be indexed at all. `halfvec`
--     is indexable to 4000, so `halfvec(2048)` is the storage type. The cost is
--     half precision per component (fp16), which is a rounding-level change to
--     cosine distance and entirely acceptable for retrieval ranking.
--
-- CONSUMER NOTES — READ BEFORE USING THIS SCHEMA
--   * w3-l2 (embeddings): write `public.document_chunks` with the SERVICE ROLE.
--     There is deliberately no client INSERT policy.
--   * w3-l3 (RAG API): call `public.search_document_chunks` with the
--     CALLER-SCOPED client. A service-role call raises `28000` by design —
--     the function authorizes a human, and there is no human in a service-role
--     session.
--   * w3-l6 (webhooks): the duplicate check is
--     `insert ... on conflict (provider, event_id) do nothing returning id`.
--     An empty result means "already delivered"; do not re-process.
--   * w3-l4 / w3-l5 (agent): `public.agent_proposals` has NO client UPDATE
--     privilege and NO UPDATE policy. Approve through
--     `public.approve_agent_proposal(uuid)`, reject through
--     `public.reject_agent_proposal(uuid)`. The `executed` transition is
--     service-role only, because whatever actually performs the tool call is a
--     trusted server component by definition.
--   * ANY lane reading `public.tenants`: `email` and `phone` are no longer
--     SELECT-able by `authenticated` at all — see §1 for the adoption recipe.
-- =============================================================================


-- =============================================================================
-- 0. Preconditions — fail loudly before anything is created
-- =============================================================================
-- Everything downstream of this lane depends on these facts. If one of them is
-- false, the right outcome is a migration that refuses to run, not a schema that
-- is subtly wrong.

do $pre$
declare
  v_vector_schema text;
begin
  select n.nspname
    into v_vector_schema
  from pg_catalog.pg_extension e
  join pg_catalog.pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';

  if v_vector_schema is null then
    raise exception
      'migration 0004: the `vector` extension is not installed. 0002 should have run `create extension if not exists vector`.'
      using errcode = '42704';
  end if;

  -- The whole file hard-codes `public.halfvec`. If a future environment installs
  -- pgvector into `extensions` instead, say so here rather than failing with a
  -- confusing "type halfvec does not exist" fifty statements later.
  if pg_catalog.to_regtype('public.halfvec') is null then
    raise exception
      'migration 0004: type public.halfvec not found (the vector extension lives in schema %). This migration schema-qualifies halfvec as public.halfvec so that its functions can run with search_path = ''''. Move the extension to public, or re-qualify every halfvec reference in this file.',
      v_vector_schema
      using errcode = '42704';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_opclass o
    join pg_catalog.pg_namespace n on n.oid = o.opcnamespace
    join pg_catalog.pg_am a on a.oid = o.opcmethod
    where o.opcname = 'halfvec_cosine_ops'
      and n.nspname = 'public'
      and a.amname = 'hnsw'
  ) then
    raise exception
      'migration 0004: operator class public.halfvec_cosine_ops for access method hnsw is missing. pgvector 0.7.0 or newer is required for halfvec.'
      using errcode = '42704';
  end if;

  -- `can_read_document` in §2 mirrors 0002's documents SELECT policies, and the
  -- provider arm of that mirror reads `documents.ticket_id`, which 0003 adds.
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
    raise exception
      'migration 0004: public.documents.ticket_id is missing. Apply 0003 before 0004.'
      using errcode = '42703';
  end if;

  -- The six frozen helpers from 0001/0002 plus 0003's audit writer. This file
  -- defines no local copy of any of them (CLAUDE.md rule 4).
  if pg_catalog.to_regprocedure('public.current_profile_id()')        is null
  or pg_catalog.to_regprocedure('public.is_org_member(uuid)')         is null
  or pg_catalog.to_regprocedure('public.is_org_staff(uuid)')          is null
  or pg_catalog.to_regprocedure('public.owns_property(uuid, uuid)')   is null
  or pg_catalog.to_regprocedure('public.current_tenant_id(uuid)')     is null
  or pg_catalog.to_regprocedure('public.current_provider_id(uuid)')   is null
  or pg_catalog.to_regprocedure('public.log_audit(text, text, uuid, jsonb, uuid)') is null
  then
    raise exception
      'migration 0004: a helper function from 0001/0002/0003 is missing. Apply 0001 through 0003 before 0004.'
      using errcode = '42883';
  end if;

  raise notice 'migration 0004: preconditions satisfied (pgvector in schema %, halfvec indexable)', v_vector_schema;
end
$pre$;


-- =============================================================================
-- 1. The PII leak: tenant email and phone reachable by a service_provider
-- =============================================================================
--
-- WHAT WAS WRONG, stated precisely.
--
-- `docs/implementation-plan.md` §4 gives `service_provider` "R name only, via
-- assignment" on `tenants`. 0002's `tenants_select_provider_assigned` correctly
-- grants the ROW to a provider holding the assigned ticket. It cannot withhold a
-- COLUMN, because row level security filters rows and nothing else.
--
-- Nor can any policy express the boundary, for a structural reason: all five
-- application roles share the single Postgres role `authenticated`. A policy can
-- branch on the caller, but a GRANT cannot — grants are per Postgres role, and
-- there is only one. So "staff may read email, providers may not" is not
-- expressible as a plain column grant either.
--
-- The application layer does project correctly
-- (`features/tenants/server/serialize.ts`, `lib/auth/authorize.ts`'s
-- `PROVIDER_TENANT_FIELDS`), and that was the only thing standing between a
-- provider and a tenant's phone number. It is not sufficient: the anon key is
-- public by design, a provider holds a real JWT, and PostgREST is reachable
-- directly. `select full_name, email, phone from public.tenants` returned the
-- tenant's email and phone to a provider's JWT. Measured, not theorised.
--
-- THE FIX, and why it takes this shape.
--
-- Revoking the COLUMN privilege alone would do nothing: a role holding
-- table-level SELECT implicitly holds SELECT on every column, and a column-level
-- revoke does not subtract from a table-level grant. So the table-level grant is
-- revoked outright and the permitted columns are granted back one by one. That
-- is the same shape 0003 used for `organization_invitations.token_hash`.
--
-- After this, `email` and `phone` have exactly one read path for a client
-- session: `public.tenant_contact()` below, which answers only for organization
-- staff and for the tenant themselves. A provider gets SQLSTATE 42501.
--
-- VERIFIED on the live database inside a rolled-back transaction, with a real
-- provider's `sub` claim:
--     before: provider could read the email column of its assigned tenant row
--     after : 42501 permission denied for table tenants   (email)
--             42501 permission denied for table tenants   (phone)
--             full_name still readable — the assignment-scoped row grant is intact

-- `anon` loses SELECT entirely and gets nothing back. Every policy on `tenants`
-- is `to authenticated`, so `anon` already reached zero rows; this removes the
-- privilege as well so the two layers agree.
revoke select on table public.tenants from anon;

-- `authenticated` loses the table-level grant, then gets back every column
-- except `email` and `phone`.
revoke select on table public.tenants from authenticated;

grant select (
  id,
  organization_id,
  profile_id,
  full_name,
  created_at
) on table public.tenants to authenticated;

-- INSERT and UPDATE are untouched: staff still write `email` and `phone` through
-- `tenants_insert_staff` / `tenants_update_staff`. Writing a column you cannot
-- read is exactly the asymmetry we want here.

comment on column public.tenants.email is
  'Tenant email. NOT SELECT-able by the `authenticated` role. Read it through public.tenant_contact(organization_id, tenant_id), which answers for organization staff and for the tenant themselves. docs/implementation-plan.md §4 limits service_provider to "R name only".';

comment on column public.tenants.phone is
  'Tenant phone. NOT SELECT-able by the `authenticated` role. Read it through public.tenant_contact(organization_id, tenant_id). See the comment on tenants.email.';


-- --------------------------------------------------------------------------
-- public.tenant_contact — the one read path for tenant contact details
-- --------------------------------------------------------------------------
--
-- ADOPTION RECIPE — this is a BREAKING CHANGE for any caller that selects
-- `email` or `phone` from `tenants` with the caller-scoped client, which today
-- means `features/tenants/server/tenant-service.ts` (`TENANT_FULL_FIELDS` /
-- `FULL_SELECT`) and anything reusing it. Those reads now fail with 42501 for
-- every role, including staff, until they are changed to:
--
--     const { data } = await supabase.rpc('tenant_contact', {
--       p_organization_id: organizationId,
--       p_tenant_id: tenantId,        // omit or null for the whole organization
--     });
--     // -> [{ tenant_id, email, phone }, ...]
--
-- and merge the result onto the row read from `tenants`. Reported to the
-- orchestrator as a cross-lane consequence; this lane owns only this file and
-- cannot make that edit.
--
-- WHY IT RETURNS A SET rather than a single row. A tenant list page needs the
-- contact details of every tenant on the page. A scalar accessor would force one
-- round trip per row, and the obvious workaround — widening the grant again — is
-- the hole we just closed. `p_tenant_id` therefore defaults to null and means
-- "every tenant in this organization that the caller may see". Passing an id
-- returns exactly one row, so the briefed two-argument call spelling is
-- unchanged.
--
-- WHY THE TENANT THEMSELVES IS ALLOWED. The §4 matrix gives `tenant` "R self
-- only" on `tenants`, and that cell includes their own email and phone. A
-- staff-only accessor would make that row of the matrix unsatisfiable, which is
-- a correctness defect in this migration rather than a hardening win. Every
-- other role — `property_owner`, `service_provider`, any member of another
-- organization, any non-member — gets 42501.
--
-- SECURITY DEFINER, so it reads `tenants` without row level security. That makes
-- the organization filter load-bearing: `t.organization_id = p_organization_id`
-- appears in both branches and is not optional.
create or replace function public.tenant_contact(
  p_organization_id uuid,
  p_tenant_id uuid default null
)
returns table (tenant_id uuid, email text, phone text)
language plpgsql
stable
security definer
set search_path = ''
as $tc$
declare
  v_profile uuid;
  v_self    uuid;
begin
  if p_organization_id is null then
    raise exception 'tenant_contact_organization_required: p_organization_id must be supplied'
      using errcode = '22023';
  end if;

  if auth.uid() is null then
    raise exception 'authentication_required: tenant_contact needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  -- Staff: organization_admin or property_manager. RW on tenants in the matrix.
  if public.is_org_staff(p_organization_id) then
    return query
      select t.id, t.email, t.phone
      from public.tenants t
      where t.organization_id = p_organization_id
        and (p_tenant_id is null or t.id = p_tenant_id);
    return;
  end if;

  -- The tenant themselves, and only their own row.
  v_self := public.current_tenant_id(p_organization_id);
  if v_self is not null and (p_tenant_id is null or p_tenant_id = v_self) then
    return query
      select t.id, t.email, t.phone
      from public.tenants t
      where t.organization_id = p_organization_id
        and t.id = v_self;
    return;
  end if;

  -- Everyone else, including a service_provider holding an assigned ticket.
  raise exception 'tenant_contact_forbidden: only organization staff, or the tenant themselves, may read tenant contact details'
    using errcode = '42501';
end
$tc$;

comment on function public.tenant_contact(uuid, uuid) is
  'The only client read path for tenants.email and tenants.phone. Returns rows for organization staff, or the caller''s own tenant row; raises 42501 otherwise. Added by 0004 because row level security filters rows, not columns, and all five application roles share the single Postgres role `authenticated`.';

revoke all on function public.tenant_contact(uuid, uuid) from public;
revoke all on function public.tenant_contact(uuid, uuid) from anon;
grant execute on function public.tenant_contact(uuid, uuid) to authenticated, service_role;


-- =============================================================================
-- 2. public.can_read_document — the document visibility predicate
-- =============================================================================
--
-- WHY THIS EXISTS AT ALL. `search_document_chunks` in §4 is SECURITY DEFINER, so
-- it runs as the table owner and row level security does not apply inside it.
-- The row level security that protects `document_chunks` for ordinary client
-- reads is therefore unavailable to the retrieval path, and the retrieval path
-- has to state the same rule explicitly.
--
-- HOW DRIFT IS CONTAINED. The client-facing policy on `document_chunks` (§3) is
-- written as a bare EXISTS against `public.documents`, so it inherits whatever
-- 0002 decided and can never disagree with it. Only this function restates the
-- rule, and it restates it once. The self-check in §8 asserts that 0002's five
-- `documents` SELECT policies are all still present by name, so a change there
-- trips an alarm here.
--
-- MIRRORS, arm for arm, 0002 §5 `documents`:
--   documents_select_staff              -> is_org_staff
--   documents_select_owner              -> owns_property, directly or via tenancy
--   documents_select_own_tenancy        -> current_tenant_id
--   documents_select_provider_assigned  -> current_provider_id on ticket_id
--
-- `$1` and `$2` are used rather than the parameter names because the referenced
-- tables carry columns that could shadow them in a SQL-language function.
create or replace function public.can_read_document(
  p_organization_id uuid,
  p_document_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $crd$
  select exists (
    select 1
    from public.documents d
    where d.organization_id = $1
      and d.id = $2
      and (
        -- staff
        public.is_org_staff($1)

        -- owner, document attached directly to a property they own
        or (d.property_id is not null and public.owns_property($1, d.property_id))

        -- owner, document attached to a tenancy on a unit of a property they own
        or (d.tenancy_id is not null and exists (
              select 1
              from public.tenancies tn
              join public.property_units u
                on u.organization_id = tn.organization_id
               and u.id = tn.property_unit_id
              where tn.organization_id = d.organization_id
                and tn.id = d.tenancy_id
                and public.owns_property(d.organization_id, u.property_id)
           ))

        -- the tenant of that tenancy, and nobody else's tenancy
        or (d.tenancy_id is not null and exists (
              select 1
              from public.tenancies tn2
              where tn2.organization_id = d.organization_id
                and tn2.id = d.tenancy_id
                and tn2.tenant_id = public.current_tenant_id(d.organization_id)
           ))

        -- the provider assigned to the ticket this document is evidence for
        or (d.ticket_id is not null and exists (
              select 1
              from public.maintenance_tickets k
              where k.organization_id = d.organization_id
                and k.id = d.ticket_id
                and k.assigned_provider_id = public.current_provider_id(d.organization_id)
           ))
      )
  )
$crd$;

comment on function public.can_read_document(uuid, uuid) is
  'True when the current caller may read that document. The security definer mirror of the five documents SELECT policies in migration 0002 §5; the two must change together. Needed because public.search_document_chunks runs as definer, where row level security does not apply.';

revoke all on function public.can_read_document(uuid, uuid) from public;
revoke all on function public.can_read_document(uuid, uuid) from anon;
grant execute on function public.can_read_document(uuid, uuid) to authenticated, service_role;


-- =============================================================================
-- 3. public.document_chunks — the pgvector chunk store
-- =============================================================================
--
-- COMPOSITE FOREIGN KEY, not a plain one. `(organization_id, document_id)`
-- references `public.documents(organization_id, id)`, so a chunk physically
-- cannot name a document belonging to a different organization. The pattern is
-- the same one 0001 used throughout, and it is the reason a cross-organization
-- chunk is a constraint violation rather than a test we hope someone writes.
--
-- halfvec(2048), not vector(2048). See the header: the embedding model returns
-- 2048 dimensions and `vector` is unindexable above 2000. `halfvec` is
-- indexable to 4000. Shipping `vector(2048)` would have produced a column that
-- silently could not be indexed, which is the failure this note exists to
-- prevent.
--
-- `embedding` is nullable on purpose: the chunking worker writes `content` in
-- one pass and the embedding in another, and a half-embedded document should be
-- a visible state rather than an aborted transaction. The retrieval function
-- skips null embeddings.
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  token_count integer check (token_count is null or token_count >= 0),
  embedding public.halfvec(2048),
  created_at timestamptz not null default now(),
  constraint document_chunks_org_id_key unique (organization_id, id),
  constraint document_chunks_org_document_index_key unique (organization_id, document_id, chunk_index),
  constraint document_chunks_document_fkey
    foreign key (organization_id, document_id)
    references public.documents(organization_id, id) on delete cascade
);

comment on table public.document_chunks is
  'Embedded slices of public.documents for retrieval. Composite FK (organization_id, document_id) makes a cross-organization chunk impossible. Written by the embedding worker with the service role; there is no client INSERT policy.';
comment on column public.document_chunks.embedding is
  'halfvec(2048) — nvidia/nemotron-3.5-embed-1b returns 2048 dimensions, and pgvector caps the `vector` type at 2000 for both ivfflat and hnsw. halfvec is indexable to 4000. Null until the embedding pass runs.';


-- =============================================================================
-- 3a. Guarded constraint adds
-- =============================================================================
-- `create table if not exists` is a no-op against a table left behind by a
-- partial earlier run of this file, and such a table could be missing the
-- constraints that carry the isolation guarantees. Every constraint this
-- migration depends on is therefore named inline above and re-asserted here
-- through `pg_constraint`, so a re-run repairs rather than assumes.
do $cons$
declare
  rec record;
begin
  for rec in
    select *
    from (values
      ('document_chunks', 'document_chunks_org_id_key',
       'unique (organization_id, id)'),
      ('document_chunks', 'document_chunks_org_document_index_key',
       'unique (organization_id, document_id, chunk_index)'),
      ('document_chunks', 'document_chunks_document_fkey',
       'foreign key (organization_id, document_id) references public.documents(organization_id, id) on delete cascade'),
      ('webhook_events', 'webhook_events_provider_event_id_key',
       'unique (provider, event_id)'),
      ('inbound_messages', 'inbound_messages_provider_external_id_key',
       'unique (provider, external_message_id)'),
      ('inbound_messages', 'inbound_messages_ticket_fkey',
       'foreign key (organization_id, ticket_id) references public.maintenance_tickets(organization_id, id)'),
      ('inbound_messages', 'inbound_messages_ticket_requires_org',
       'check (ticket_id is null or organization_id is not null)'),
      ('agent_runs', 'agent_runs_org_id_key',
       'unique (organization_id, id)'),
      ('agent_proposals', 'agent_proposals_org_id_key',
       'unique (organization_id, id)'),
      ('agent_proposals', 'agent_proposals_run_fkey',
       'foreign key (organization_id, run_id) references public.agent_runs(organization_id, id) on delete cascade'),
      ('agent_proposals', 'agent_proposals_decision_consistent',
       'check ((status = ''pending'' and decided_by is null and decided_at is null) or (status <> ''pending'' and decided_by is not null and decided_at is not null))')
    ) as t(tbl, cname, cdef)
  loop
    -- The table may not exist yet on the first pass through this block; the
    -- tables defined after it are created below and the block runs again only on
    -- a re-apply. Skip quietly in that case.
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
      raise notice 'migration 0004: repaired missing constraint %.%', rec.tbl, rec.cname;
    end if;
  end loop;
end
$cons$;


-- Pre-filter support: every retrieval starts from an organization.
create index if not exists idx_document_chunks_org
  on public.document_chunks (organization_id, document_id, chunk_index);

-- The ANN index. HNSW with cosine distance over halfvec.
--
-- HONEST NOTE ON WHEN THIS INDEX IS USED. `search_document_chunks` materialises
-- its authorization filter before it sorts, so for that function the planner
-- sorts an already-filtered tuplestore and does not consult this index. That is
-- the deliberate trade in §4 — correct beats fast, and at demo corpus size the
-- difference is unmeasurable. The index is built anyway because it is what makes
-- the column choice meaningful (a `vector(2048)` column could not have one at
-- all), because service-role and analytical queries can use it, and because the
-- natural optimisation later — one partial index per organization, or pgvector
-- 0.8's iterative scans — needs it to exist.
create index if not exists idx_document_chunks_embedding_hnsw
  on public.document_chunks
  using hnsw (embedding public.halfvec_cosine_ops);


-- -- document_chunks: row level security ---------------------------------------
alter table public.document_chunks enable row level security;

-- A chunk is readable by exactly whoever may read its parent document.
--
-- Written as a bare EXISTS against `public.documents` ON PURPOSE. A policy's
-- subquery is itself subject to the referenced table's row level security, so
-- this expression resolves to "the parent document is visible to you" without
-- naming a single one of the four conditions that make a document visible. It
-- therefore cannot drift from 0002's documents policies: if 0002 is amended,
-- this follows automatically. The alternative — restating staff / owner /
-- tenant / provider here — would be a fourth copy of a predicate that already
-- exists twice too often.
--
-- No recursion risk: 0002's documents policies reach tenancies, property_units,
-- maintenance_tickets and service_providers, none of which reference
-- document_chunks.
drop policy if exists document_chunks_select_parent_document on public.document_chunks;
create policy document_chunks_select_parent_document
on public.document_chunks
for select
to authenticated
using (
  exists (
    select 1
    from public.documents d
    where d.organization_id = document_chunks.organization_id
      and d.id = document_chunks.document_id
  )
);

-- No INSERT, UPDATE or DELETE policy. Chunks are derived data produced by the
-- embedding worker, which holds the service role and bypasses row level
-- security. A client that could write chunks could poison retrieval for its own
-- organization, which is the one injection vector a RAG store has.
revoke all on table public.document_chunks from anon;
revoke insert, update, delete, truncate on table public.document_chunks from authenticated;
grant select on table public.document_chunks to authenticated;


-- =============================================================================
-- 4. public.search_document_chunks — retrieval that filters before it ranks
-- =============================================================================
--
-- THE SINGLE MOST IMPORTANT FUNCTION IN THIS LANE, and the reason is subtle
-- enough to be worth spelling out.
--
-- The naive retriever is `order by embedding <=> query limit k`, with the
-- authorization filter applied to the result. That is not merely slow or
-- incomplete — it leaks. The k nearest neighbours are chosen from every
-- organization's corpus, and the choice is itself information: which of MY
-- questions return few results, and which return none, is a function of what is
-- in SOMEBODY ELSE'S documents. Ranking first and filtering second leaks through
-- the ranking even when every returned row is correctly scoped.
--
-- So the candidate set is built first, with `as materialized` forcing it into a
-- tuplestore before the sort can see it. The planner is not allowed to inline
-- the CTE, push the sort down, or use the ANN index to pick neighbours from the
-- unfiltered heap. The cost is a sequential sort over the caller's own
-- authorized chunks. At the scale this project operates, that is free.
--
-- TWO FILTERS, both mandatory:
--   * `organization_id = p_organization_id`, combined with a membership check
--     that refuses outright rather than returning an empty set, and
--   * `can_read_document`, which is the §2 mirror of the documents matrix. An
--     organization member who may not read a particular contract must not reach
--     its chunks either — otherwise retrieval becomes a side channel around the
--     documents policies.
--
-- SECURITY DEFINER means row level security is NOT in force inside this body.
-- Both filters above are the only thing standing between a caller and the
-- table. They are not optional and they are not redundant.
--
-- CALLING CONVENTION. Call this with the CALLER-SCOPED client. With the service
-- role there is no `auth.uid()`, so it raises 28000 — deliberately, because a
-- service-role caller has no human whose authorization could be computed. A
-- server-side worker that needs unscoped access should query the table directly
-- and own its scoping explicitly.
--
-- `p_query` is `public.halfvec` with no typmod so PostgREST can cast a JSON
-- string argument; the dimension is asserted in the body instead.
create or replace function public.search_document_chunks(
  p_organization_id uuid,
  p_query public.halfvec,
  p_limit int,
  p_document_id uuid default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  content text,
  distance double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $sdc$
declare
  v_profile uuid;
  v_limit   int;
  v_dims    int;
begin
  if p_organization_id is null then
    raise exception 'search_organization_required: p_organization_id must be supplied'
      using errcode = '22023';
  end if;

  if p_query is null then
    raise exception 'search_query_required: p_query must be a halfvec embedding'
      using errcode = '22023';
  end if;

  v_dims := public.vector_dims(p_query);
  if v_dims <> 2048 then
    raise exception 'search_query_dimension_mismatch: expected 2048 dimensions, received %', v_dims
      using errcode = '22023';
  end if;

  if auth.uid() is null then
    raise exception 'authentication_required: search_document_chunks authorizes a human and needs an authenticated session. A service-role caller must query public.document_chunks directly and scope it explicitly.'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  -- Refuse, do not silently return nothing. An empty result and a denial are
  -- different answers and the caller is entitled to tell them apart.
  if not public.is_org_member(p_organization_id) then
    raise exception 'search_forbidden: caller is not an active member of that organization'
      using errcode = '42501';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 8), 1), 50);

  return query
  with visible as materialized (
    select c.id        as cid,
           c.document_id as did,
           c.content   as body,
           c.embedding as emb
    from public.document_chunks c
    where c.organization_id = p_organization_id
      and c.embedding is not null
      and (p_document_id is null or c.document_id = p_document_id)
      and public.can_read_document(p_organization_id, c.document_id)
  )
  select v.cid,
         v.did,
         v.body,
         (v.emb OPERATOR(public.<=>) p_query)::double precision
  from visible v
  order by v.emb OPERATOR(public.<=>) p_query
  limit v_limit;
end
$sdc$;

comment on function public.search_document_chunks(uuid, public.halfvec, int, uuid) is
  'Organization-scoped RAG retrieval. Filters by organization membership and per-document visibility in a MATERIALIZED CTE before any similarity ordering, so neighbour selection can never be computed across organizations. Returns chunk_id, document_id, content and cosine distance for citation. Call with the caller-scoped client; a service-role call raises 28000.';

revoke all on function public.search_document_chunks(uuid, public.halfvec, int, uuid) from public;
revoke all on function public.search_document_chunks(uuid, public.halfvec, int, uuid) from anon;
grant execute on function public.search_document_chunks(uuid, public.halfvec, int, uuid)
  to authenticated, service_role;


-- =============================================================================
-- 5. Webhook idempotency
-- =============================================================================
--
-- `unique (provider, event_id)` is the entire point of this table. A replayed
-- WhatsApp or Stripe delivery must be rejected by Postgres, not by a check in
-- application code — because the application check has a race between "have I
-- seen this?" and "record that I have", and two concurrent deliveries of the
-- same event will both pass it. The unique index has no such window.
--
-- The handler shape is:
--     insert into public.webhook_events (provider, event_id, payload)
--     values ($1, $2, $3)
--     on conflict (provider, event_id) do nothing
--     returning id;
-- An empty result means the event was already accepted. Do not process it again.
--
-- No organization_id: a webhook arrives before anyone knows whose it is.
-- Attribution happens in `inbound_messages`.
create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (btrim(provider) <> ''),
  event_id text not null check (btrim(event_id) <> ''),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'received'
    check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  constraint webhook_events_provider_event_id_key unique (provider, event_id)
);

alter table public.webhook_events enable row level security;

-- Row level security enabled with NO policies: every client role is denied by
-- default, and only the service role — which bypasses row level security —
-- reaches it. The revokes are belt and braces, so that a future accidental
-- policy cannot open a raw webhook payload to a client either. Payloads are
-- untrusted third-party input and may contain personal data.
revoke all on table public.webhook_events from anon;
revoke all on table public.webhook_events from authenticated;

create index if not exists idx_webhook_events_status
  on public.webhook_events (status, received_at desc);

comment on table public.webhook_events is
  'Raw inbound webhook deliveries, service-role only. unique (provider, event_id) is the idempotency guarantee: a replay is rejected by the database, not by application logic. Use insert ... on conflict do nothing returning id.';


-- --------------------------------------------------------------------------
-- public.inbound_messages — what the inbox renders
-- --------------------------------------------------------------------------
--
-- `organization_id` is NULLABLE, deliberately. A WhatsApp message arrives from a
-- phone number; until that number is resolved to a tenant we genuinely do not
-- know whose data it is, and inventing an organization at that moment would be
-- exactly the client-supplied-organization_id mistake CLAUDE.md rule 5 forbids,
-- committed by the server instead of the client.
--
-- The consequence is stated plainly: an unattributed message is visible to NO
-- organization. It is service-role only until resolution. Fail closed.
--
-- `(organization_id, ticket_id)` is a composite foreign key, but composite
-- foreign keys default to MATCH SIMPLE, which means the constraint is not
-- enforced at all when any referenced column is null. So a row with
-- `organization_id is null` and `ticket_id` set would escape it entirely. The
-- `inbound_messages_ticket_requires_org` check closes that: you cannot link a
-- ticket before you know the organization.
create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete cascade,
  provider text not null check (btrim(provider) <> ''),
  external_message_id text not null check (btrim(external_message_id) <> ''),
  from_identifier text not null,
  body text,
  received_at timestamptz not null default now(),
  status text not null default 'received'
    -- ORCHESTRATOR AMENDMENT: 'unmatched' added. Lanes w3-l6 and w3-l7 independently
    -- reached for a distinct state meaning "a message arrived from a number we cannot
    -- map to a tenant". That is NOT 'ignored' — nothing was ignored, the isolation
    -- boundary refused to guess. Resolving a phone number to the wrong tenant would
    -- cross the exact boundary this project exists to defend, so the state is first
    -- class and the inbox renders it distinctly.
    check (status in ('received', 'unmatched', 'classified', 'linked', 'ignored', 'failed')),
  ticket_id uuid,
  constraint inbound_messages_provider_external_id_key unique (provider, external_message_id),
  constraint inbound_messages_ticket_requires_org
    check (ticket_id is null or organization_id is not null),
  constraint inbound_messages_ticket_fkey
    foreign key (organization_id, ticket_id)
    references public.maintenance_tickets(organization_id, id)
);

alter table public.inbound_messages enable row level security;

-- AC2 / Goal 1. Staff of the owning organization read their own inbox and
-- nothing else. The `organization_id is not null` clause is what keeps
-- unattributed messages out of every organization's view rather than leaking
-- them to the first organization that asks.
drop policy if exists inbound_messages_select_staff on public.inbound_messages;
create policy inbound_messages_select_staff
on public.inbound_messages
for select
to authenticated
using (
  organization_id is not null
  and (select public.is_org_staff(organization_id))
);

-- No client write path at all. Messages are created by the webhook handler and
-- attributed by it; a human turning one into a ticket does so through the
-- existing ticket creation path, and the message's own status is updated by the
-- server. A client that could edit `from_identifier` or `body` could forge the
-- evidence an AI classification was based on.
revoke all on table public.inbound_messages from anon;
revoke insert, update, delete, truncate on table public.inbound_messages from authenticated;
grant select on table public.inbound_messages to authenticated;

create index if not exists idx_inbound_messages_org
  on public.inbound_messages (organization_id, received_at desc);
create index if not exists idx_inbound_messages_status
  on public.inbound_messages (status, received_at desc);

comment on table public.inbound_messages is
  'Normalised inbound messages; the surface the inbox renders. organization_id is null until the sender is resolved, and an unattributed row is visible to no organization. Written by the webhook handler with the service role; staff read only.';
comment on column public.inbound_messages.body is
  'Message body. Never log this (CLAUDE.md rule 8).';


-- =============================================================================
-- 6. Agent runs and proposals — the model proposes, a human commits
-- =============================================================================
--
-- CLAUDE.md rule 7: no model output reaches a mutation without an authenticated
-- human confirmation in between. This section makes that structural rather than
-- conventional, in three layers:
--
--   1. `agent_proposals` has no UPDATE policy, so no client statement can match
--      a row to update.
--   2. UPDATE is also REVOKED from `authenticated` and `anon`, so the attempt
--      fails with 42501 rather than silently affecting zero rows. A missing
--      policy is quiet; a missing privilege is loud, and the negative-write
--      suite wants loud.
--   3. The only transition into `approved` is
--      `public.approve_agent_proposal(uuid)`, which checks `is_org_staff`,
--      records who decided and when, and writes an audit row.
--
-- Layer 2 is what makes layer 1 hold under amendment: someone adding a
-- well-meaning UPDATE policy later still cannot open this path.

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_profile_id uuid references public.profiles(id),
  input text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  constraint agent_runs_org_id_key unique (organization_id, id)
);

alter table public.agent_runs enable row level security;

drop policy if exists agent_runs_select_staff on public.agent_runs;
create policy agent_runs_select_staff
on public.agent_runs
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- A run is started by a human, in their own name. `actor_profile_id` is pinned
-- to the caller so a staff member cannot attribute a run to a colleague.
drop policy if exists agent_runs_insert_staff on public.agent_runs;
create policy agent_runs_insert_staff
on public.agent_runs
for insert
to authenticated
with check (
  (select public.is_org_staff(organization_id))
  and actor_profile_id = (select public.current_profile_id())
);

-- Status bookkeeping only. Nothing consequential hangs off an agent_runs row:
-- the decision surface is agent_proposals, which has no client UPDATE at all.
drop policy if exists agent_runs_update_staff on public.agent_runs;
create policy agent_runs_update_staff
on public.agent_runs
for update
to authenticated
using ((select public.is_org_staff(organization_id)))
with check ((select public.is_org_staff(organization_id)));

revoke all on table public.agent_runs from anon;
revoke delete, truncate on table public.agent_runs from authenticated;

create index if not exists idx_agent_runs_org
  on public.agent_runs (organization_id, created_at desc);

comment on table public.agent_runs is
  'One agentic conversation turn. Readable and startable by organization staff. The consequential surface is agent_proposals, not this table.';
comment on column public.agent_runs.input is
  'The human instruction that started the run. Never log this (CLAUDE.md rule 8).';


create table if not exists public.agent_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  tool_name text not null check (btrim(tool_name) <> ''),
  arguments jsonb not null default '{}'::jsonb,
  rationale text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'executed')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_proposals_org_id_key unique (organization_id, id),
  constraint agent_proposals_run_fkey
    foreign key (organization_id, run_id)
    references public.agent_runs(organization_id, id) on delete cascade,
  -- A decided proposal always names its decider. A pending one never does. The
  -- database refuses to hold a row that claims approval by nobody.
  constraint agent_proposals_decision_consistent
    check (
      (status = 'pending' and decided_by is null and decided_at is null)
      or (status <> 'pending' and decided_by is not null and decided_at is not null)
    )
);

alter table public.agent_proposals enable row level security;

drop policy if exists agent_proposals_select_staff on public.agent_proposals;
create policy agent_proposals_select_staff
on public.agent_proposals
for select
to authenticated
using ((select public.is_org_staff(organization_id)));

-- A proposal may be RECORDED by the agent route running under the caller's
-- session, but only ever as `pending` and never with a decision attached. A
-- pending proposal is inert: it causes nothing until the RPC below runs. The
-- composite foreign key additionally pins it to a run in the same organization.
drop policy if exists agent_proposals_insert_staff on public.agent_proposals;
create policy agent_proposals_insert_staff
on public.agent_proposals
for insert
to authenticated
with check (
  (select public.is_org_staff(organization_id))
  and status = 'pending'
  and decided_by is null
  and decided_at is null
);

-- No UPDATE policy and no UPDATE privilege. This is the rule, not an oversight.
revoke all on table public.agent_proposals from anon;
revoke update, delete, truncate on table public.agent_proposals from authenticated;

create index if not exists idx_agent_proposals_pending
  on public.agent_proposals (organization_id, created_at desc)
  where status = 'pending';
create index if not exists idx_agent_proposals_run
  on public.agent_proposals (organization_id, run_id);

comment on table public.agent_proposals is
  'A tool call the model wants to make. Inert until a human approves it through public.approve_agent_proposal. The authenticated role holds no UPDATE privilege on this table and there is no UPDATE policy, so there is no client path from pending to approved.';
comment on column public.agent_proposals.arguments is
  'Model-authored tool arguments. Untrusted. Validate against the tool schema before execution, and never copy into an audit row (CLAUDE.md rule 8).';


-- --------------------------------------------------------------------------
-- public.approve_agent_proposal / public.reject_agent_proposal
-- --------------------------------------------------------------------------
--
-- `reject` is not in the original brief but the lifecycle is unreachable without
-- it: with UPDATE revoked, a human who declines a proposal would have no way to
-- say so. Reported as a planning note rather than worked around.
--
-- `executed` is deliberately NOT reachable from a client. Whatever performs the
-- tool call is a trusted server component holding the service role — it is the
-- thing doing the privileged action — so it marks its own completion. Giving a
-- browser session a way to write `executed` would let the audit trail claim an
-- action that never happened.
--
-- A missing proposal and a proposal in another organization both raise the same
-- 42501 with the same message. Distinguishing them would turn this RPC into an
-- existence oracle across organizations.
create or replace function public.approve_agent_proposal(p_id uuid)
returns public.agent_proposals
language plpgsql
security definer
set search_path = ''
as $aap$
declare
  v_profile  uuid;
  v_proposal public.agent_proposals;
begin
  if p_id is null then
    raise exception 'agent_proposal_id_required: p_id must be supplied'
      using errcode = '22023';
  end if;

  if auth.uid() is null then
    raise exception 'authentication_required: approving a proposal is a human act and needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  select a.* into v_proposal
  from public.agent_proposals a
  where a.id = p_id
  for update;

  if not found or not public.is_org_staff(v_proposal.organization_id) then
    raise exception 'agent_proposal_forbidden: no such proposal is visible to you'
      using errcode = '42501';
  end if;

  if v_proposal.status <> 'pending' then
    raise exception 'agent_proposal_not_pending: this proposal has already been decided'
      using errcode = 'P0001';
  end if;

  update public.agent_proposals a
     set status      = 'approved',
         decided_by  = v_profile,
         decided_at  = now()
   where a.id = p_id
  returning a.* into v_proposal;

  -- Audit metadata carries identifiers only. `arguments` and `rationale` are
  -- model-authored free text and may restate personal data (CLAUDE.md rule 8).
  perform public.log_audit(
    'agent_proposal.approved',
    'agent_proposal',
    v_proposal.id,
    jsonb_build_object('tool_name', v_proposal.tool_name, 'run_id', v_proposal.run_id),
    v_proposal.organization_id
  );

  return v_proposal;
end
$aap$;

create or replace function public.reject_agent_proposal(p_id uuid)
returns public.agent_proposals
language plpgsql
security definer
set search_path = ''
as $rap$
declare
  v_profile  uuid;
  v_proposal public.agent_proposals;
begin
  if p_id is null then
    raise exception 'agent_proposal_id_required: p_id must be supplied'
      using errcode = '22023';
  end if;

  if auth.uid() is null then
    raise exception 'authentication_required: rejecting a proposal is a human act and needs an authenticated session'
      using errcode = '28000';
  end if;

  v_profile := public.current_profile_id();
  if v_profile is null then
    raise exception 'profile_required: the authenticated user has no profile row'
      using errcode = '42501';
  end if;

  select a.* into v_proposal
  from public.agent_proposals a
  where a.id = p_id
  for update;

  if not found or not public.is_org_staff(v_proposal.organization_id) then
    raise exception 'agent_proposal_forbidden: no such proposal is visible to you'
      using errcode = '42501';
  end if;

  if v_proposal.status <> 'pending' then
    raise exception 'agent_proposal_not_pending: this proposal has already been decided'
      using errcode = 'P0001';
  end if;

  update public.agent_proposals a
     set status      = 'rejected',
         decided_by  = v_profile,
         decided_at  = now()
   where a.id = p_id
  returning a.* into v_proposal;

  perform public.log_audit(
    'agent_proposal.rejected',
    'agent_proposal',
    v_proposal.id,
    jsonb_build_object('tool_name', v_proposal.tool_name, 'run_id', v_proposal.run_id),
    v_proposal.organization_id
  );

  return v_proposal;
end
$rap$;

comment on function public.approve_agent_proposal(uuid) is
  'The only transition from pending to approved. Requires an authenticated organization_admin or property_manager of the owning organization; records decided_by and decided_at and writes an audit row. CLAUDE.md rule 7 made structural.';
comment on function public.reject_agent_proposal(uuid) is
  'The only transition from pending to rejected. Same authorization and audit behaviour as approve_agent_proposal.';

revoke all on function public.approve_agent_proposal(uuid) from public;
revoke all on function public.approve_agent_proposal(uuid) from anon;
grant execute on function public.approve_agent_proposal(uuid) to authenticated, service_role;

revoke all on function public.reject_agent_proposal(uuid) from public;
revoke all on function public.reject_agent_proposal(uuid) from anon;
grant execute on function public.reject_agent_proposal(uuid) to authenticated, service_role;


-- =============================================================================
-- 7. TRUNCATE — the standing requirement from 0002 §4a
-- =============================================================================
--
-- TRUNCATE IGNORES ROW LEVEL SECURITY COMPLETELY. Supabase's default privileges
-- grant it to `authenticated` and `anon` on every table at creation time, and
-- 0002 could only remove it from the default privileges of grantor roles it had
-- membership in. Measured on the live database at the time this file was
-- written, `supabase_admin`'s default ACL still reads
-- `authenticated=arwdDxtm/supabase_admin` — the `D` is TRUNCATE. So the five
-- tables created above may have arrived with it granted, and 0002's one-time
-- loop has already run and will not catch them.
--
-- The loop is re-run over EVERY table in `public`, not just the five added here,
-- for the same reason 0002 did: a hand-written list is a hole waiting for the
-- next migration.
do $trunc4$
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
    'migration 0004: TRUNCATE revoked from authenticated and anon on % table(s) in schema public',
    touched;
end
$trunc4$;

-- Try the source again as well. 0002 may have been unable to reach some grantor
-- role; if that is still true the warning fires and the standing requirement
-- stays in force for migration 0005.
do $defacl4$
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
      'migration 0004: still cannot revoke TRUNCATE from the default privileges of role(s) %. ANY LATER MIGRATION THAT ADDS A TABLE MUST RE-RUN THE REVOKE LOOP IN SECTION 7.',
      array_to_string(unreached, ', ');
  end if;
end
$defacl4$;


-- =============================================================================
-- 8. Self-check — refuse to ship a hole
-- =============================================================================
-- Cheap, idempotent assertions that each of the five things this file exists to
-- do is actually done. A green migration output is the evidence; a red one stops
-- the deploy.

do $check4$
declare
  missing   text;
  offending text;
  mine      text[] := array[
    'document_chunks', 'webhook_events', 'inbound_messages',
    'agent_runs', 'agent_proposals'
  ];
begin
  -- (1) The PII leak is closed, and only as far as intended.
  if pg_catalog.has_column_privilege('authenticated', 'public.tenants', 'email', 'SELECT')
  or pg_catalog.has_column_privilege('authenticated', 'public.tenants', 'phone', 'SELECT')
  or pg_catalog.has_column_privilege('anon', 'public.tenants', 'email', 'SELECT')
  or pg_catalog.has_column_privilege('anon', 'public.tenants', 'phone', 'SELECT')
  then
    raise exception
      'migration 0004: tenants.email or tenants.phone is still SELECT-able by a client role. The PII leak this migration exists to close is open.';
  end if;

  if not pg_catalog.has_column_privilege('authenticated', 'public.tenants', 'full_name', 'SELECT')
  or not pg_catalog.has_column_privilege('authenticated', 'public.tenants', 'organization_id', 'SELECT')
  then
    raise exception
      'migration 0004: over-revoked. The authenticated role can no longer read tenants.full_name or tenants.organization_id, which the §4 matrix requires.';
  end if;

  if pg_catalog.to_regprocedure('public.tenant_contact(uuid, uuid)') is null then
    raise exception 'migration 0004: public.tenant_contact is missing, so staff have no read path to tenant contact details.';
  end if;

  -- (2) The documents policies that §2 mirrors are all still present. If one is
  -- renamed or removed, can_read_document has silently drifted from the matrix.
  select string_agg(want, ', ' order by want)
    into offending
  from unnest(array[
    'documents_select_staff',
    'documents_select_owner',
    'documents_select_own_tenancy',
    'documents_select_provider_assigned'
  ]) as want
  where not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'documents' and p.policyname = want
  );

  if offending is not null then
    raise exception
      'migration 0004: documents SELECT policy/policies missing: %. public.can_read_document mirrors them and has drifted. Reconcile both before deploying.', offending;
  end if;

  -- (3) Row level security on every table this migration added.
  select string_agg(c.relname, ', ' order by c.relname)
    into missing
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (mine)
    and c.relrowsecurity is false;

  if missing is not null then
    raise exception 'migration 0004: row level security is not enabled on: %', missing;
  end if;

  -- (4) No DELETE or FOR ALL policy on anything this migration added.
  select string_agg(format('%s.%s', p.tablename, p.policyname), ', ' order by p.policyname)
    into offending
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename = any (mine)
    and p.cmd in ('DELETE', 'ALL');

  if offending is not null then
    raise exception
      'migration 0004: DELETE or FOR ALL policy present on a table added here: %', offending;
  end if;

  -- (5) No DELETE privilege for a client role on anything this migration added.
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
      and c.relname = any (mine)
      and pg_catalog.has_table_privilege(g.rolname, c.oid, 'DELETE')
  ) t;

  if offending is not null then
    raise exception 'migration 0004: DELETE is granted to a client role on: %', offending;
  end if;

  -- (6) TRUNCATE is gone everywhere in public, inherited grants included.
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
      'migration 0004: TRUNCATE is still granted in schema public, which bypasses row level security and voids every policy in 0002 and 0004: %', offending;
  end if;

  -- (7) A model cannot approve its own proposal: no UPDATE privilege and no
  --     UPDATE policy on agent_proposals for any client role.
  if pg_catalog.has_table_privilege('authenticated', 'public.agent_proposals', 'UPDATE')
  or pg_catalog.has_table_privilege('anon', 'public.agent_proposals', 'UPDATE')
  then
    raise exception
      'migration 0004: UPDATE on public.agent_proposals is granted to a client role. A browser session could mark a model proposal approved without a human decision.';
  end if;

  if exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = 'agent_proposals' and p.cmd = 'UPDATE'
  ) then
    raise exception
      'migration 0004: an UPDATE policy exists on public.agent_proposals. Approval must go through public.approve_agent_proposal.';
  end if;

  if pg_catalog.to_regprocedure('public.approve_agent_proposal(uuid)') is null
  or pg_catalog.to_regprocedure('public.reject_agent_proposal(uuid)') is null
  then
    raise exception 'migration 0004: the proposal decision RPCs are missing, so a pending proposal can never be decided.';
  end if;

  -- (8) Webhook idempotency is a database constraint, not a convention.
  if not exists (
    select 1
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'webhook_events'
      and k.conname = 'webhook_events_provider_event_id_key'
      and k.contype = 'u'
  ) then
    raise exception
      'migration 0004: unique (provider, event_id) is missing on public.webhook_events. A replayed delivery would be processed twice.';
  end if;

  -- (9) A chunk cannot reference another organization's document.
  if not exists (
    select 1
    from pg_catalog.pg_constraint k
    join pg_catalog.pg_class c on c.oid = k.conrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'document_chunks'
      and k.conname = 'document_chunks_document_fkey'
      and k.contype = 'f'
      and pg_catalog.array_length(k.conkey, 1) = 2
  ) then
    raise exception
      'migration 0004: the composite foreign key on public.document_chunks is missing or is not two columns wide. A chunk could reference another organization''s document.';
  end if;

  -- (10) The embedding column is the indexable type, and it is indexed.
  if not exists (
    select 1
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_type ty on ty.oid = a.atttypid
    where n.nspname = 'public'
      and c.relname = 'document_chunks'
      and a.attname = 'embedding'
      and ty.typname = 'halfvec'
      and not a.attisdropped
  ) then
    raise exception
      'migration 0004: document_chunks.embedding is not halfvec. vector(2048) cannot be indexed by ivfflat or hnsw, which cap the vector type at 2000 dimensions.';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_class i
    join pg_catalog.pg_index ix on ix.indexrelid = i.oid
    join pg_catalog.pg_class t on t.oid = ix.indrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    join pg_catalog.pg_am am on am.oid = i.relam
    where n.nspname = 'public'
      and t.relname = 'document_chunks'
      and am.amname = 'hnsw'
  ) then
    raise exception
      'migration 0004: no hnsw index on public.document_chunks. The embedding column must not ship unindexable or unindexed.';
  end if;

  -- (11) Retrieval exists and is organization-scoped by signature.
  if pg_catalog.to_regprocedure('public.search_document_chunks(uuid, public.halfvec, int, uuid)') is null then
    raise exception 'migration 0004: public.search_document_chunks is missing.';
  end if;

  raise notice 'migration 0004: self-check passed — PII leak closed, chunks org-bound and indexed, webhooks idempotent, proposals human-gated, TRUNCATE revoked';
end
$check4$;
