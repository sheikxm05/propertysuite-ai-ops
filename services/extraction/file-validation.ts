/**
 * Upload validation — declared metadata first, then the bytes themselves.
 *
 * `docs/security-checklist.md` asks for MIME type, extension and size validation.
 * This module adds the one that actually matters: **magic bytes**. A declared
 * `content-type` is a client assertion, and `.pdf` is a string a caller chose. Neither
 * tells you what the file is. `%PDF-` at the head of the object does, and nothing else
 * in this lane touches a file's contents before `assertPdfBytes` has agreed.
 *
 * Two validation surfaces, deliberately separate, because they run at different times
 * and can disagree:
 *
 *  1. `validateDeclaredUpload` — runs in `POST /documents/upload-url`, before any bytes
 *     exist. It can only check what the client claims: MIME, extension, declared size.
 *  2. `assertPdfBytes` — runs in `POST /documents/{id}/process` and **again** inside the
 *     extraction worker, on the real object downloaded from Storage. The object could
 *     have been replaced between the two, so the worker re-checks rather than trusting
 *     the route's verdict.
 *
 * Every rejection is `UNPROCESSABLE` (422) with a stable `snake_case` reason token. The
 * reason is for the server log; the client gets the frozen envelope's message. A
 * rejection message that described the sniffed file type would be a free file-format
 * oracle.
 *
 * Nothing here is a local copy of a shared constant: `ALLOWED_UPLOAD_MIME_TYPES`,
 * `ALLOWED_UPLOAD_EXTENSIONS` and `MAX_UPLOAD_BYTES` all come from
 * `packages/shared/constants/storage` (§5.7, frozen), and the ones below are facts
 * about the PDF container format, which no other lane owns.
 */

import {
  ALLOWED_UPLOAD_EXTENSIONS,
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
} from '@shared/index';

/* ------------------------------------------------------------ magic bytes -- */

/**
 * `%PDF-` — the five bytes every PDF file begins with (ISO 32000-1 §7.5.2).
 *
 * The version digits that follow are deliberately not checked. A `%PDF-1.7` file and a
 * `%PDF-2.0` file are both PDFs, and pinning a version list here would reject valid
 * documents for no security gain.
 */
export const PDF_MAGIC_BYTES: readonly number[] = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * How far into the file the signature may start.
 *
 * Zero would be the strict reading of the specification, but real producers emit a
 * byte-order mark or a stray newline, and pdf.js itself scans the first 1024 bytes for
 * the header. A bounded window matches what the parser will accept; an unbounded one
 * would let an attacker prepend an entire HTML document and still pass.
 */
export const PDF_MAGIC_SEARCH_WINDOW = 1024;

/** The trailer every well-formed PDF ends with. Advisory — see `looksLikePdf`. */
export const PDF_TRAILER_MARKER = '%%EOF';

/** Smallest byte count that could possibly be a parseable PDF. */
export const MIN_PDF_BYTES = 32;

/**
 * Does `bytes` carry the PDF signature within the search window?
 *
 * Byte comparison, never string decoding. Decoding first would mean choosing an
 * encoding for a file whose encoding is the thing in question, and a UTF-16 decode of
 * arbitrary binary can produce a `%PDF-` that is not there.
 */
export function hasPdfMagicBytes(bytes: Uint8Array): boolean {
  return findPdfMagicOffset(bytes) >= 0;
}

