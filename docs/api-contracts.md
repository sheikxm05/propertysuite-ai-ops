# API Contracts (Draft)

Base path: `/api/v1`. All authenticated requests derive the actor and organization membership from the verified session; do not trust a client-supplied organization ID as authorization.

## Properties
- `GET /properties?cursor=&limit=` — list accessible properties.
- `POST /properties` — create property.
- `GET /properties/{propertyId}` — retrieve property.
- `PATCH /properties/{propertyId}` — update property.
- `POST /properties/{propertyId}/units` — create unit.
- `GET /properties/{propertyId}/units` — list units.

Create property request:
```json
{
  "name": "Marina Residence",
  "property_type": "apartment_building",
  "address_line": "Example Street",
  "city": "Dubai",
  "emirate": "Dubai"
}
```

## Tenancies
- `GET /tenancies`
- `POST /tenancies`
- `GET /tenancies/{tenancyId}`
- `PATCH /tenancies/{tenancyId}`

## Maintenance
- `GET /maintenance/tickets`
- `POST /maintenance/tickets`
- `GET /maintenance/tickets/{ticketId}`
- `PATCH /maintenance/tickets/{ticketId}`
- `POST /maintenance/tickets/{ticketId}/assign`
- `POST /maintenance/tickets/{ticketId}/activities`
- `POST /maintenance/tickets/{ticketId}/complete`

Create ticket request:
```json
{
  "property_unit_id": "uuid",
  "title": "Air conditioning not cooling",
  "description": "The AC is running but not cooling the room.",
  "category": "hvac",
  "priority": "normal",
  "source": "web"
}
```

## Documents
- `POST /documents/upload-url` — request authorized upload URL.
- `POST /documents/{documentId}/process` — enqueue extraction.
- `GET /documents/{documentId}`
- `POST /documents/{documentId}/verify` — submit human-verified fields.

## AI
- `POST /ai/maintenance/classify` — returns a draft classification; does not create a ticket.
- `POST /ai/maintenance/confirm` — authorized ticket creation after confirmation.
- `POST /ai/documents/extract` — enqueue extraction; results remain unverified.

## Webhooks
- `POST /webhooks/whatsapp`
- `POST /webhooks/stripe`

Webhook handlers must verify signatures/tokens, reject invalid requests and deduplicate provider event IDs.

## Standard error response
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request is invalid.",
    "request_id": "correlation-id"
  }
}
```

## Status codes
- 200 successful read/update
- 201 created
- 202 accepted for asynchronous processing
- 400 invalid request
- 401 unauthenticated
- 403 unauthorized
- 404 absent or inaccessible resource
- 409 conflict/idempotency conflict
- 422 semantically invalid request
- 429 rate limited
- 500 unexpected server error
