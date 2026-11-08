/**
 * The browser-side client for the property and unit routes.
 *
 * It imports **only** `@shared/index`, which depends on nothing but `zod`. Nothing from
 * `lib/**` is reachable from here: `lib/api/errors.ts` and friends are server modules, and
 * pulling one into a client bundle is how a server-shaped import graph starts drifting
 * towards the service-role client. The shared package exists precisely so both sides can
 * agree without either importing the other.
 *
 * Two things this file is careful about:
 *
 *  1. **It parses the frozen error envelope rather than guessing.** §5.2 freezes
 *     `{ error: { code, message, request_id } }` and the eight codes; `ApiErrorSchema`
 *     from `packages/shared` is that shape, so a response that does not match is treated
 *     as an unknown failure instead of being read optimistically.
 *  2. **It never decides whether input is acceptable.** Client-side validation with the
 *     shared schema is a courtesy to the person typing. The server validates the same
 *     schema again and is the only authority — see the note at the top of
 *     `components/ui/form.tsx`.
 */

import {
  ApiErrorSchema,
  ERROR_MESSAGES,
  isErrorCode,
  type ErrorCode,
  type PageInfo,
  type PropertyRow,
  type PropertyUnitRow,
} from '@shared/index';

/** A failed request, with the correlation id so a user can quote it in a support request. */
export class ApiClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly requestId: string | null;

  constructor(code: ErrorCode, message: string, status: number, requestId: string | null) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

/** `{ data }` — the single-resource success envelope from `lib/api/responses.ts`. */
interface ResourceEnvelope<T> {
  data: T;
}

/**
 * `{ data, page_info }` — the cursor-page envelope, settled by orchestrator ruling A18 in
 * favour of the `packages/shared` shape. `page_info` is the frozen `PageInfo` type rather
 * than a structural copy, so a client reading `next_cursor` out of it cannot drift from
 * what the routes emit. It is NOT the flat `{ data, next_cursor }` that
 * `lib/api/responses.ts`'s `paginated()` still produces.
 */
export interface PageEnvelope<T> {
  data: T[];
  page_info: PageInfo;
}

/* ----------------------------------------------------------------- transport -- */

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    // Session cookies only. No token is read, stored or forwarded by this module.
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const requestId = response.headers.get('x-request-id');
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) throw toClientError(payload, response.status, requestId);

  return (payload as ResourceEnvelope<T>).data;
}

/**
 * Maps a non-2xx response onto the frozen envelope.
 *
 * A response that is not the frozen shape becomes `INTERNAL_ERROR` with the code's own
 * default message. Reading a message out of an unrecognised body would mean rendering
 * whatever an intermediary put there.
 */
function toClientError(payload: unknown, status: number, requestId: string | null): ApiClientError {
  const parsed = ApiErrorSchema.safeParse(payload);
  if (parsed.success && isErrorCode(parsed.data.error.code)) {
    return new ApiClientError(
      parsed.data.error.code,
      parsed.data.error.message,
      status,
      parsed.data.error.request_id || requestId,
    );
  }
  return new ApiClientError('INTERNAL_ERROR', ERROR_MESSAGES.INTERNAL_ERROR, status, requestId);
}

/* ------------------------------------------------------------------- routes -- */

/** `POST /api/v1/properties` */
export function createProperty(body: unknown): Promise<PropertyRow> {
  return request<PropertyRow>('/api/v1/properties', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** `PATCH /api/v1/properties/{propertyId}` */
export function updateProperty(propertyId: string, body: unknown): Promise<PropertyRow> {
  return request<PropertyRow>(`/api/v1/properties/${encodeURIComponent(propertyId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** `POST /api/v1/properties/{propertyId}/archive` — the only removal path. */
export function archiveProperty(propertyId: string): Promise<PropertyRow> {
  return request<PropertyRow>(`/api/v1/properties/${encodeURIComponent(propertyId)}/archive`, {
    method: 'POST',
  });
}

/** `POST /api/v1/properties/{propertyId}/units` */
export function createUnit(propertyId: string, body: unknown): Promise<PropertyUnitRow> {
  return request<PropertyUnitRow>(`/api/v1/properties/${encodeURIComponent(propertyId)}/units`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** `PATCH /api/v1/properties/{propertyId}/units/{unitId}` */
export function updateUnit(
  propertyId: string,
  unitId: string,
  body: unknown,
): Promise<PropertyUnitRow> {
  return request<PropertyUnitRow>(
    `/api/v1/properties/${encodeURIComponent(propertyId)}/units/${encodeURIComponent(unitId)}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
}
