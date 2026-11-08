# Implementation Plan

## Sprint 0 — Repository and conventions

- Create Next.js App Router TypeScript app.
- Configure ESLint, formatting, strict TypeScript and CI.
- Add environment validation and README.
- Add Supabase client helpers for browser and server contexts.

## Sprint 1 — Identity and tenant isolation

- Apply database migration.
- Configure Supabase Auth.
- Create organization onboarding and membership flow.
- Implement role checks.
- Add and test RLS policies.

**Exit gate:** automated tests prove cross-organization isolation.

## Sprint 2 — Property and tenancy

- Property and unit CRUD.
- Tenant profiles and tenancy lifecycle.
- Form validation and audit events.
- Role-specific dashboard.

## Sprint 3 — Maintenance workflow

- Ticket creation and listing.
- Assignment and status transitions.
- Provider views.
- Activity history.
- Authorization and transition tests.

## Sprint 4 — AI maintenance intake

- Provider abstraction.
- Prompt and JSON schema.
- Classification endpoint.
- Clarification UX.
- Explicit confirmation before ticket creation.
- Evaluation set with representative examples.

## Sprint 5 — Document intelligence

- Private PDF upload.
- Asynchronous text extraction.
- Structured field extraction.
- Human verification UI.
- Expiry reminders.

## Sprint 6 — Integrations

- Email adapter.
- WhatsApp webhook and outbound adapter.
- Google Drive sync.
- Durable background queue and retries.

## Sprint 7 — Hardening and demo

- Stripe test-mode integration if in scope.
- E2E tests.
- Security review.
- Observability and deployment.
- Demo seed data and walkthrough.

## Definition of done

Every feature has validation, authorization, error handling, tests, documentation and a clean PR. Do not mark a feature complete based only on a working happy path.
