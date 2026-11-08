/**
 * Untrusted-content fencing — the adapter's only input path.
 *
 * Every byte of tenant message text and document text that reaches a model goes through
 * this module, is wrapped in a nonce-tagged envelope, and is placed in the **user** role.
 * Nothing from a caller ever reaches the system role: the public adapter interface
 * (`services/ai/providers/types.ts`) has no system-prompt parameter, so there is no
 * argument through which a caller could supply one. That is a structural property, not a
 * convention — a reviewer can confirm it by reading one interface.
 *
 * Why a per-request nonce rather than a fixed delimiter:
 *
 *   A fixed delimiter is guessable, so hostile text can simply close the fence and start
 *   writing what looks like trusted framing. The nonce is generated per request from a
 *   CSPRNG and is not in the attacker's input, so a closing marker cannot be forged. As
 *   belt and braces, `sanitise` also strips any marker-shaped substring from the content
 *   before it is wrapped, so even a leaked nonce cannot be used to break out.
 *
 * What this module deliberately does NOT do: it does not try to detect or neutralise
 * prompt injection semantically. There is no reliable filter for "ignore previous
 * instructions". The defence is architectural instead, in three independent layers:
 *
 *   1. The hostile text is unambiguously labelled as data (this module).
 *   2. The system instruction says that content inside the fence is data and that any
 *      instruction found within it is to be ignored (`services/ai/prompts/*`).
 *   3. Even a fully compliant hostile reply cannot do anything: the output schema has no
 *      field for a provider, a status or a cost; `resolvePriority()` caps a model
 *      suggestion below `urgent`; and no mutation happens without an authenticated human
 *      confirmation. A successful injection changes the wording of a draft.
 *
 * Nothing here logs. The content it handles is exactly the content CLAUDE.md rule 8
 * forbids logging.
 */

import { randomUUID } from 'node:crypto';

/** Bumped when the envelope format changes, so a prompt/format pair stays traceable. */
export const FENCE_FORMAT_VERSION = 'fence-v1';

/** Marker words. Public so the prompt module and the tests use the same literals. */
export const FENCE_BEGIN = 'UNTRUSTED-DATA-BEGIN';
export const FENCE_END = 'UNTRUSTED-DATA-END';

/**
 * Longest untrusted section retained, in characters.
 *
 * `AiMessageContentSchema` already bounds a tenant message at 4000, but document text
 * arrives from `pdf-parse` and is effectively unbounded, so the adapter enforces its own
 * ceiling. Truncation is reported in the envelope rather than hidden: a classification
 * drawn from a clipped document should say so.
 */
export const MAX_SECTION_CHARS = 8000;

/**
 * C0 and C1 control characters, excluding tab (09), newline (0A) and carriage return
 * (0D). A lone `BEL` or an ANSI escape sequence is never meaningful maintenance text and
 * is a cheap way to confuse a downstream reader of the stored transcript.
 */
const CONTROL_CHARACTERS = new RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]', 'g');

/** Labels a caller may fence. A closed set, so a label cannot itself be injected text. */
export const UNTRUSTED_LABELS = [
  'tenant_message',
  'document_text',
  'previous_invalid_model_output',
] as const;

export type UntrustedLabel = (typeof UNTRUSTED_LABELS)[number];

export interface UntrustedSection {
  readonly label: UntrustedLabel;
  readonly content: string;
}

export interface FencedPayload {
  /** The user-role text to send. Contains the envelope and nothing else. */
  readonly text: string;
  /** The per-request nonce. Logged as an opaque id; never derived from input. */
  readonly nonce: string;
  /** Per-section diagnostics, safe to log: lengths and booleans only. */
  readonly sections: readonly FencedSectionInfo[];
}

export interface FencedSectionInfo {
  readonly label: UntrustedLabel;
  readonly chars: number;
  readonly truncated: boolean;
  /** How many marker-shaped substrings were neutralised. A non-zero value is notable. */
  readonly neutralisedMarkers: number;
}

