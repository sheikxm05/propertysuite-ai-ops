# PropertySuite AI Operations Assistant

A proposed, independent portfolio project inspired by publicly described PropertySuite workflows and its advertised AI Developer role. This is **not** PropertySuite's source code or an official assignment.

## Goal
Demonstrate a secure, multi-tenant property operations application with:
- Organization membership and role-based access
- Property, unit, tenant and tenancy management
- Maintenance ticket workflows
- AI-assisted maintenance classification
- Document upload and extraction with human verification
- Notifications and external integration adapters

## Recommended stack
- Next.js App Router + TypeScript
- Supabase Auth, PostgreSQL, Storage and Row Level Security
- Zod for input validation
- OpenAI or Anthropic behind a provider abstraction
- A durable background queue for asynchronous work
- Vitest/Jest for unit and integration tests; Playwright for E2E

## Architecture decision
Start as a **modular monolith**. Keep domain modules separate, but avoid microservices until there is a demonstrated operational need.

## Quick start
1. Install Node.js LTS and create a Supabase project.
2. Copy `.env.example` to `.env.local` and fill in credentials.
3. Apply SQL migrations in `supabase/migrations/` using the Supabase CLI or SQL editor.
4. Install dependencies and run the Next.js app after creating the app scaffold:
   ```bash
   npm install
   npm run dev
   ```
5. Follow `docs/implementation-plan.md`.

This ZIP contains the requirements, architecture, initial database migration, API contracts, AI prompt contracts, security checklist, test plan and implementation backlog. It is a project blueprint, not a fully implemented/deployed application.
