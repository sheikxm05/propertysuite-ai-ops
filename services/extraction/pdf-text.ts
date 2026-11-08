/**
 * PDF text extraction, via `pdf-parse`.
 *
 * `next.config.ts` lists `pdf-parse` in `serverExternalPackages`, so it is never
 * bundled; it is required at runtime on the server only. Nothing in this file may be
 * imported by a client component.
 *
 * ---------------------------------------------------------------------------
 * THE BYTE-OFFSET TRAP — read before changing `toZeroOffsetBytes`.
 * ---------------------------------------------------------------------------
 * `pdf-parse@1.1.4` bundles pdf.js 1.9/1.10 and hands whatever you give it straight to
 * `getDocument({ data })`. Node's `Buffer` is a `Uint8Array`, so it passes every type
 * check on the way in — and then fails to parse with `FormatError: bad XRef entry`,
 * because a small `Buffer` is a *view* into Node's shared allocation pool with a
 * non-zero `byteOffset`, and pdf.js's stream reads through `.buffer` without applying
 * it. Every byte offset in the cross-reference table is then wrong by the pool offset.
 *
 * Verified in this repository: a byte-identical, spec-correct PDF fails as a
 * `Buffer.from(...)` and succeeds as a copied `Uint8Array`. The failure is silent,
 * data-dependent (a `Buffer` that happens to land at offset 0 works) and looks exactly
 * like a corrupt upload, so it would have been debugged as "the user's file is broken".
 *
 * `toZeroOffsetBytes` therefore copies into a fresh, zero-offset `Uint8Array` before
 * the parser sees anything. `extractPdfText` is the only entry point, so there is no
 * path that skips it.
 * ---------------------------------------------------------------------------
 *
 * Document text is hostile input and is also the most sensitive string in the system.
 * It is never logged, never interpolated into an error message, and never returned in a
 * list or detail payload (`DocumentSchema` has no `extracted_text` field, by design).
 */

import { MAX_STORED_TEXT_CHARS, normaliseDocumentText, truncateForStorage } from './sanitise-text';

/* ------------------------------------------------------------------ types -- */

/** The shape `pdf-parse` returns. Structural, so a stub in a test is a real stand-in. */
export interface PdfParseResult {
  readonly numpages: number;
  readonly text: string;
  readonly info?: unknown;
}

/** `pdf-parse`'s call signature, narrowed to what this module uses. */
export type PdfParseFn = (data: Uint8Array) => Promise<PdfParseResult>;

export interface ExtractedPdfText {
  /** Sanitised, normalised, length-capped. Safe to store; still untrusted as *content*. */
  readonly text: string;
  readonly pageCount: number;
  /** True when the document was longer than `MAX_STORED_TEXT_CHARS`. */
  readonly truncated: boolean;
  /** Characters retained. Safe to log — a count is not content. */
  readonly characterCount: number;
}

/** Stable failure tokens. Safe to log and to store in `jobs.last_error`. */
export type PdfTextFailureReason =
  'pdf_parse_threw' | 'pdf_parse_returned_no_text' | 'pdf_parse_unavailable';

export class PdfTextExtractionError extends Error {
  readonly reason: PdfTextFailureReason;

  constructor(reason: PdfTextFailureReason, options?: { cause?: unknown }) {
    super(`pdf text extraction failed: ${reason}`, options?.cause ? { cause: options.cause } : {});
    this.name = 'PdfTextExtractionError';
    this.reason = reason;
  }
}

export function isPdfTextExtractionError(value: unknown): value is PdfTextExtractionError {
  return value instanceof PdfTextExtractionError;
}

/* ------------------------------------------------------------------ bytes -- */

/**
 * Copies `input` into a fresh `Uint8Array` whose `byteOffset` is 0.
 *
 * See the byte-offset trap above. The copy is unconditional: branching on
 * `byteOffset === 0` would make the correct path the rare one and leave the bug live
 * for every pooled buffer, which is most of them.
 */
export function toZeroOffsetBytes(input: Uint8Array | ArrayBuffer): Uint8Array {
  const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

/* ------------------------------------------------------------- extraction -- */

export interface ExtractPdfTextDeps {
  /** Injected so tests can drive the failure paths without a PDF corpus. */
  readonly parse?: PdfParseFn;
  /** Override the storage cap. Tests use a small value; production never sets it. */
  readonly maxChars?: number;
}

/**
 * Extracts the text body of a PDF.
 *
 * The caller must already have run `assertPdfBytes` — this function does not re-sniff
 * the signature, because a module that both validates and parses invites a future edit
 * that keeps the parse and drops the validation.
 */
export async function extractPdfText(
  bytes: Uint8Array | ArrayBuffer,
  deps: ExtractPdfTextDeps = {},
): Promise<ExtractedPdfText> {
  const parse = deps.parse ?? (await loadPdfParse());
  const maxChars = deps.maxChars ?? MAX_STORED_TEXT_CHARS;

  let result: PdfParseResult;
  try {
    result = await parse(toZeroOffsetBytes(bytes));
  } catch (cause) {
    // The cause is attached but never rendered: pdf.js error messages can quote bytes
    // from the document being parsed (CLAUDE.md rule 8).
    throw new PdfTextExtractionError('pdf_parse_threw', { cause });
  }

  const normalised = normaliseDocumentText(result.text ?? '');
  if (normalised.length === 0) {
    // A PDF of scanned images parses fine and yields nothing. That is not a crash, but
    // it is not an extraction either, and the job must not record an empty success.
    throw new PdfTextExtractionError('pdf_parse_returned_no_text');
  }

  const { text, truncated } = truncateForStorage(normalised, maxChars);
  return {
    text,
    pageCount: Number.isFinite(result.numpages) ? result.numpages : 0,
    truncated,
    characterCount: text.length,
  };
}

/**
 * Loads `pdf-parse` lazily.
 *
 * Deferred rather than imported at module scope so that importing anything else from
 * `services/extraction` — the fence, the validator, the envelope — does not drag a
 * CommonJS PDF parser and its bundled pdf.js into the module graph. The route handlers
 * import this package for its validation helpers far more often than they parse a PDF.
 */
async function loadPdfParse(): Promise<PdfParseFn> {
  try {
    const mod: unknown = await import('pdf-parse');
    // `pdf-parse` is CommonJS (`export = PdfParse`). Under `esModuleInterop` the
    // callable arrives on `default`; under a raw CJS require it is the namespace
    // itself. Accept both rather than depending on which bundler is in play.
    const candidate =
      typeof mod === 'function'
        ? mod
        : typeof (mod as { default?: unknown }).default === 'function'
          ? (mod as { default: unknown }).default
          : null;

    if (typeof candidate !== 'function') throw new Error('pdf-parse export is not callable');
    return candidate as PdfParseFn;
  } catch (cause) {
    throw new PdfTextExtractionError('pdf_parse_unavailable', { cause });
  }
}
