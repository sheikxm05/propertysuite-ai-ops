/**
 * The port through which this lane reaches a language model — and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY A PORT AND NOT A DIRECT CALL — see the planning defect in this lane's report.
 * ---------------------------------------------------------------------------
 * `docs/parallel-execution-plan.md` §5 freezes the shared schema surface (§5.4), the
 * handler contract (§5.2), the route prefixes (§5.5) and the storage values (§5.7). It
 * does **not** freeze any interface under `services/ai/**`. W1-L5's briefing describes
 * one method — `classify()` for maintenance intake — and no document extraction entry
 * point of any kind. `services/ai/**` is also another lane's path, so this lane may not
 * create one there, and the directory did not exist while this lane was written.
 *
 * So there is nothing to code against. The options were to guess a module path and
 * import it (a compile error for whoever guessed differently), to write the adapter
 * inside `services/ai` (a direct ownership violation), or to define the dependency as a
 * port and let the orchestrator bind it in one place. This file is the third.
 *
 * The binding is a single `registerDocumentFieldExtractor(...)` call. Until it happens,
 * the behaviour is specified and safe rather than undefined: text extraction still runs
 * and still persists, the document stays at `verification_status: 'pending'`, and the
 * envelope records `field_extraction_unavailable` as a confidence note the human
 * verifier can see. Nothing is silently skipped and nothing is silently believed.
 * ---------------------------------------------------------------------------
 *
 * Note the return type: `unknown`. An extractor is an untrusted collaborator in exactly
 * the same way the document is. Whatever it returns is parsed against
 * `DocumentExtractionSchema` by `extract-fields.ts` before any of it is believed, so a
 * provider that returns a well-shaped lie gets no further than a provider that returns
 * nonsense.
 */

import type { ExtractionPrompt } from './prompt';

/** What an extractor is handed. Everything it needs; nothing it does not. */
export interface FieldExtractionRequest {
  readonly prompt: ExtractionPrompt;
  /** Abort signal from the job runner, so a hung provider cannot hold a claim open. */
  readonly signal?: AbortSignal;
}

/**
 * An implementation of structured field extraction.
 *
 * `id` is recorded on the envelope and in the log so an extraction can be attributed to
 * the provider that produced it. It must not contain a key, a URL or a model secret.
 */
export interface DocumentFieldExtractor {
  readonly id: string;
  /** Returns the provider's raw reply. **Validated by the caller, never trusted here.** */
  extract(request: FieldExtractionRequest): Promise<unknown>;
}

/* --------------------------------------------------------------- registry -- */

let registered: DocumentFieldExtractor | null = null;

/**
 * Binds the extractor.
 *
 * Intended to be called once, from server start-up or from the lane that owns the AI
 * adapter. Re-registering replaces the previous binding — tests rely on that, and a
 * process that registers twice in production has a wiring bug worth surfacing loudly
 * rather than a conflict worth throwing on.
 */
export function registerDocumentFieldExtractor(extractor: DocumentFieldExtractor): void {
  registered = extractor;
}

/** The bound extractor, or `null` when none has been registered. */
export function getDocumentFieldExtractor(): DocumentFieldExtractor | null {
  return registered;
}

/** Clears the binding. For tests, and for a clean shutdown. */
export function resetDocumentFieldExtractor(): void {
  registered = null;
}

/** Is structured field extraction available in this process? */
export function hasDocumentFieldExtractor(): boolean {
  return registered !== null;
}
