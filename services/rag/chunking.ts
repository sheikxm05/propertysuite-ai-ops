/**
 * Turning a tenancy agreement into retrievable chunks.
 *
 * A chunk is not an arbitrary slice of a document. It is the unit a human will read in
 * a citation panel, directly under a sentence that claims the document says something.
 * That single fact decides every parameter below:
 *
 *  - **A chunk must be readable on its own.** "The amount shall be paid annually in
 *    advance" is a true sentence from the contract and a useless citation: it names no
 *    amount and no party. So the splitter never cuts mid-sentence, carries a ~15%
 *    overlap into the next chunk, and prefixes a chunk with the clause heading that
 *    governs it when the chunk does not already begin with one. Three cheap mechanisms,
 *    all aimed at the same failure.
 *  - **A chunk must be small enough to be specific.** Embed a whole page and the vector
 *    becomes an average of five unrelated clauses, which retrieves for everything and
 *    answers nothing. 800–1200 characters is roughly one clause plus its context.
 *  - **Boundaries must be stable.** `chunk_index` is part of how a citation is
 *    identified, so this function is pure and deterministic: the same text and the same
 *    options always produce the same chunks with the same indices. Re-embedding a
 *    document therefore renumbers nothing.
 *
 * The splitter works on a ladder of boundaries, strongest first: blank line
 * (paragraph), then line, then sentence, then word. It descends a rung only when the
 * unit it is holding is still too long for a chunk, so an ordinary paragraph is never
 * cut at all and a pathological 4000-character run is cut at a space rather than
 * through a word.
 *
 * NOTHING HERE LOGS. This module handles `documents.extracted_text` — the column
 * commented never-log — and has no logger, by construction (CLAUDE.md rule 8). It is
 * also the one module in `services/rag` with no server-only imports, so it can be
 * exercised anywhere.
 */

/* ------------------------------------------------------------------ types -- */

/** One stored chunk, before it is embedded. */
export interface DocumentChunk {
  /** Position in the document, from 0. Stable across re-runs; becomes `chunk_index`. */
  readonly index: number;
  /** The text that is embedded, stored and shown as a citation. */
  readonly content: string;
  /** Estimated tokens. Advisory — it feeds `document_chunks.token_count` and cost logs. */
  readonly tokenCount: number;
  /** Characters in `content`, including any heading prefix. */
  readonly charCount: number;
  /** The clause heading this chunk sits under, if one was found. Diagnostic. */
  readonly heading: string | null;
}

export interface ChunkTextOptions {
  /** Soft lower bound. A chunk below this absorbs the next unit even if that overruns. */
  readonly minChars?: number;
  /** Soft upper bound. A unit is only cut when it alone exceeds this. */
  readonly maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next one. */
  readonly overlapChars?: number;
  /** Hard cap on chunks per document. Bounds embedding cost for a pathological file. */
  readonly maxChunks?: number;
}

export interface ChunkTextResult {
  readonly chunks: readonly DocumentChunk[];
  /** True when `maxChunks` cut the document short. The caller should log the count. */
  readonly truncated: boolean;
  /** Characters of normalised source text the chunks were derived from. */
  readonly sourceChars: number;
  /** Sum of `tokenCount`. Used for the one cost figure this lane logs. */
  readonly totalTokens: number;
}

/* -------------------------------------------------------------- constants -- */

/**
 * Defaults, in characters rather than tokens.
 *
 * Tokens would be the honest unit, but counting them exactly needs the model's
 * tokeniser, which is a dependency, and the dependency list is frozen
 * (CLAUDE.md rule 3). For English contract prose the ratio is stable enough that
 * character bounds land where token bounds would: 1200 characters is roughly 300
 * tokens, comfortably inside any embedding model's input window.
 */
export const DEFAULT_MIN_CHUNK_CHARS = 800;
export const DEFAULT_MAX_CHUNK_CHARS = 1_200;

/** ~15% of the upper bound: enough to carry a subject across a boundary. */
export const DEFAULT_OVERLAP_CHARS = 180;

/**
 * At ~1000 characters a chunk, 800 chunks is ~800k characters — four times the
 * `MAX_STORED_TEXT_CHARS` cap the extraction lane applies. It is a backstop against a
 * crafted file, not a limit any real tenancy agreement approaches.
 */
export const DEFAULT_MAX_CHUNKS = 800;

/**
 * How far a chunk may overrun `maxChars` to avoid emitting a stub.
 *
 * Without this, a 200-character paragraph followed by a 1100-character one emits a
 * 200-character chunk — a citation with no context, which is the failure this whole
 * file exists to prevent. Absorbing is the lesser evil.
 */
const OVERRUN_ALLOWANCE = 320;

/** Longest heading carried as a prefix. A "heading" longer than this is a paragraph. */
const MAX_HEADING_CHARS = 110;

