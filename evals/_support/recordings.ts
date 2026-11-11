/**
 * The shared offline-eval loader and transport. Lane w1-l5.
 *
 * Both eval suites — `evals/maintenance/` and `evals/documents/` — replay fixture replies
 * through the **real** adapter. One loader serves both, deliberately: an earlier draft had
 * a copy per suite, and a fixture loader that exists twice is a staleness gate that can be
 * enforced in one suite and quietly skipped in the other.
 *
 * The double sits at the `ModelTransport` seam and nowhere else, so every eval exercises
 * the real frozen prompt, the real fence, the real JSON extraction, the real schema
 * validation, the real single retry, and — for documents — the real
 * `requires_human_review` override. A double at the `AiProvider` seam would make each eval
 * a tautology: a fake returning what it was told to return.
 *
 * WHAT THESE FIXTURES ARE NOT
 * They are synthesised, not recorded: `ANTHROPIC_API_KEY` is blank in this checkout, so no
 * live model call has ever been made. Each fixture file declares its own `provenance`. The
 * evals prove that the application handles a given reply correctly; they prove nothing
 * about how the model actually replies. Only the `live.eval.test.ts` files can claim that,
 * and both are skipped without a credential and an explicit opt-in.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ModelCallReply, ModelCallRequest, ModelTransport } from '@/services/ai';

export interface RecordedReply {
  /** Raw reply text, exactly as a model would emit it — valid JSON or not. */
  readonly text: string;
  readonly stop_reason?: string | null;
  readonly tokens_in?: number | null;
  readonly tokens_out?: number | null;
}

export interface RecordedCase {
  readonly description: string;
  /** The tenant message or document text, when the case has one. */
  readonly message?: string;
  readonly replies: readonly RecordedReply[];
}

export interface RecordingFile {
  readonly provenance: 'recorded' | 'synthesised';
  readonly prompt_version: string;
  /** Pins the fixtures to the prompt they were written for. See `assertFreshAgainst`. */
  readonly prompt_fingerprint: string;
  readonly model: string;
  readonly cases: Readonly<Record<string, RecordedCase>>;
}

export interface RecordingSet {
  readonly path: string;
  readonly file: RecordingFile;
  /** One case, or a thrown error naming it — a typo must not silently pass. */
  caseFor(id: string): RecordedCase;
  /** Case ids that carry input text, so a suite can iterate the runnable ones. */
  runnableIds(): string[];
  /** A transport replaying one case's replies in order. */
  transportFor(id: string): RecordedTransport;
}

export interface RecordedTransport extends ModelTransport {
  /** Every request the adapter issued. The assertion surface for prompt isolation. */
  readonly requests: readonly ModelCallRequest[];
}

const cache = new Map<string, RecordingFile>();

/**
 * Loads a fixture file, once per path.
 *
 * `segments` are joined onto the repository root, which is `process.cwd()` under Vitest.
 * An absolute path is not accepted: a fixture outside the repository would make an eval
 * unreproducible.
 */
export function loadRecordings(...segments: readonly string[]): RecordingSet {
  const path = join(process.cwd(), ...segments);

  let file = cache.get(path);
  if (!file) {
    file = JSON.parse(readFileSync(path, 'utf8')) as RecordingFile;
    cache.set(path, file);
  }
  const loaded = file;

  const caseFor = (id: string): RecordedCase => {
    const found = loaded.cases[id];
    if (!found) throw new Error(`No recorded case '${id}' in ${path}`);
    return found;
  };

  return {
    path,
    file: loaded,
    caseFor,
    runnableIds: () =>
      Object.entries(loaded.cases)
        .filter(([, value]) => typeof value.message === 'string')
        .map(([id]) => id),
    transportFor: (id: string) => buildTransport(path, id, caseFor(id).replies, loaded.model),
  };
}

/**
 * Builds a transport that replays one case's replies in order.
 *
 * Running past the end throws: the adapter is specified to make at most two calls, and a
 * third would be a regression that must fail loudly rather than reuse the last reply.
 */
function buildTransport(
  path: string,
  id: string,
  replies: readonly RecordedReply[],
  model: string,
): RecordedTransport {
  const requests: ModelCallRequest[] = [];
  let index = 0;

  return {
    id: 'recorded',
    requests,
    async send(request: ModelCallRequest): Promise<ModelCallReply> {
      requests.push(request);
      const reply = replies[index];
      index += 1;
      if (!reply) {
        throw new Error(`recordedTransport('${id}' in ${path}): no reply for attempt ${index}`);
      }
      return {
        text: reply.text,
        model,
        stopReason: reply.stop_reason ?? 'end_turn',
        tokensIn: reply.tokens_in ?? null,
        tokensOut: reply.tokens_out ?? null,
      };
    },
  };
}
