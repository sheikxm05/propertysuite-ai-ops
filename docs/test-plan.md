# Test Plan

## Unit tests
- Input schemas and validation.
- Role/permission policy functions.
- Maintenance status transition rules.
- AI output parsing and normalization.
- Idempotency key generation.

## Database/integration tests
- RLS allows same-organization authorized access.
- RLS blocks cross-organization access.
- Tenant can create a ticket only for an authorized tenancy/unit.
- Provider can access only assigned tickets.
- Organization IDs cannot be mismatched across related records.
- Duplicate webhook event is processed once.

## AI evaluation tests
- HVAC issue classified as HVAC.
- Plumbing leak classified as plumbing.
- Missing property context triggers clarification.
- Prompt injection in document content is treated as untrusted.
- Invalid model JSON is rejected safely.
- Model output never directly executes a privileged action.

## End-to-end scenarios
1. Organization admin invites a property manager.
2. Manager creates property and unit.
3. Manager adds tenant and tenancy.
4. Tenant submits maintenance request.
5. AI returns a draft classification.
6. Tenant confirms; ticket is created.
7. Manager assigns provider.
8. Provider updates progress and completion.
9. Manager/tenant confirms completion.
10. Other organization cannot access any of these records.

## Release gates
- Type check passes.
- Lint passes.
- Unit and integration tests pass.
- E2E smoke test passes.
- RLS/security suite passes.
- No secrets in client bundle or repository.
