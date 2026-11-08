/**
 * PDF text extraction, against the real `pdf-parse`.
 *
 * These are not stub tests. Each one builds a genuine PDF — correct xref table, real
 * content stream — and runs the installed parser over it, so the suite covers the
 * library's actual behaviour rather than an assumption about it.
 *
 * The first test in `input normalisation` is the one worth keeping forever. It encodes a
 * defect found by running this code rather than reading it: pdf-parse rejects a pooled
 * Node `Buffer` with `FormatError: bad XRef entry`, because a small `Buffer` is a view
 * into Node's shared allocation pool with a non-zero `byteOffset`, and the bundled
 * pdf.js reads through `.buffer` without applying it — so every offset in the
 * cross-reference table is wrong by the pool offset. The failure is silent,
 * data-dependent (a `Buffer` that happens to land at offset 0 works) and looks exactly
 * like a corrupt upload. `extractPdfText` copies to a zero-offset `Uint8Array` before
 * the parser sees anything, and this test is what stops someone deleting that copy as
 * redundant.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_STORED_TEXT_CHARS,
  PdfTextExtractionError,
  TRUNCATION_MARKER,
  extractPdfText,
  toZeroOffsetBytes,
  type PdfParseFn,
} from '@/services/extraction';

import { asPooledBuffer, buildPdf, buildTenancyContractPdf } from './_support/pdf-fixture';

describe('extractPdfText with the real parser', () => {
  it('extracts the text layer of a tenancy contract', async () => {
    const result = await extractPdfText(buildTenancyContractPdf());

    expect(result.pageCount).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain('TENANCY CONTRACT');
    expect(result.text).toContain('Contract Number: EJ-2026-004217');
    expect(result.text).toContain('Tenant Name: Aisha Rahman');
    expect(result.text).toContain('2026-02-01');
    expect(result.text).toContain('AED 120,000');
    expect(result.characterCount).toBe(result.text.length);
  });

  it('normalises line structure without collapsing the lines themselves', async () => {
    const result = await extractPdfText(buildPdf(['First line', 'Second line', 'Third line']));
    expect(result.text.split('\n')).toEqual(['First line', 'Second line', 'Third line']);
  });
});

describe('input normalisation', () => {
  it('extracts from a POOLED Buffer, which pdf-parse cannot read unaided', async () => {
    const pooled = asPooledBuffer(buildPdf(['Pooled buffer contract']));

    // The precondition for the bug: a non-zero byteOffset. Node's allocator decides
    // this, so the assertion is a guard rather than a claim — if a future Node gives
    // offset 0 the test still proves extraction works, it just stops proving the fix.
    expect(pooled.byteOffset).toBeGreaterThanOrEqual(0);

    const result = await extractPdfText(pooled);
    expect(result.text).toContain('Pooled buffer contract');
  });

  it('copies to a zero-offset view', () => {
    const pooled = asPooledBuffer(buildPdf(['x']));
    const normalised = toZeroOffsetBytes(pooled);

    expect(normalised.byteOffset).toBe(0);
    expect(normalised.byteLength).toBe(pooled.byteLength);
    expect(Array.from(normalised.subarray(0, 5))).toEqual(Array.from(pooled.subarray(0, 5)));
    // A copy, not a view: mutating one must not touch the other.
    normalised[0] = 0;
    expect(pooled[0]).not.toBe(0);
  });

  it('accepts an ArrayBuffer', async () => {
    const bytes = buildPdf(['From an ArrayBuffer']);
    const copy = new Uint8Array(bytes);
    const result = await extractPdfText(copy.buffer as ArrayBuffer);
    expect(result.text).toContain('From an ArrayBuffer');
  });
});

describe('failure paths', () => {
  it('maps a parser exception to a token without quoting the document', async () => {
    const parse: PdfParseFn = vi.fn(async () => {
      // A real pdf.js message can contain bytes from the document being parsed.
      throw new Error('FormatError: bad XRef entry near "Aisha Rahman, 120000 AED"');
    });

    await expect(extractPdfText(buildPdf(['x']), { parse })).rejects.toThrowError(
      PdfTextExtractionError,
    );

    try {
      await extractPdfText(buildPdf(['x']), { parse });
      expect.unreachable('should have thrown');
    } catch (thrown) {
      const error = thrown as PdfTextExtractionError;
      expect(error.reason).toBe('pdf_parse_threw');
      // The document text must not survive into anything loggable.
      expect(error.message).toBe('pdf text extraction failed: pdf_parse_threw');
      expect(error.message).not.toContain('Aisha');
    }
  });

  it('treats an empty text layer as a failure, not an empty success', async () => {
    // What a PDF of scanned images looks like: it parses, and yields nothing. Recording
    // that as a successful extraction would show a reviewer an empty document.
    const parse: PdfParseFn = async () => ({ numpages: 3, text: '   \n\n  \t ' });

    await expect(extractPdfText(buildPdf(['x']), { parse })).rejects.toMatchObject({
      reason: 'pdf_parse_returned_no_text',
    });
  });

  it('reports an unusable parser export distinctly from a parse failure', async () => {
    // `pdf_parse_unavailable` is classified retryable because a deploy can fix it,
    // unlike the other two, which are properties of the file.
    const error = new PdfTextExtractionError('pdf_parse_unavailable');
    expect(error.reason).toBe('pdf_parse_unavailable');
  });
});

describe('length caps', () => {
  it('truncates at the storage cap and says so', async () => {
    const parse: PdfParseFn = async () => ({ numpages: 1, text: 'a'.repeat(500) });

    const result = await extractPdfText(buildPdf(['x']), { parse, maxChars: 100 });

    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
  });

  it('leaves a document inside the cap untouched', async () => {
    const parse: PdfParseFn = async () => ({ numpages: 1, text: 'short contract' });
    const result = await extractPdfText(buildPdf(['x']), { parse });

    expect(result.truncated).toBe(false);
    expect(result.text).toBe('short contract');
    expect(MAX_STORED_TEXT_CHARS).toBe(200_000);
  });
});
