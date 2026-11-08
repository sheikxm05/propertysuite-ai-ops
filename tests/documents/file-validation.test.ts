/**
 * Upload validation: the declared claim, and then the bytes.
 *
 * The test this file exists for is "a non-PDF with a faked `.pdf` extension is rejected
 * by the magic-byte check". It is worth being precise about why that matters rather than
 * only that it passes: `content_type` and `file_name` are both chosen by the caller, so
 * a ZIP archive declared as `application/pdf` and named `tenancy-contract.pdf` satisfies
 * every check `docs/security-checklist.md` lists by name. Only the first five bytes
 * disagree.
 */

import { describe, expect, it } from 'vitest';

import { ALLOWED_UPLOAD_MIME_TYPES, MAX_UPLOAD_BYTES } from '@shared/index';
import {
  MIN_PDF_BYTES,
  PDF_MAGIC_BYTES,
  PDF_MAGIC_SEARCH_WINDOW,
  UploadValidationError,
  assertDeclaredUpload,
  assertPdfBytes,
  findPdfMagicOffset,
  hasPdfMagicBytes,
  looksLikePdf,
  validateDeclaredUpload,
  validatePdfBytes,
} from '@/services/extraction';

import {
  buildFakePdfBytes,
  buildLatePdfSignatureBytes,
  buildTenancyContractPdf,
} from './_support/pdf-fixture';

const DECLARED = {
  content_type: 'application/pdf',
  file_name: 'tenancy-contract.pdf',
  size_bytes: 524_288,
};

