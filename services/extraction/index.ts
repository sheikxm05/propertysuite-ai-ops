/**
 * `services/extraction` — document intelligence, lane w1-l6.
 *
 * Barrel for the route handlers, the worker and the tests, so that a reorganisation
 * inside this directory does not touch six call sites.
 *
 * Reading order, which is also the order bytes travel:
 *
 *   file-validation  MIME, extension, size, and the magic bytes that make the first
 *                    three advisory rather than authoritative
 *   sanitise-text    control characters, invisible characters, two length caps
 *   pdf-text         pdf-parse, and the byte-offset trap that silently corrupts it
 *   fence            document text as data, never as instructions
 *   prompt           the versioned contract from docs/ai-prompts/document-extraction.md
 *   ai-port          the seam to the AI adapter (see the planning defect in ai-port.ts)
 *   extract-fields   call, then validate against the frozen shared schema
 *   excerpts         the document line each proposed value came from
 *   envelope         the extracted_data layout, and the human-only verification block
 *
 * One invariant spans all nine: **nothing here can verify a document.** The only
 * function that writes a verification block requires a human actor's profile id, and
 * the only caller of it is `POST /api/v1/documents/{documentId}/verify`.
 *
 * `pdf-text` is deliberately *not* re-exported eagerly-loaded: it imports `pdf-parse`
 * lazily, so importing this barrel for a validation helper does not pull a PDF parser
 * into the module graph.
 */

export * from './file-validation';
export * from './sanitise-text';
export * from './pdf-text';
export * from './fence';
export * from './prompt';
export * from './ai-port';
export * from './extract-fields';
export * from './excerpts';
export * from './envelope';
