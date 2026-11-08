/**
 * The offline eval transport. Lane w1-l5.
 *
 * It replaces the network and nothing else. Every eval below therefore runs the real
 * adapter: the real frozen prompt, the real fence, the real JSON extraction, the real
 * `ClassificationSchema` validation, the real single retry, and the real deterministic
 * priority policy. The only thing faked is what came back over the wire.
 *
 * That boundary is the whole reason the eval set is worth running without a key. A double
 * placed at the `AiProvider` seam would make every eval a tautology; a double placed here
 * leaves the parts that have historically broken — extraction, strictness, the retry —
 * fully under test.
 *
 * WHAT THESE FIXTURES ARE NOT
 * They are synthesised, not recorded: see `fixtures/recordings.json`. The evals prove
 * that the application handles a given reply correctly. They prove nothing about how the
 * model actually replies. `live.eval.test.ts` is the only file that can make that claim,
 * and it is skipped unless a credential and an explicit opt-in are both present.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ModelCallReply, ModelCallRequest, ModelTransport } from '@/services/ai';

export interface RecordedReply {
  readonly text: string;
  readonly stop_reason?: string | null;
  readonly tokens_in?: number | null;
  readonly tokens_out?: number | null;
}

export interface RecordedCase {
  readonly description: string;
  /** The tenant message, when the case has one. Absent for reply-shape-only cases. */
  readonly message?: string;
  readonly replies: readonly RecordedReply[];
}

export interface RecordingFile {
  readonly provenance: 'recorded' | 'synthesised';
  readonly prompt_version: string;
  readonly prompt_fingerprint: string;
  readonly model: string;
  readonly cases: Readonly<Record<string, RecordedCase>>;
}

const FIXTURE_PATH = join(process.cwd(), 'evals', 'maintenance', 'fixtures', 'recordings.json');

let cache: RecordingFile | null = null;

/** The fixture file, parsed once. */
export function recordings(): RecordingFile {
  if (!cache) {
    cache = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RecordingFile;
  }
  return cache;
}

/** One case, or a thrown error naming it — a typo in a case id must not silently pass. */
export function recordedCase(id: string): RecordedCase {
  const found = recordings().cases[id];
  if (!found) {
    throw new Error(`No recorded case '${id}' in ${FIXTURE_PATH}`);
  }
  return found;
}

export interface RecordedTransport extends ModelTransport {
  /** Every request the adapter issued. The assertion surface for prompt isolation. */
  readonly requests: readonly ModelCallRequest[];
}

/**
 * Builds a transport that replays one case's replies in order.
 *
 * Running past the end throws: the adapter is specified to make at most two calls, and a
 * third would be a regression that must fail loudly rather than reuse the last reply.
 */
export function recordedTransport(id: string): RecordedTransport {
  const replies = recordedCase(id).replies;
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
        throw new Error(`recordedTransport('${id}'): no reply recorded for attempt ${index}`);
      }
      return {
        text: reply.text,
        model: recordings().model,
        stopReason: reply.stop_reason ?? 'end_turn',
        tokensIn: reply.tokens_in ?? null,
        tokensOut: reply.tokens_out ?? null,
      };
    },
  };
}
