/**
 * The maintenance-classification fixture set. Lane w1-l5.
 *
 * A thin binding over `evals/_support/recordings.ts`, which owns the loader, the staleness
 * fields and the transport. See that file for what the double replaces (the network, and
 * nothing else) and for the honest status of the fixtures (synthesised, not recorded).
 */

import {
  loadRecordings,
  type RecordedCase,
  type RecordedTransport,
  type RecordingFile,
} from '../_support/recordings';

export type {
  RecordedCase,
  RecordedReply,
  RecordedTransport,
  RecordingFile,
} from '../_support/recordings';

const SET = loadRecordings('evals', 'maintenance', 'fixtures', 'recordings.json');

/** The fixture file, parsed once. */
export function recordings(): RecordingFile {
  return SET.file;
}

/** One case, or a thrown error naming it — a typo in a case id must not silently pass. */
export function recordedCase(id: string): RecordedCase {
  return SET.caseFor(id);
}

/** A transport replaying one case's replies in order. */
export function recordedTransport(id: string): RecordedTransport {
  return SET.transportFor(id);
}
