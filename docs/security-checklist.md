# Security Checklist

## Identity and authorization
- [ ] Verify Supabase session server-side on every protected route.
- [ ] Derive organization membership from trusted database records.
- [ ] Check role and resource-level permissions for every mutation.
- [ ] Enable RLS on every tenant-scoped table.
- [ ] Test cross-organization read, insert, update and delete attempts.
- [ ] Ensure service-role key is never exposed to browser code.

## Data protection
- [ ] Use private storage buckets.
- [ ] Use short-lived signed URLs.
- [ ] Validate MIME type, extension and file size.
- [ ] Scan uploaded files before processing where feasible.
- [ ] Avoid logging document text, tokens or personal data.
- [ ] Define retention and deletion policies.

## AI safety
- [ ] Treat document text and user messages as untrusted.
- [ ] Prevent retrieved content from overriding system instructions.
- [ ] Send only the minimum authorized context to the model.
- [ ] Validate model output against a strict schema.
- [ ] Keep AI tools read-only by default.
- [ ] Require human confirmation for consequential changes.
- [ ] Rate-limit and monitor AI endpoints.

## Integrations
- [ ] Verify WhatsApp and Stripe webhook authenticity.
- [ ] Deduplicate webhook event IDs.
- [ ] Store secrets in server-side environment variables.
- [ ] Rotate credentials and restrict scopes.
- [ ] Use idempotency keys for outbound actions.