/** A trailing chunk with less new text than this is folded into its predecessor. */
const MIN_TRAILING_NEW_CHARS = 60;

/* ---------------------------------------------------------- normalisation -- */

/**
 * Code points removed before splitting, built from code points rather than written as
 * literals so this source file contains no invisible characters of its own.
 *
 * C0 and C1 controls except tab and newline; zero-width characters; bidirectional
 * overrides; the byte-order mark. All of them make a rendered string differ from its
 * bytes, which is how a document shows a human one rent figure and hands a model
 * another.
 */
const codePoint = (code: number): string => String.fromCodePoint(code);
const range = (from: number, to: number): string => codePoint(from) + '-' + codePoint(to);

const STRIPPED = new RegExp(
  '[' +
    range(0x00, 0x08) +
    codePoint(0x0b) +
    codePoint(0x0c) +
    range(0x0e, 0x1f) +
    range(0x7f, 0x9f) +
    range(0x200b, 0x200f) +
    range(0x202a, 0x202e) +
    range(0x2066, 0x2069) +
    codePoint(0xfeff) +
    ']',
  'gu',
);

/** Unicode spaces folded to U+0020 so run-collapsing can see them. */
const EXOTIC_SPACE = new RegExp(
  '[' +
    codePoint(0x00a0) +
    codePoint(0x1680) +
    range(0x2000, 0x200a) +
    codePoint(0x2028) +
    codePoint(0x2029) +
    codePoint(0x202f) +
    codePoint(0x205f) +
    codePoint(0x3000) +
    ']',
  'gu',
);

/**
 * Normalises text before splitting.
 *
 * `documents.extracted_text` has already been through the extraction lane's
 * `sanitiseExtractedText`, so this is a second pass, not the first. It is kept because
 * this function is also reachable with text from anywhere, and because the splitter's
 * boundary regexes assume `\n` line endings and single spaces — a stray `\r` would
 * otherwise produce chunks with invisible structure and unstable boundaries.
 */
export function normaliseForChunking(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(STRIPPED, '')
    .replace(EXOTIC_SPACE, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------ token count -- */

/**
 * Estimates tokens for a string.
 *
 * Deliberately an estimate. `document_chunks.token_count` is used for cost reporting
 * and for sizing a retrieval budget, never for truncating an input — nothing is cut on
 * the strength of this number, so being a few percent out is harmless.
 *
 * The maximum of two heuristics rather than either alone: characters ÷ 4 underestimates
 * text with many short tokens (clause numbering, "AED 120,000", dates), and words × 1.3
 * underestimates long compound words. Taking the larger errs towards over-reporting,
 * which is the safe direction for a budget.
 */
export function estimateTokenCount(text: string): number {
  if (text.length === 0) return 0;
  const words = text.match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.round(Math.max(text.length / 4, words * 1.3)));
}

/* ------------------------------------------------------------------ units -- */

/**
 * The smallest piece the packer moves around.
 *
 * `newText` is false for a unit carried over as overlap: it is real content, but it is
 * a repeat, so a chunk made only of such units would be a duplicate of its predecessor
 * and is never emitted. That flag is what guarantees forward progress.
 */
interface Unit {
  readonly text: string;
  /** Separator to place before this unit when joining. */
  readonly separator: '' | ' ' | '\n' | '\n\n';
  /** The most recent heading at or before this unit. */
  readonly heading: string | null;
  /** True when this unit is itself a heading line. */
  readonly isHeading: boolean;
  readonly newText: boolean;
}

/**
 * Is this line a clause heading?
 *
 * Three shapes, all common in a Dubai tenancy agreement: a numbered clause
 * ("4.2 Rent and Payment"), an upper-case caption ("PAYMENT TERMS"), and a keyword
 * opener ("Schedule 2 — Fees"). All three are short, unpunctuated at the end, and
 * followed by the text they govern — which is exactly what makes them worth carrying
 * into a chunk that would otherwise start with a bare pronoun.
 */
function isHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HEADING_CHARS) return false;
  if (/[.;,]$/.test(trimmed)) return false;

  const numbered = /^\(?\d+(\.\d+)*[.)]?\s+\S/.test(trimmed);
  const keyword = /^(clause|section|article|schedule|annex|annexure|appendix|part|exhibit)\b/i.test(
    trimmed,
  );
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  const shouting = letters.length >= 3 && letters === letters.toUpperCase();

  return numbered || keyword || shouting;
}

/**
 * Splits a long line into sentences.
 *
 * The lookbehind requires terminal punctuation and the lookahead requires the next
 * sentence to start like one. Fragments shorter than 40 characters are re-joined to the
 * sentence before them, which is what stops "No." in "No. 42 Al Wasl Road" and "Dhs."
 * from becoming their own sentences — a cheap approximation of abbreviation handling
 * that costs nothing and fails safe (it merges, never cuts).
 */
