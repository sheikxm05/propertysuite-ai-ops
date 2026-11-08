'use client';

/**
 * The browser's side of the maintenance API.
 *
 * Every client component in this lane mutates through these functions rather than
 * calling `fetch` inline, for one reason: the frozen error envelope
 * (`{ error: { code, message, request_id } }`) must be surfaced to the user as the
 * server's own message, not as a message the browser invented. A hand-rolled `fetch`
 * that printed "Something went wrong" would throw away a `409 CONFLICT` that says
 * exactly which transition was refused, and the `request_id` that joins the user's
 * complaint to the server log.
 *
 * What these functions deliberately do NOT do:
 *
 *  - They never decide anything. No transition check, no role check, no priority
 *    calculation. The server decides and these report. A client-side guard here would
 *    be a security control in the browser, and worse, one that could drift from the
 *    server's.
 *  - They send no `organization_id`. Nothing in this lane's request bodies carries one;
 *    the server derives it from the session (CLAUDE.md rule 5).
 *
 * `credentials: 'same-origin'` is explicit so the session cookie is sent on every call
 * even if a future `fetch` default changes.
 */

const BASE = '/api/v1/maintenance/tickets';

/** The frozen §5.2 envelope, as the browser sees it. */
export interface ApiErrorEnvelope {
  error: { code: string; message: string; request_id: string };
}

export class MaintenanceApiError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, envelope: ApiErrorEnvelope | null) {
    super(envelope?.error.message ?? 'The request could not be completed.');
    this.name = 'MaintenanceApiError';
    this.status = status;
    this.code = envelope?.error.code ?? 'INTERNAL_ERROR';
    this.requestId = envelope?.error.request_id ?? '';
  }
}

async function send<TResult>(url: string, method: string, body?: unknown): Promise<TResult> {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    throw new MaintenanceApiError(response.status, await readEnvelope(response));
  }
  return (await response.json()) as TResult;
}

async function readEnvelope(response: Response): Promise<ApiErrorEnvelope | null> {
  try {
    const parsed: unknown = await response.json();
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof (parsed as ApiErrorEnvelope).error?.code === 'string'
    ) {
      return parsed as ApiErrorEnvelope;
    }
  } catch {
    // A non-JSON body on a failure is itself the failure; fall through to the default.
  }
  return null;
}

export interface TicketResponse {
  data: { id: string; status: string; priority: string };
}

export function createTicketRequest(body: {
  property_unit_id: string;
  title: string;
  description: string;
  category: string;
  priority?: string;
  source: string;
}): Promise<TicketResponse> {
  return send(BASE, 'POST', body);
}

/** The generic transition. `status` is the only field, so nothing else can ride along. */
export function transitionTicket(ticketId: string, status: string): Promise<TicketResponse> {
  return send(`${BASE}/${ticketId}`, 'PATCH', { status });
}

export function assignTicketRequest(
  ticketId: string,
  body: { provider_id: string; note?: string },
): Promise<TicketResponse> {
  return send(`${BASE}/${ticketId}/assign`, 'POST', body);
}

/**
 * `confirmed: true` is set here rather than accepted as a parameter.
 *
 * It is a `z.literal(true)` in `CompleteTicketSchema`, and the human confirmation it
 * represents is the checkbox the caller already ticked in `CompleteTicketForm` — which
 * will not call this function without it. Making it a parameter would invite a caller to
 * pass it unconditionally and turn the literal into decoration.
 */
export function completeTicketRequest(
  ticketId: string,
  body: { resolution_summary: string; evidence_document_ids?: string[] },
): Promise<TicketResponse> {
  return send(`${BASE}/${ticketId}/complete`, 'POST', { ...body, confirmed: true });
}

export function addActivityRequest(
  ticketId: string,
  body: { activity_type: string; description: string },
): Promise<{ data: { id: string } }> {
  return send(`${BASE}/${ticketId}/activities`, 'POST', body);
}

/* ---------------------------------------------------------------- evidence -- */

/** `UploadUrlResponseSchema` from `packages/shared` — lane w1-l6's frozen contract. */
export interface UploadUrlResponse {
  data: {
    document_id: string;
    storage_path: string;
    upload_url: string;
    expires_in_seconds: number;
  };
}

/**
 * Uploads one completion-evidence PDF through lane w1-l6's documents endpoint.
 *
 * This lane writes NO code under `app/api/v1/documents` and no storage policy: amendment
 * A7 grants a `service_provider` INSERT on `documents` scoped to assigned tickets with
 * `property_id` and `tenancy_id` forced null, and the upload URL is minted by
 * `POST /api/v1/documents/upload-url` against the frozen path
 * `{organization_id}/{entity}/{uuid}.pdf` with a 60-second TTL (§5.7).
 *
 * `ticket_id` is the only association sent, which is the only one a provider may set.
 * The returned `document_id` is what `completeTicketRequest` later cites, and the
 * completion route verifies the linkage server-side before it closes the ticket — so a
 * failed or hostile upload cannot smuggle another ticket's document into this one's
 * evidence.
 */
export async function uploadEvidence(ticketId: string, file: File): Promise<string> {
  const minted = await send<UploadUrlResponse>('/api/v1/documents/upload-url', 'POST', {
    document_type: 'maintenance_evidence',
    file_name: file.name,
    content_type: 'application/pdf',
    size_bytes: file.size,
    ticket_id: ticketId,
  });

  const upload = await fetch(minted.data.upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: file,
  });
  if (!upload.ok) {
    throw new MaintenanceApiError(upload.status, null);
  }

  return minted.data.document_id;
}
