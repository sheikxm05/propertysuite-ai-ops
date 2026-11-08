# Technical Architecture

## Architecture style

Modular monolith with domain boundaries. Next.js is the web application and API boundary. Supabase provides authentication, PostgreSQL and private object storage. Long-running tasks are processed asynchronously by a durable worker/queue.

## Logical components

1. Web UI: dashboards and role-specific pages.
2. API layer: route handlers, schema validation, authentication and authorization.
3. Domain services: properties, tenancies, maintenance, documents, notifications.
4. Persistence: PostgreSQL with organization-scoped RLS.
5. AI adapter: provider-neutral interface; prompts and JSON schemas versioned in source.
6. Integration adapters: WhatsApp, email, Drive and Stripe.
7. Worker: document extraction, reminders, notifications and synchronization.

## Request flow

Client -> Next.js route handler -> authenticate -> authorize organization/resource -> validate input -> domain service -> database/queue/provider -> response.

## AI workflow

Message -> identify authenticated actor and organization -> fetch only authorized context -> LLM structured classification -> validate output -> return draft -> human confirmation -> create ticket through normal domain service.

The model must not receive service-role credentials or unrestricted database tools.

## Background jobs

Use a durable queue or managed scheduled/queue service. Each job should have:

- Unique idempotency key
- Attempt count and next retry time
- Bounded exponential backoff
- Dead-letter/failure state
- Correlation ID and safe structured logs

Do not rely on an HTTP request staying open for long-running extraction or synchronization.

## Suggested repository layout

```text
apps/web/
  app/
    (auth)/
    (dashboard)/
    api/v1/
  components/
  features/
    organizations/
    properties/
    tenants/
    tenancies/
    maintenance/
    documents/
  lib/
    supabase/
    auth/
    validation/
packages/
  database/
    migrations/
    types/
  shared/
    schemas/
    constants/
services/
  ai/
    providers/
    prompts/
    workflows/
  integrations/
    whatsapp/
    google-drive/
    email/
    stripe/
  workers/
docs/
tests/
```

## Key decisions

- Use UUID primary keys.
- Store money as numeric(12,2) plus ISO currency code.
- Store timestamps as timestamptz.
- Use JSONB only for flexible provider metadata, not core relational fields.
- Keep organization_id on tenant-scoped business tables.
- Validate cross-table organization consistency in database constraints/triggers or carefully designed service functions, in addition to RLS.