function splitSentences(line: string): string[] {
  const parts = line.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/);
  const out: string[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (piece.length === 0) continue;
    const previous = out[out.length - 1];
    if (previous !== undefined && piece.length < 40) out[out.length - 1] = `${previous} ${piece}`;
    else out.push(piece);
  }
  return out;
}

/**
 * Hard-splits a run with no space in it at all.
 *
 * Reached only by text that is not words: a PDF whose text layer lost its spacing, a
 * base64 blob, a script that does not space-delimit. Left whole, such a run would be a
 * single 5000-character "word" — one chunk far outside the size the embedding model
 * expects, which comes back as a 400 or, worse, as a silently truncated vector.
 *
 * `Array.from` rather than `slice` so the cut lands between code points and cannot
 * halve a surrogate pair into two replacement characters.
 */
function splitLongRun(word: string, maxChars: number): string[] {
  const characters = Array.from(word);
  const out: string[] = [];
  for (let start = 0; start < characters.length; start += maxChars) {
    out.push(characters.slice(start, start + maxChars).join(''));
  }
  return out;
}

/** Last resort: cut on spaces, and only inside a "word" that is not one. */
function splitOnWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const out: string[] = [];
  let buffer = '';

  for (const word of words) {
    const candidate = buffer.length === 0 ? word : `${buffer} ${word}`;
    if (candidate.length > maxChars && buffer.length > 0) {
      out.push(buffer);
      buffer = '';
    }
    // A real word longer than the cap is kept whole — cutting it would invent a word
    // that is not in the document, and a citation must quote, not paraphrase. Only a
    // run long enough that it cannot be a word is cut.
    if (word.length > maxChars) {
      const pieces = splitLongRun(word, maxChars);
      out.push(...pieces.slice(0, -1));
      buffer = pieces[pieces.length - 1] ?? '';
    } else {
      buffer = buffer.length === 0 ? word : `${buffer} ${word}`;
    }
  }
  if (buffer.length > 0) out.push(buffer);
  return out;
}

/**
 * Descends the boundary ladder until every unit fits in `maxChars`.
 *
 * Paragraph → line → sentence → word. Each rung is only used when the rung above left
 * something too long, so the strongest available boundary always wins.
 */
function buildUnits(text: string, maxChars: number): Unit[] {
  const units: Unit[] = [];
  let heading: string | null = null;

  const paragraphs = text.split(/\n{2,}/);

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const trimmedParagraph = paragraph.trim();
    if (trimmedParagraph.length === 0) return;

    const lines = trimmedParagraph.split('\n');
    lines.forEach((rawLine, lineIndex) => {
      const line = rawLine.trim();
      if (line.length === 0) return;

      const headingHere = isHeadingLine(line);
      if (headingHere) heading = line;

      const separator: Unit['separator'] =
        units.length === 0 ? '' : lineIndex === 0 && paragraphIndex > 0 ? '\n\n' : '\n';

      if (line.length <= maxChars) {
        units.push({
          text: line,
          separator,
          heading,
          isHeading: headingHere,
          newText: true,
        });
        return;
      }

      // Too long for one chunk: sentences, then words.
      const pieces = splitSentences(line).flatMap((sentence) =>
        sentence.length <= maxChars ? [sentence] : splitOnWords(sentence, maxChars),
      );
      pieces.forEach((piece, pieceIndex) => {
        units.push({
          text: piece,
          separator: pieceIndex === 0 ? separator : ' ',
          heading,
          isHeading: false,
          newText: true,
        });
      });
    });
  });

  return units;
}

/* ----------------------------------------------------------------- packer -- */

function join(units: readonly Unit[]): string {
  return units
    .map((unit, index) => (index === 0 ? unit.text : `${unit.separator || ' '}${unit.text}`))
    .join('')
    .trim();
}

function lengthOf(units: readonly Unit[], extra?: Unit): number {
  const all = extra ? [...units, extra] : units;
  return join(all).length;
}

/**
 * Builds the overlap seed for the next chunk from the tail of the one just emitted.
 *
 * Whole units are preferred, because half a sentence reads as a transcription error in
 * a citation panel. When the final unit alone is longer than the overlap budget, its
 * tail is taken instead — clipped forward to the next space so the seed still starts at
 * a word boundary.
 */
function buildOverlap(units: readonly Unit[], overlapChars: number): Unit[] {
  if (overlapChars <= 0 || units.length === 0) return [];

  const carried: Unit[] = [];
  let used = 0;

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (!unit) break;
    const cost = unit.text.length + 1;
    if (used + cost > overlapChars) break;
    carried.unshift({ ...unit, newText: false });
    used += cost;
  }

  if (carried.length > 0) return carried;

  const last = units[units.length - 1];
  if (!last) return [];

  const tail = last.text.slice(Math.max(0, last.text.length - overlapChars));
  const spaceAt = tail.indexOf(' ');
  const clipped = spaceAt >= 0 ? tail.slice(spaceAt + 1) : tail;
  if (clipped.length === 0) return [];

  return [{ ...last, text: clipped, separator: '', newText: false }];
}

