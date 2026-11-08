# Software Requirements Specification

## 1. Purpose

Build a portfolio-grade AI-assisted property operations application for a Dubai real-estate scenario. The project demonstrates full-stack engineering, AI integration, secure data access, integrations, testing and deployment.

This is an independently designed demonstration project, not a confirmed PropertySuite internal roadmap or take-home assignment.

## 2. Actors

- Platform administrator: platform-level administration.
- Organization administrator: manages one organization and its members.
- Property owner: views properties and related activity they are authorized to access.
- Property manager: manages properties, tenancies and maintenance.
- Tenant: views own tenancy and creates/tracks maintenance requests.
- Service provider: sees only assigned jobs and updates permitted job information.

## 3. MVP scope

### Authentication and organizations

- Sign in/out using Supabase Auth.
- Organization membership and invitations.
- Role-based authorization.
- Organization-scoped data isolation enforced by PostgreSQL RLS.

### Property management

- Create, read, update and archive properties.
- Manage units.
- Associate owners and authorized managers.
- Store address, property type and unit attributes.

### Tenant and tenancy management

- Create tenant records and link to application users where applicable.
- Create tenancy records with start/end dates and rent amount.
- Track tenancy status.
- Avoid exposing another tenant's personal data.

### Maintenance

- Tenant creates a request manually or through AI-assisted intake.
- Manager reviews, prioritizes and assigns a service provider.
- Provider updates status and adds completion evidence.
- Manager/tenant confirms completion according to policy.
- Keep an immutable activity history for key transitions.

### AI maintenance assistant

- Classify a tenant's message into a controlled category.
- Extract a concise summary and missing information.
- Return validated structured output.
- Never assign providers, approve quotes, make payments or perform other consequential actions without an authorized human action.
- Create a ticket only after user confirmation or an explicitly authorized workflow.

### Document intelligence

- Upload PDF documents to private storage.
- Extract text and proposed fields.
- Display extracted values for human verification.
- Save verified fields only after authorized confirmation.
- Do not treat AI extraction as legal or financial truth.

## 4. Later-phase scope

- WhatsApp Cloud API webhook and outbound messaging.
- Google Drive synchronization.
- Email notifications.
- Contract expiry reminders.
- Stripe payment processing and webhook reconciliation.
- RAG over authorized property documents.
- Market data synchronization, subject to lawful data access and source terms.

## 5. Out of scope for MVP

- Property listing marketplace.
- Automated legal advice.
- Autonomous rent collection or payment initiation.
- Automated property valuation claims.
- Training a foundation model.
- Direct integration with PropertySuite's production systems.

## 6. Functional acceptance criteria

1. A user can authenticate and belong to an organization.
2. Organization A cannot read or modify Organization B's records.
3. Authorized users can create and update properties and units.
4. A manager can create and manage tenancies.
5. A tenant can create a maintenance ticket for an authorized unit.
6. A manager can assign a provider within the same organization.
7. A provider can view only jobs assigned to them.
8. AI classification returns schema-valid data and cannot bypass authorization.
9. Document extraction is marked unverified until a human reviews it.
10. Critical state changes create audit/activity records.

## 7. Non-functional requirements

- Validate all external inputs.
- Enforce authorization server-side and in RLS.
- Use private object storage and signed URLs.
- Keep secrets server-side.
- Make webhook handling idempotent.
- Use bounded retries and dead-letter handling for jobs.
- Log errors without logging sensitive document contents or secrets.
- Provide unit, integration and end-to-end tests.
