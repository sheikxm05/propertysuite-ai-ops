/**
 * `X-Hub-Signature-256` verification.
 *
 * This file is the lane's engineering claim, so it is worth being precise about what is
 * being asserted and what is not.
 *
 * **Verified over the raw bytes.** The HMAC input is the exact octets Meta sent. A
 * handler that parses JSON first and re-serialises it before hashing has verified a
 * signature over *its own* bytes, not the sender's: key ordering, unicode escaping,
 * number formatting and whitespace all differ between an arbitrary producer and
 * `JSON.stringify`, so such a check either fails constantly or — worse, when the
 * re-serialisation happens to round-trip — passes on a payload nobody signed. That is
 * why `verifyWebhookSignature` takes a `Uint8Array` and the route reads
 * `await request.arrayBuffer()` before it reads anything else.
 *
 * **Compared in constant time.** `===` on two hex strings returns as soon as it finds a
 * differing character, which makes the comparison's duration a function of how many
 * leading hex digits the attacker guessed correctly. With retries that is enough to
 * walk a forged digest out one nibble at a time. `crypto.timingSafeEqual` compares every
 * byte regardless.
 *
 * **Length is not an oracle either.** `timingSafeEqual` *throws* on buffers of unequal
 * length, which would turn "wrong length" into a different, cheaper, distinguishable
 * outcome. So both sides are re-hashed to a fixed 32 bytes before the comparison: any
 * input, however long or short, becomes exactly one 32-byte digest, and the single
 * comparison is the only branch an attacker can time.
 *
 * Pure and dependency-free (`node:crypto` is built in). Nothing here reads
 * configuration, so the key source — a real app secret or the published simulated key —
 * is the caller's decision and this module behaves identically for both.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { SIGNATURE_PREFIX } from './constants';

/** Why a signature check failed. Safe to log: no part of it is caller data. */
export type SignatureFailureReason =
  'signature_header_absent' | 'signature_header_malformed' | 'signature_mismatch';

export type SignatureVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: SignatureFailureReason };

/** Lowercase hex, exactly 64 characters — the width of a SHA-256 digest. */
const HEX_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Computes the header value Meta would send for these bytes and this key.
 *
 * Exported because the demo needs it: with no Meta credentials, the only way to produce
 * a correctly signed delivery is to sign one locally with the same function the server
 * verifies with. It is also what `tools/sign` style scripting would call.
 */
export function computeWebhookSignature(rawBody: Uint8Array | string, key: string): string {
  const hmac = createHmac('sha256', key);
  hmac.update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody));
  return `${SIGNATURE_PREFIX}${hmac.digest('hex')}`;
}

/**
 * Verifies a delivery.
 *
 * Fails closed in every direction: an absent header, a header that is not
 * `sha256=<64 hex>`, and a well-formed header that does not match are all rejections.
 * In particular an absent header is never treated as "unsigned, therefore allowed" —
 * that is the single mistake that makes a webhook endpoint a public write API.
 */
export function verifyWebhookSignature(params: {
  readonly rawBody: Uint8Array;
  readonly header: string | null | undefined;
  readonly key: string;
}): SignatureVerification {
  const { rawBody, header, key } = params;

  if (typeof header !== 'string' || header.length === 0) {
    return { ok: false, reason: 'signature_header_absent' };
  }

  const supplied = header.trim().toLowerCase();
  if (!supplied.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'signature_header_malformed' };
  }

  const digest = supplied.slice(SIGNATURE_PREFIX.length);
  if (!HEX_DIGEST.test(digest)) {
    return { ok: false, reason: 'signature_header_malformed' };
  }

  const expected = computeWebhookSignature(rawBody, key);
  return constantTimeEquals(expected, supplied)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

/**
 * Constant-time string comparison that does not leak length.
 *
 * Both sides are reduced to a 32-byte SHA-256 digest first. Hashing before comparing is
 * the standard construction: `timingSafeEqual` needs equal lengths and refuses to
 * compare unequal ones, and feeding it caller-controlled lengths directly converts a
 * length mismatch into an exception — a branch that is both faster and differently
 * shaped than a byte-by-byte mismatch, which is exactly the signal the comparison is
 * meant to withhold.
 *
 * Also used for the `hub.verify_token` handshake, where the same reasoning applies: a
 * verify token is a bearer credential and `===` against one is guessable byte by byte.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = createHmac('sha256', EQUALITY_KEY).update(a, 'utf8').digest();
  const right = createHmac('sha256', EQUALITY_KEY).update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * A per-process random key for the comparison HMAC.
 *
 * A plain hash would also work, but keying it means an attacker who can observe the
 * comparison cannot precompute digests to probe with, and the key never leaves this
 * module or outlives the process. It is not a secret in the configuration sense — it
 * protects nothing at rest — so it is generated rather than configured.
 */
const EQUALITY_KEY = createHmac('sha256', 'propertysuite-equality')
  .update(
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : String(Date.now()),
  )
  .digest();