/**
 * Chooses the heading prefix for a chunk.
 *
 * Only prefixes when the chunk does not already open with a heading of its own and its
 * first line is not the heading already. The prefix is what turns "the amount shall be
 * paid annually in advance" into "4.2 Rent and Payment / the amount shall be paid
 * annually in advance" — the difference between a citation that can be read and one
 * that cannot.
 */
function applyHeading(content: string, heading: string | null): string {
  if (!heading) return content;
  if (content.length === 0) return content;
  if (content.startsWith(heading)) return content;
  if (isHeadingLine(content.split('\n', 1)[0] ?? '')) return content;
  return `${heading}\n${content}`;
}

/* ------------------------------------------------------------------- main -- */

/**
 * Splits document text into overlapping, citation-ready chunks.
 *
 * Pure and deterministic. Returns an empty chunk list for empty or whitespace-only
 * input rather than throwing: "this document has no text" is a fact the caller must
 * handle, not an exception.
 */
export function chunkDocumentText(text: string, options: ChunkTextOptions = {}): ChunkTextResult {
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS);
  const minChars = Math.min(Math.max(0, options.minChars ?? DEFAULT_MIN_CHUNK_CHARS), maxChars);
  const overlapChars = Math.max(
    0,
    Math.min(options.overlapChars ?? DEFAULT_OVERLAP_CHARS, maxChars - 1),
  );
  const maxChunks = Math.max(1, options.maxChunks ?? DEFAULT_MAX_CHUNKS);

  const normalised = normaliseForChunking(text);
  if (normalised.length === 0) {
    return { chunks: [], truncated: false, sourceChars: 0, totalTokens: 0 };
  }

  const units = buildUnits(normalised, maxChars);
  const packed: { units: Unit[]; heading: string | null }[] = [];

  let current: Unit[] = [];
  let carriedCount = 0;
  let truncated = false;

  const flush = (): boolean => {
    const hasNew = current.some((unit) => unit.newText);
    if (!hasNew) {
      current = [];
      carriedCount = 0;
      return true;
    }
    const first = current[0];
    packed.push({ units: current, heading: first?.heading ?? null });
    if (packed.length >= maxChunks) return false;

    const overlap = buildOverlap(current, overlapChars);
    current = [...overlap];
    carriedCount = overlap.length;
    return true;
  };

  for (const unit of units) {
    const projected = lengthOf(current, unit);
    const hasNew = current.length > carriedCount;

    // Emit only when the chunk already holds new text — otherwise the next chunk would
    // repeat its predecessor's tail and nothing would advance. The `minChars` clause is
    // the stub guard: a short chunk absorbs the next unit rather than standing alone.
    if (hasNew && projected > maxChars) {
      const absorb = lengthOf(current) < minChars && projected <= maxChars + OVERRUN_ALLOWANCE;
      if (!absorb) {
        if (!flush()) {
          truncated = true;
          break;
        }
      }
    }

    current.push(unit);
  }

  if (!truncated && current.some((unit) => unit.newText) && packed.length < maxChunks) {
    const first = current[0];
    packed.push({ units: current, heading: first?.heading ?? null });
  } else if (!truncated && current.some((unit) => unit.newText)) {
    truncated = true;
  }

  // Fold a stub tail into its predecessor. A two-sentence final chunk is a poor
  // citation and a poor vector; merging costs nothing because the predecessor already
  // overlaps it.
  if (packed.length >= 2) {
    const last = packed[packed.length - 1];
    const previous = packed[packed.length - 2];
    if (last && previous) {
      const newChars = last.units
        .filter((unit) => unit.newText)
        .reduce((total, unit) => total + unit.text.length, 0);
      const merged = join([...previous.units, ...last.units.filter((unit) => unit.newText)]);
      if (newChars < MIN_TRAILING_NEW_CHARS && merged.length <= maxChars + OVERRUN_ALLOWANCE) {
        packed.splice(packed.length - 2, 2, {
          units: [...previous.units, ...last.units.filter((unit) => unit.newText)],
          heading: previous.heading,
        });
      }
    }
  }

  const chunks: DocumentChunk[] = packed.map((entry, index) => {
    const content = applyHeading(join(entry.units), entry.heading);
    return {
      index,
      content,
      tokenCount: estimateTokenCount(content),
      charCount: content.length,
      heading: entry.heading,
    };
  });

  return {
    chunks,
    truncated,
    sourceChars: normalised.length,
    totalTokens: chunks.reduce((total, chunk) => total + chunk.tokenCount, 0),
  };
}