/** Offset of the `%PDF-` signature, or `-1`. */
export function findPdfMagicOffset(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length, PDF_MAGIC_SEARCH_WINDOW + PDF_MAGIC_BYTES.length);
  const first = PDF_MAGIC_BYTES[0] as number;

  for (let start = 0; start + PDF_MAGIC_BYTES.length <= limit; start += 1) {
    if (bytes[start] !== first) continue;
    let matched = true;
    for (let offset = 1; offset < PDF_MAGIC_BYTES.length; offset += 1) {
      if (bytes[start + offset] !== PDF_MAGIC_BYTES[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

/* ------------------------------------------------------------------ types -- */

/**
 * Stable rejection tokens. Logged and asserted in tests, never returned to a client.
 *
 * They are a closed union so that a new rejection path cannot be added without the
 * compiler pointing at the test that enumerates them.
 */
export type UploadRejectionReason =
  | 'mime_type_not_allowed'
  | 'extension_not_allowed'
  | 'declared_size_exceeds_cap'
  | 'declared_size_not_positive'
  | 'byte_size_exceeds_cap'
  | 'byte_size_below_minimum'
  | 'magic_bytes_not_pdf';

export type UploadValidation =
  { readonly ok: true } | { readonly ok: false; readonly reason: UploadRejectionReason };

const OK: UploadValidation = { ok: true };
const reject = (reason: UploadRejectionReason): UploadValidation => ({ ok: false, reason });

/**
 * Thrown by the `assert*` wrappers. Routes translate it into a 422; the worker treats
 * it as a *permanent* failure, because re-running the same bytes through the same check
 * cannot produce a different answer.
 */
export class UploadValidationError extends Error {
  readonly reason: UploadRejectionReason;

  constructor(reason: UploadRejectionReason) {
    super(`upload rejected: ${reason}`);
    this.name = 'UploadValidationError';
    this.reason = reason;
  }
}

export function isUploadValidationError(value: unknown): value is UploadValidationError {
  return value instanceof UploadValidationError;
}

/* ----------------------------------------------------- declared  metadata -- */

/** What the client claims about a file it has not uploaded yet. */
export interface DeclaredUpload {
  readonly content_type: string;
  readonly file_name: string;
  readonly size_bytes: number;
}

/**
 * Validates the claim, not the file.
 *
 * `UploadUrlSchema` already enforces all three at the contract boundary, so in the
 * route this is a second, independent pass. That duplication is intentional and cheap:
 * the schema can be relaxed by a future edit in another lane's file, and this check is
 * the one the tests in `tests/documents` pin. Checking twice costs microseconds;
 * checking once and being wrong costs the upload gate.
 */
export function validateDeclaredUpload(declared: DeclaredUpload): UploadValidation {
  const mime = declared.content_type.trim().toLowerCase().split(';')[0] ?? '';
  if (!(ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime)) {
    return reject('mime_type_not_allowed');
  }

  const name = declared.file_name.trim().toLowerCase();
  const allowed = (ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).some((extension) =>
    name.endsWith(extension),
  );
  if (!allowed) return reject('extension_not_allowed');

  if (!Number.isFinite(declared.size_bytes) || declared.size_bytes <= 0) {
    return reject('declared_size_not_positive');
  }
  if (declared.size_bytes > MAX_UPLOAD_BYTES) return reject('declared_size_exceeds_cap');

  return OK;
}

/** `validateDeclaredUpload`, as an assertion. */
export function assertDeclaredUpload(declared: DeclaredUpload): void {
  const result = validateDeclaredUpload(declared);
  if (!result.ok) throw new UploadValidationError(result.reason);
}

/* ---------------------------------------------------------------- the file -- */

/**
 * Validates the actual bytes: size against the frozen 10 MB cap, and the PDF signature.
 *
 * The size check is repeated here even though `validateDeclaredUpload` already ran,
 * because the declared size was a number in a JSON body and this one is `bytes.length`.
 * Storage enforces the cap too (`file_size_limit` on the bucket), which is the third
 * layer; this is the one that runs before a single byte reaches `pdf-parse`.
 */
export function validatePdfBytes(bytes: Uint8Array): UploadValidation {
  if (bytes.length > MAX_UPLOAD_BYTES) return reject('byte_size_exceeds_cap');
  if (bytes.length < MIN_PDF_BYTES) return reject('byte_size_below_minimum');
  if (!hasPdfMagicBytes(bytes)) return reject('magic_bytes_not_pdf');
  return OK;
}

/** `validatePdfBytes`, as an assertion. */
export function assertPdfBytes(bytes: Uint8Array): void {
  const result = validatePdfBytes(bytes);
  if (!result.ok) throw new UploadValidationError(result.reason);
}

/**
 * A stricter, advisory check: signature **and** trailer.
 *
 * Not used as a gate. A PDF that has been linearised, incrementally updated or
 * truncated by a flaky upload may lack a readable `%%EOF` in the last kilobyte and
 * still extract perfectly, so rejecting on it would fail valid documents. It exists so
 * the worker can record `trailer_missing` as a confidence note for the human verifier.
 */
export function looksLikePdf(bytes: Uint8Array): { signature: boolean; trailer: boolean } {
  const tailStart = Math.max(0, bytes.length - 2048);
  let tail = '';
  for (let index = tailStart; index < bytes.length; index += 1) {
    tail += String.fromCharCode(bytes[index] as number);
  }
  return { signature: hasPdfMagicBytes(bytes), trailer: tail.includes(PDF_TRAILER_MARKER) };
}
