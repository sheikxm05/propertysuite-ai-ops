-- Initial schema for the independent PropertySuite AI Operations Assistant demo.
-- Review and test in a disposable Supabase project before production use.

create extension if not exists pgcrypto;

create type public.member_role as enum (
  'organization_admin',
  'property_owner',
  'property_manager',
  'tenant',
  'service_provider'
);

create type public.ticket_status as enum (
  'open',
  'assigned',
  'in_progress',
  'awaiting_approval',
  'completed',
  'cancelled'
);

create type public.ticket_priority as enum ('low', 'normal', 'high', 'urgent');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status text not null default 'active' check (status in ('active','suspended')),
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null,
  status text not null default 'active' check (status in ('invited','active','disabled')),
  created_at timestamptz not null default now(),
  unique (organization_id, profile_id)
);

create table public.properties (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  property_type text not null,
  address_line text not null,
  city text not null default 'Dubai',
  emirate text not null default 'Dubai',
  owner_member_id uuid references public.organization_members(id),
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.property_units (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  unit_number text not null,
  bedrooms integer check (bedrooms is null or bedrooms >= 0),
  bathrooms numeric(4,1) check (bathrooms is null or bathrooms >= 0),
  area_sqft numeric(12,2) check (area_sqft is null or area_sqft >= 0),
  status text not null default 'available' check (status in ('available','occupied','inactive')),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (property_id, unit_number),
  foreign key (organization_id, property_id)
    references public.properties(organization_id, id) on delete cascade
);

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid references public.profiles(id),
  full_name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.tenancies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_unit_id uuid not null,
  tenant_id uuid not null,
  contract_number text,
  start_date date not null,
  end_date date not null,
  rent_amount numeric(12,2) not null check (rent_amount >= 0),
  currency char(3) not null default 'AED',
  status text not null default 'draft' check (status in ('draft','active','expired','terminated')),
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  foreign key (organization_id, property_unit_id)
    references public.property_units(organization_id, id),
  foreign key (organization_id, tenant_id)
    references public.tenants(organization_id, id),
  unique (organization_id, id)
);

create table public.service_providers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid references public.profiles(id),
  company_name text not null,
  service_categories text[] not null default '{}',
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.maintenance_tickets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  property_unit_id uuid not null,
  tenancy_id uuid,
  tenant_id uuid not null,
  assigned_provider_id uuid,
  title text not null,
  description text not null,
  category text not null default 'unknown',
  priority public.ticket_priority not null default 'normal',
  status public.ticket_status not null default 'open',
  source text not null default 'web' check (source in ('web','whatsapp','email','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, property_id)
    references public.properties(organization_id, id),
  foreign key (organization_id, property_unit_id)
    references public.property_units(organization_id, id),
  foreign key (organization_id, tenant_id)
    references public.tenants(organization_id, id),
  foreign key (organization_id, tenancy_id)
    references public.tenancies(organization_id, id),
  foreign key (organization_id, assigned_provider_id)
    references public.service_providers(organization_id, id)
);

create table public.maintenance_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  ticket_id uuid not null,
  actor_profile_id uuid references public.profiles(id),
  activity_type text not null,
  description text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (organization_id, ticket_id)
    references public.maintenance_tickets(organization_id, id) on delete cascade
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid,
  tenancy_id uuid,
  document_type text not null,
  storage_path text not null,
  extracted_data jsonb,
  verification_status text not null default 'pending'
    check (verification_status in ('pending','verified','rejected')),
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, property_id)
    references public.properties(organization_id, id),
  foreign key (organization_id, tenancy_id)
    references public.tenancies(organization_id, id)
);

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_profile_id uuid references public.profiles(id),
  channel text not null check (channel in ('web','whatsapp')),
  external_conversation_id text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null,
  sender_type text not null check (sender_type in ('user','assistant','system')),
  content text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (organization_id, conversation_id)
    references public.ai_conversations(organization_id, id) on delete cascade
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recipient_profile_id uuid references public.profiles(id),
  channel text not null check (channel in ('email','whatsapp','in_app')),
  event_type text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  retry_count integer not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_profile_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_members_profile on public.organization_members(profile_id);