/**
 * A fresh fence nonce.
 *
 * `randomUUID` rather than a counter or a timestamp: the whole point is that the value
 * is not predictable from anything the caller can see or influence.
 */
export function newFenceNonce(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

/**
 * Wraps untrusted sections into the fenced envelope.
 *
 * The result is one string, destined for a single user-role message. The caller cannot
 * interleave trusted framing between sections, because the whole envelope is built here
 * in one pass from a closed set of labels.
 */
export function fenceUntrusted(
  sections: readonly UntrustedSection[],
  nonce: string = newFenceNonce(),
): FencedPayload {
  const info: FencedSectionInfo[] = [];
  const blocks: string[] = [];

  for (const section of sections) {
    const cleaned = sanitise(section.content, nonce);
    info.push({
      label: section.label,
      chars: cleaned.text.length,
      truncated: cleaned.truncated,
      neutralisedMarkers: cleaned.neutralisedMarkers,
    });

    blocks.push(
      [
        `[${FENCE_BEGIN} ${nonce}]`,
        `name: ${section.label}`,
        cleaned.truncated ? 'note: truncated by the application, not by the author' : null,
        '--',
        cleaned.text,
        `[${FENCE_END} ${nonce}]`,
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  }

  return { text: blocks.join('\n\n'), nonce, sections: info };
}

interface SanitisedSection {
  text: string;
  truncated: boolean;
  neutralisedMarkers: number;
}

/**
 * Makes one untrusted section safe to embed.
 *
 * Four transformations, in order, each with a reason:
 *
 *  1. Replace control characters (see `CONTROL_CHARACTERS`) with a space.
 *  2. Neutralise marker-shaped substrings — `UNTRUSTED-DATA-BEGIN`, `UNTRUSTED-DATA-END`
 *     and the nonce itself — by splicing a visible `(neutralised)` token into them. The
 *     content stays readable to the model as text; it can no longer close the envelope.
 *  3. Truncate to `MAX_SECTION_CHARS`, reported in the envelope.
 *  4. Trim. Leading whitespace is not information here.
 *
 * Note what is *not* done: no keyword filtering, no "ignore previous instructions"
 * detection, no rewriting of the author's words. A filter like that gives false
 * confidence and mangles legitimate messages ("the previous plumber told me to ignore
 * the noise"). The envelope and the system instruction carry the defence instead.
 */
function sanitise(raw: string, nonce: string): SanitisedSection {
  let neutralisedMarkers = 0;

  const neutralise = (text: string, needle: string): string => {
    if (needle.length < 2) return text;
    const parts = text.split(needle);
    if (parts.length === 1) return text;
    neutralisedMarkers += parts.length - 1;
    return parts.join(`${needle.slice(0, 2)}(neutralised)${needle.slice(2)}`);
  };

  let text = String(raw ?? '').replace(CONTROL_CHARACTERS, ' ');
  text = neutralise(text, FENCE_BEGIN);
  text = neutralise(text, FENCE_END);
  text = neutralise(text, nonce);

  const truncated = text.length > MAX_SECTION_CHARS;
  if (truncated) text = text.slice(0, MAX_SECTION_CHARS);

  return { text: text.trim(), truncated, neutralisedMarkers };
}

/**
 * How many intact begin/end markers for `nonce` the text contains.
 *
 * Used by the unit tests as the direct statement of the property this module exists to
 * guarantee: after fencing one section, exactly one begin and one end marker exist, and
 * both are the ones the application wrote.
 */
export function countFenceMarkers(text: string, nonce: string): { begin: number; end: number } {
  const count = (needle: string) => text.split(needle).length - 1;
  return {
    begin: count(`[${FENCE_BEGIN} ${nonce}]`),
    end: count(`[${FENCE_END} ${nonce}]`),
  };
}