describe('declared upload metadata', () => {
  it('accepts the frozen combination', () => {
    expect(validateDeclaredUpload(DECLARED)).toEqual({ ok: true });
  });

  it('is pinned to the frozen MIME list rather than a local copy', () => {
    // If §5.7's list ever widened, this test would widen with it instead of silently
    // disagreeing with the schema in packages/shared.
    expect(ALLOWED_UPLOAD_MIME_TYPES).toEqual(['application/pdf']);
  });

  it.each([
    ['application/zip', 'mime_type_not_allowed'],
    ['image/png', 'mime_type_not_allowed'],
    ['text/html', 'mime_type_not_allowed'],
    ['application/octet-stream', 'mime_type_not_allowed'],
  ])('rejects content type %s', (contentType, reason) => {
    expect(validateDeclaredUpload({ ...DECLARED, content_type: contentType })).toEqual({
      ok: false,
      reason,
    });
  });

  it('tolerates a charset parameter on the declared type', () => {
    // Browsers and HTTP clients append parameters; the media type is what matters.
    expect(
      validateDeclaredUpload({ ...DECLARED, content_type: 'application/pdf; charset=binary' }),
    ).toEqual({ ok: true });
  });

  it.each(['contract.docx', 'contract.pdf.exe', 'contract', 'contract.PDFX'])(
    'rejects file name %s',
    (fileName) => {
      expect(validateDeclaredUpload({ ...DECLARED, file_name: fileName })).toEqual({
        ok: false,
        reason: 'extension_not_allowed',
      });
    },
  );

  it('accepts an uppercase extension', () => {
    expect(validateDeclaredUpload({ ...DECLARED, file_name: 'CONTRACT.PDF' })).toEqual({
      ok: true,
    });
  });

  it('rejects a declared size above the frozen 10 MB cap', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(validateDeclaredUpload({ ...DECLARED, size_bytes: MAX_UPLOAD_BYTES + 1 })).toEqual({
      ok: false,
      reason: 'declared_size_exceeds_cap',
    });
    expect(validateDeclaredUpload({ ...DECLARED, size_bytes: MAX_UPLOAD_BYTES })).toEqual({
      ok: true,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a declared size of %s',
    (size) => {
      expect(validateDeclaredUpload({ ...DECLARED, size_bytes: size })).toEqual({
        ok: false,
        reason: 'declared_size_not_positive',
      });
    },
  );

  it('throws a typed error from the assertion form', () => {
    expect(() => assertDeclaredUpload({ ...DECLARED, content_type: 'application/zip' })).toThrow(
      UploadValidationError,
    );
    try {
      assertDeclaredUpload({ ...DECLARED, content_type: 'application/zip' });
      expect.unreachable('should have thrown');
    } catch (thrown) {
      expect((thrown as UploadValidationError).reason).toBe('mime_type_not_allowed');
      // The message carries the stable token and nothing about the file.
      expect((thrown as Error).message).toBe('upload rejected: mime_type_not_allowed');
    }
  });
});

describe('magic bytes', () => {
  it('accepts a real PDF', () => {
    const pdf = buildTenancyContractPdf();
    expect(hasPdfMagicBytes(pdf)).toBe(true);
    expect(findPdfMagicOffset(pdf)).toBe(0);
    expect(validatePdfBytes(pdf)).toEqual({ ok: true });
  });

  it('REJECTS A ZIP ARCHIVE DECLARED AS A PDF AND NAMED .pdf', () => {
    const fake = buildFakePdfBytes();

    // Every caller-supplied signal says PDF…
    expect(
      validateDeclaredUpload({
        content_type: 'application/pdf',
        file_name: 'tenancy-contract.pdf',
        size_bytes: fake.length,
      }),
    ).toEqual({ ok: true });

    // …and the bytes say otherwise. This is the only check that can tell.
    expect(hasPdfMagicBytes(fake)).toBe(false);
    expect(validatePdfBytes(fake)).toEqual({ ok: false, reason: 'magic_bytes_not_pdf' });
    expect(() => assertPdfBytes(fake)).toThrow(UploadValidationError);
  });

  it.each([
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['GIF', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ['ELF executable', [0x7f, 0x45, 0x4c, 0x46]],
    ['HTML', [0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45]],
  ])('rejects %s bytes', (_label, signature) => {
    const bytes = new Uint8Array(MIN_PDF_BYTES + signature.length);
    bytes.set(signature, 0);
    expect(validatePdfBytes(bytes)).toEqual({ ok: false, reason: 'magic_bytes_not_pdf' });
  });

  it('finds a signature offset by a byte-order mark, as real producers emit', () => {
    const bom = [0xef, 0xbb, 0xbf];
    const pdf = buildTenancyContractPdf();
    const shifted = new Uint8Array(bom.length + pdf.length);
    shifted.set(bom, 0);
    shifted.set(pdf, bom.length);

    expect(findPdfMagicOffset(shifted)).toBe(bom.length);
    expect(validatePdfBytes(shifted)).toEqual({ ok: true });
  });

  it('does not search past the window, so prepended junk cannot smuggle a PDF in', () => {
    const late = buildLatePdfSignatureBytes();
    expect(late.length).toBeGreaterThan(PDF_MAGIC_SEARCH_WINDOW);
    expect(hasPdfMagicBytes(late)).toBe(false);
    expect(validatePdfBytes(late)).toEqual({ ok: false, reason: 'magic_bytes_not_pdf' });
  });

  it('compares bytes rather than decoded text', () => {
    // UTF-16LE "%PDF-" decodes to the right string under the wrong encoding and is not
    // a PDF. A string-based check would accept it.
    const utf16 = new Uint8Array(MIN_PDF_BYTES * 2);
    const ascii = PDF_MAGIC_BYTES;
    ascii.forEach((byte, index) => {
      utf16[index * 2] = byte;
      utf16[index * 2 + 1] = 0x00;
    });
    expect(hasPdfMagicBytes(utf16)).toBe(false);
  });

  it('rejects a file below the minimum plausible size', () => {
    const tiny = new Uint8Array(PDF_MAGIC_BYTES);
    expect(validatePdfBytes(tiny)).toEqual({ ok: false, reason: 'byte_size_below_minimum' });
  });

  it('rejects bytes above the cap, even when they are a valid PDF', () => {
    const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    oversized.set(PDF_MAGIC_BYTES, 0);
    expect(validatePdfBytes(oversized)).toEqual({ ok: false, reason: 'byte_size_exceeds_cap' });
  });

  it('reports a missing trailer as advisory rather than as a rejection', () => {
    const truncated = buildTenancyContractPdf().slice(0, 600);
    expect(looksLikePdf(truncated)).toEqual({ signature: true, trailer: false });
    // Advisory: a truncated or incrementally updated PDF often extracts fine, so this
    // becomes a confidence note for the reviewer, never a 422.
    expect(validatePdfBytes(truncated)).toEqual({ ok: true });
  });

  it('confirms a whole PDF has both a signature and a trailer', () => {
    expect(looksLikePdf(buildTenancyContractPdf())).toEqual({ signature: true, trailer: true });
  });
});