create index idx_properties_org on public.properties(organization_id);
create index idx_units_property on public.property_units(organization_id, property_id);
create index idx_tenancies_tenant on public.tenancies(organization_id, tenant_id);
create index idx_tickets_org_status on public.maintenance_tickets(organization_id, status, created_at desc);
create index idx_tickets_provider on public.maintenance_tickets(organization_id, assigned_provider_id);
create index idx_documents_org on public.documents(organization_id, created_at desc);

-- Helper: current profile ID derived from the authenticated Supabase user.
create or replace function public.current_profile_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id from public.profiles p where p.auth_user_id = (select auth.uid()) limit 1
$$;

-- Helper: whether the current user is an active member of an organization.
create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = target_org
      and m.profile_id = public.current_profile_id()
      and m.status = 'active'
  )
$$;

-- Enable RLS on tenant-scoped tables.
alter table public.organization_members enable row level security;
alter table public.properties enable row level security;
alter table public.property_units enable row level security;
alter table public.tenants enable row level security;
alter table public.tenancies enable row level security;
alter table public.service_providers enable row level security;
alter table public.maintenance_tickets enable row level security;
alter table public.maintenance_activities enable row level security;
alter table public.documents enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_logs enable row level security;

-- Initial baseline policies: organization membership is required.
-- Add finer role/resource policies before production deployment.
create policy "members can view organization membership"
on public.organization_members for select
using (public.is_org_member(organization_id));

create policy "members can view properties"
on public.properties for select
using (public.is_org_member(organization_id));

create policy "members can insert properties"
on public.properties for insert
with check (public.is_org_member(organization_id));

create policy "members can update properties"
on public.properties for update
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view units"
on public.property_units for select
using (public.is_org_member(organization_id));

create policy "members can manage units"
on public.property_units for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view tenants"
on public.tenants for select
using (public.is_org_member(organization_id));

create policy "members can manage tenants"
on public.tenants for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view tenancies"
on public.tenancies for select
using (public.is_org_member(organization_id));

create policy "members can manage tenancies"
on public.tenancies for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view providers"
on public.service_providers for select
using (public.is_org_member(organization_id));

create policy "members can manage providers"
on public.service_providers for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view tickets"
on public.maintenance_tickets for select
using (public.is_org_member(organization_id));

create policy "members can create tickets"
on public.maintenance_tickets for insert
with check (public.is_org_member(organization_id));

create policy "members can update tickets"
on public.maintenance_tickets for update
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view ticket activities"
on public.maintenance_activities for select
using (public.is_org_member(organization_id));

create policy "members can add ticket activities"
on public.maintenance_activities for insert
with check (public.is_org_member(organization_id));

create policy "members can view documents"
on public.documents for select
using (public.is_org_member(organization_id));

create policy "members can manage documents"
on public.documents for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view conversations"
on public.ai_conversations for select
using (public.is_org_member(organization_id));

create policy "members can manage conversations"
on public.ai_conversations for all
using (public.is_org_member(organization_id))
with check (public.is_org_member(organization_id));

create policy "members can view messages"
on public.ai_messages for select
using (public.is_org_member(organization_id));

create policy "members can add messages"
on public.ai_messages for insert
with check (public.is_org_member(organization_id));

create policy "members can view notifications"
on public.notifications for select
using (public.is_org_member(organization_id));

create policy "members can add notifications"
on public.notifications for insert
with check (public.is_org_member(organization_id));

create policy "members can view audit logs"
on public.audit_logs for select
using (public.is_org_member(organization_id));

-- IMPORTANT SECURITY TODO:
-- These baseline policies only establish organization membership isolation.
-- They do NOT yet enforce fine-grained role, tenant-self, provider-assignment,
-- owner-property, or organization-admin restrictions. Add those policies and
-- test them before exposing the app to real users.
-- Also add organization creation/invitation functions with carefully scoped
-- SECURITY DEFINER logic and explicit grants.
