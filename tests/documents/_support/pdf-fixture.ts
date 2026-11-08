/**
 * A real PDF, built in memory, so the extraction tests exercise `pdf-parse` rather than
 * a stub of it.
 *
 * There is no PDF in this repository and none in `node_modules`, so the alternative was
 * to mock the parser — which would have tested the mock. A spec-minimal single-page PDF
 * is about forty lines, and building it here means the prompt-injection test can put
 * hostile text *inside a genuine PDF text stream* and watch the whole path from bytes to
 * fenced prompt.
 *
 * Writing one correctly has two traps, both found by doing it:
 *
 *  1. **The xref offsets must be byte offsets into the final file.** They are computed
 *     from the assembled body below rather than written by hand, so editing an object
 *     cannot silently invalidate the table.
 *  2. **`latin1`, not `utf8`.** A PDF content stream is bytes, and `/Length` counts
 *     bytes. Encoding the body as UTF-8 makes any non-ASCII character occupy more bytes
 *     than `/Length` claims and the parser walks off the end of the stream.
 *
 * `toParserInput` is the third trap and the one worth reading `services/extraction/
 * pdf-text.ts` about: pdf-parse rejects a pooled Node `Buffer` with
 * `FormatError: bad XRef entry`, because a small `Buffer` is a view into Node's
 * allocation pool with a non-zero `byteOffset` and the bundled pdf.js reads through
 * `.buffer` without applying it. Every byte offset in the xref table is then wrong by
 * the pool offset. The same bytes in a zero-offset `Uint8Array` parse perfectly.
 */

/** Escapes the three characters that are syntax inside a PDF string literal. */
function escapePdfString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A one-page PDF whose text layer is `lines`, one line per element.
 *
 * Returned as a zero-offset `Uint8Array`, which is what pdf-parse can actually read.
 */
export function buildPdf(lines: readonly string[]): Uint8Array {
  const content = `BT\n/F1 11 Tf\n14 TL\n50 760 Td\n${lines
    .map((line) => `(${escapePdfString(line)}) Tj T*`)
    .join('\n')}\nET`;

  const objects = [
    '<</Type /Catalog /Pages 2 0 R>>',
    '<</Type /Pages /Kids [3 0 R] /Count 1>>',
    '<</Type /Page /Parent 2 0 R /Resources <</Font <</F1 4 0 R>>>> /MediaBox [0 0 595 842] /Contents 5 0 R>>',
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
    `<</Length ${byteLength(content)}>>\nstream\n${content}\nendstream`,
  ];

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];

  objects.forEach((object, index) => {
    offsets.push(byteLength(header) + byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = byteLength(header) + byteLength(body);

  // Each entry is exactly 20 bytes: 10 digits, space, 5 digits, space, type, space, LF.
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;

  const trailer = `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;

  return toZeroOffset(header + body + xref + trailer);
}

/** A tenancy contract with plausible Dubai values. The happy-path fixture. */
export function buildTenancyContractPdf(
  overrides: {
    tenantName?: string;
    contractNumber?: string;
    address?: string;
    startDate?: string;
    endDate?: string;
    rent?: string;
    extraLines?: readonly string[];
  } = {},
): Uint8Array {
  return buildPdf([
    'TENANCY CONTRACT',
    `Contract Number: ${overrides.contractNumber ?? 'EJ-2026-004217'}`,
    `Tenant Name: ${overrides.tenantName ?? 'Aisha Rahman'}`,
    `Property: ${overrides.address ?? 'Unit 1204, Marina Heights, Dubai Marina, Dubai'}`,
    `Term Start: ${overrides.startDate ?? '2026-02-01'}`,
    `Term End: ${overrides.endDate ?? '2027-01-31'}`,
    `Annual Rent: AED ${overrides.rent ?? '120,000'}`,
    'Payment: four cheques',
    ...(overrides.extraLines ?? []),
  ]);
}

/**
 * Bytes that are emphatically not a PDF, with a convincing beginning.
 *
 * `PK` is the ZIP local-file-header signature — a `.docx`, an `.xlsx` and a JAR all
 * start this way — and the filename inside says `.pdf`. Declared `application/pdf`,
 * named `tenancy-contract.pdf`, and still not a PDF. This is the file the magic-byte
 * check exists for.
 */
export function buildFakePdfBytes(): Uint8Array {
  const zipHeader = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00];
  const filler = 'tenancy-contract.pdf'.repeat(8);
  const bytes = new Uint8Array(zipHeader.length + filler.length);
  bytes.set(zipHeader, 0);
  for (let index = 0; index < filler.length; index += 1) {
    bytes[zipHeader.length + index] = filler.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/** `%PDF-` buried past the 1 KiB search window: prepended junk must not pass. */
export function buildLatePdfSignatureBytes(): Uint8Array {
  const junk = 'A'.repeat(2048);
  return toZeroOffset(`${junk}%PDF-1.4\n%%EOF\n`);
}

/* ---------------------------------------------------------------- helpers -- */

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'latin1');
}

/**
 * `latin1` string to a zero-offset `Uint8Array`.
 *
 * `Buffer.from(...)` would be shorter and would reintroduce the byte-offset bug the
 * whole file warns about, so the copy is explicit.
 */
function toZeroOffset(value: string): Uint8Array {
  const bytes = new Uint8Array(byteLength(value));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

/**
 * The same bytes as a **pooled** `Buffer`, for the regression test that proves
 * `extractPdfText` normalises its input.
 *
 * `Buffer.from(arrayLike)` allocates from Node's shared pool for small sizes, so the
 * result usually has a non-zero `byteOffset` — which is exactly the input that breaks
 * pdf-parse. The test asserts extraction still succeeds.
 */
export function asPooledBuffer(bytes: Uint8Array): Buffer {
  // A fresh allocation first, so the pool offset is whatever Node chooses rather than
  // whatever a previous test left behind.
  return Buffer.from(Array.from(bytes));
}
