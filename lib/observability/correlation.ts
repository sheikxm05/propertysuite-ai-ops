/**
 * Correlation identifiers.
 *
 * One id per request, present on every log line, on the error envelope (`request_id`,
 * §5.2) and on the `X-Request-Id` response header. When a Wave 2 lane traces a failure
 * from a browser network tab into a job row, this is the thread it pulls.
 *
 * An inbound `x-request-id` is honoured so that a caller — a load balancer, the e2e
 * suite, a future WhatsApp webhook relay — can propagate its own id. It is validated
 * first: an attacker-controlled header is echoed into logs and responses, so it must be
 * length-bounded and restricted to characters that cannot forge a log line or smuggle a
 * CRLF into a header.
 */

/** Header read on the way in and written on the way out. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Only these characters survive. No whitespace, no control characters, no CR/LF. */
const SAFE_ID = /^[A-Za-z0-9._:-]{8,64}$/;

/**
 * Returns the caller's request id when it is safe to reuse, otherwise a fresh UUID.
 */
export function resolveRequestId(request: Request): string {
  const supplied = request.headers.get(REQUEST_ID_HEADER);
  if (supplied && SAFE_ID.test(supplied)) return supplied;
  return newRequestId();
}

/** A fresh correlation id. */
export function newRequestId(): string {
  // `crypto` is global in Node 20+, in the edge runtime and in browsers.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Only reachable on a runtime without WebCrypto. Not security-sensitive: a
  // correlation id needs to be unique, not unguessable.
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * A stable, low-cardinality route label for logs and rate-limit keys.
 *
 * UUIDs and other path ids are replaced with `:id` so that
 * `/api/v1/properties/9f3…/units` and `/api/v1/properties/aa1…/units` aggregate to one
 * label. That keeps log cardinality bounded and, more importantly, keeps a specific
 * tenant's resource id out of a metric name.
 */
export function routeLabel(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  return pathname
    .split('/')
    .map((segment) => (isOpaqueId(segment) ? ':id' : segment))
    .join('/');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOpaqueId(segment: string): boolean {
  if (UUID.test(segment)) return true;
  // Numeric ids and long opaque tokens in a path segment.
  if (/^\d+$/.test(segment)) return true;
  return segment.length > 24 && !segment.includes('.');
}
