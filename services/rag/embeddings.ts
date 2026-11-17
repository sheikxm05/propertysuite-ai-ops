/**
 * The embeddings transport — NVIDIA NIM's OpenAI-compatible `POST /embeddings`.
 *
 * Sibling of `services/ai/providers/nvidia.ts` and deliberately shaped like it: plain
 * `fetch` (the dependency list is frozen, and NIM is plain REST), the same credential
 * accessor, and above all the same error discipline — 401/403/404/410 is a
 * CONFIGURATION fault that must never be retried, 429 is rate limiting, everything else
 * is transient. See `errors.ts` for why that distinction is load-bearing.
 *
 * What this file adds over the chat transport, because embedding is a bulk operation
 * and classification is not:
 *
 *  - **Batching.** NIM takes an array of inputs. One request per chunk would turn a
 *    40-chunk tenancy agreement into 40 round trips.
 *  - **Bounded concurrency.** Unbounded `Promise.all` over a 400-chunk document is a
 *    self-inflicted denial of service that arrives at the provider as a burst and comes
 *    back as 429s.
 *  - **Bounded retries with backoff and jitter.** Retrying a rate limit immediately is
 *    how a transient 429 becomes a sustained one. Jitter stops concurrent batches from
 *    retrying in lockstep.
 *  - **Order preservation.** The reply's `data` entries carry an `index`, and they are
 *    re-sorted by it before being mapped back. An out-of-order reply that is zipped
 *    positionally stores each vector against the wrong chunk — the single worst bug
 *    available here, because retrieval still "works" and every citation is wrong.
 *
 * NOTHING IN THIS FILE LOGS. It receives chunk text and returns vectors, both of which
 * are unloggable (CLAUDE.md rule 8). Callers log counts and durations; this module has
 * no logger to misuse.
 */

import { serverEnv } from '@/lib/env';
import { nvidiaApiKey } from '@/lib/server-only/secrets';

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL_ID,
  isValidEmbedding,
  type EmbeddingInputType,
} from './embedding-model';
import {
  RagMalformedReplyError,
  RagNotConfiguredError,
  RagProviderError,
  errorForStatus,
  isRagError,
} from './errors';

/* ------------------------------------------------------------- constants -- */

/**
 * Inputs per request. NIM accepts an array; this is a throughput/latency trade, not a
 * hard API limit. 32 keeps a request body around 40 KB of text, well inside any
 * gateway's limit, while cutting a 400-chunk document to 13 round trips.
 */
export const DEFAULT_BATCH_SIZE = 32;

/** Characters per request, as a second bound. A batch of 32 long chunks is still small. */
const MAX_BATCH_CHARS = 60_000;

/** Requests in flight. Low on purpose: the rate limit is shared with the chat lane. */
export const DEFAULT_CONCURRENCY = 3;

/** Per-request timeout. An embedding call that takes a minute has failed. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000;

/** Attempts per batch, including the first. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Base backoff. Doubled per attempt, then jittered. */
const BACKOFF_BASE_MS = 600;

/** Ceiling on a single backoff wait, so a retry cannot outlive the job's deadline. */
const BACKOFF_CEILING_MS = 8_000;

/* ----------------------------------------------------------------- types -- */

export interface EmbedOptions {
  /** Cancellation from the caller — in a job, the attempt deadline. */
  readonly signal?: AbortSignal;
}

export interface EmbeddingClient {
  /** Transport id, for logs. Never the credential, never the base URL. */
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  /** Embeds stored text. `input_type: "passage"`. */
  embedPassages(inputs: readonly string[], options?: EmbedOptions): Promise<number[][]>;
  /** Embeds a question. `input_type: "query"`. */
  embedQuery(input: string, options?: EmbedOptions): Promise<number[]>;
}

export interface NvidiaEmbeddingClientOptions {
  readonly model?: string;
  readonly dimensions?: number;
  readonly batchSize?: number;
  readonly concurrency?: number;
  readonly requestTimeoutMs?: number;
  readonly maxAttempts?: number;
  /** Injected in tests and evals. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Jitter source, pinned in tests so a backoff assertion is deterministic. */
  readonly random?: () => number;
  /** Sleep, so a test does not actually wait out a backoff. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const NVIDIA_EMBEDDING_TRANSPORT_ID = 'nvidia-embeddings';

/* ------------------------------------------------------------ reply shape -- */

/** The subset of the OpenAI-compatible reply this transport relies on. */
interface EmbeddingsReply {
  readonly data?: readonly {
    readonly index?: unknown;
    readonly embedding?: unknown;
  }[];
  readonly model?: unknown;
  readonly usage?: { readonly prompt_tokens?: unknown; readonly total_tokens?: unknown };
  /** NIM problem+json error shape. */
  readonly title?: unknown;
  readonly detail?: unknown;
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/* ---------------------------------------------------------------- helpers -- */

/**
 * Reads the credential without throwing.
 *
 * Mirrors both existing providers: a missing or blank key must surface as the clean
 * "not configured" path, never as a boot-shaped 500 from env validation.
 */
function readApiKey(): string | null {
  try {
    const key = nvidiaApiKey();
    return key && key.trim().length > 0 ? key : null;
  } catch {
    return null;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Groups inputs into batches, bounded by count and by characters.
 *
 * Returns index-carrying batches rather than plain arrays of strings: the caller writes
 * results back by original position, and a batcher that loses positions would make that
 * impossible to do correctly.
 */
export function batchInputs(
  inputs: readonly string[],
  batchSize: number,
  maxChars: number = MAX_BATCH_CHARS,
): { index: number; text: string }[][] {
  const batches: { index: number; text: string }[][] = [];
  let current: { index: number; text: string }[] = [];
  let chars = 0;

  inputs.forEach((text, index) => {
    const wouldOverflow =
      current.length >= batchSize || (current.length > 0 && chars + text.length > maxChars);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push({ index, text });
    chars += text.length;
  });

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Runs `tasks` with at most `limit` in flight.
 *
 * A hand-rolled pool rather than a dependency, and a pool rather than `Promise.all`:
 * see the file header. The first rejection is propagated and the remaining tasks are
 * not started, because a failed batch means the document will not be stored anyway and
 * continuing would spend quota on work about to be discarded.
 */
async function runWithConcurrency<T>(
  tasks: readonly (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let cursor = 0;
  let failed = false;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      const task = tasks[index];
      if (!task) return;
      try {
        results[index] = await task();
      } catch (thrown) {
        failed = true;
        throw thrown;
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/* ----------------------------------------------------------------- client -- */

/**
 * Creates the NVIDIA embedding client.
 *
 * A factory, not a module-level singleton: the credential is read per call through
 * `readApiKey()`, so a process that boots without a key and gains one later does not
 * need a restart, and a test can construct a client with an injected `fetch` without
 * touching global state.
 */
export function createNvidiaEmbeddingClient(
  options: NvidiaEmbeddingClientOptions = {},
): EmbeddingClient {
  const model = options.model ?? EMBEDDING_MODEL_ID;
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const doFetch = options.fetchImpl ?? fetch;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  /** One HTTP call. Throws a classified `RagError`; never retries internally. */
  async function postBatch(
    texts: readonly string[],
    inputType: EmbeddingInputType,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const apiKey = readApiKey();
    if (!apiKey) throw new RagNotConfiguredError('missing_nvidia_api_key');

    const baseUrl = serverEnv().NVIDIA_BASE_URL.replace(/\/+$/, '');

    const timeout = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        // `input_type` is NIM's required extension to the OpenAI body. Omitting it is
        // a 400; getting it wrong is silent (see `embedding-model.ts`).
        body: JSON.stringify({ model, input: texts, input_type: inputType }),
        signal: composed,
        cache: 'no-store',
      });
    } catch (thrown) {
      const name = thrown instanceof Error ? thrown.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new RagProviderError('aborted', { attempt, cause: thrown });
      }
      throw new RagProviderError('unreachable', { attempt, cause: thrown });
    }

    let payload: EmbeddingsReply;
    try {
      payload = (await response.json()) as EmbeddingsReply;
    } catch (thrown) {
      if (!response.ok) {
        throw errorForStatus(response.status, 'nvidia_error', attempt);
      }
      throw new RagMalformedReplyError('reply_not_json', thrown);
    }

    if (!response.ok) {
      // NIM problem+json: `detail` names the model and the account and contains no
      // request content, so it is safe to carry as a reason.
      const reason = asString(payload.detail) ?? asString(payload.title) ?? 'nvidia_error';
      throw errorForStatus(response.status, reason, attempt);
    }

    const data = payload.data;
    if (!Array.isArray(data)) throw new RagMalformedReplyError('reply_missing_data');
    if (data.length !== texts.length) throw new RagMalformedReplyError('reply_count_mismatch');

    // Sort by the reply's own `index` before zipping. Positional zipping of an
    // out-of-order reply attaches every vector to the wrong chunk.
    const ordered = new Array<number[] | undefined>(texts.length);
    data.forEach((entry, position) => {
      const at =
        typeof entry.index === 'number' && Number.isInteger(entry.index) ? entry.index : position;
      if (at < 0 || at >= texts.length || ordered[at] !== undefined) {
        throw new RagMalformedReplyError('reply_index_invalid');
      }
      if (!isValidEmbedding(entry.embedding, dimensions)) {
        // Wrong width means the wrong model answered — a configuration fault, not a
        // transient one, so it is raised as such by `toVectorLiteral`'s sibling check.
        throw new RagMalformedReplyError(
          Array.isArray(entry.embedding) ? 'reply_wrong_dimensions' : 'reply_embedding_invalid',
        );
      }
      ordered[at] = entry.embedding;
    });

    const vectors: number[][] = [];
    for (const vector of ordered) {
      if (!vector) throw new RagMalformedReplyError('reply_count_mismatch');
      vectors.push(vector);
    }
    return vectors;
  }

  /** `postBatch` plus the bounded retry. Only transient failures are retried. */
  async function postBatchWithRetry(
    texts: readonly string[],
    inputType: EmbeddingInputType,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await postBatch(texts, inputType, attempt, signal);
      } catch (thrown) {
        lastError = thrown;

        // A configuration fault is permanent by definition, and a caller-cancelled
        // request must not be retried past its own deadline.
        if (isRagError(thrown) && !thrown.retryable) throw thrown;
        if (signal?.aborted) throw thrown;
        if (attempt === maxAttempts) throw thrown;

        const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CEILING_MS);
        await sleep(Math.round(base * (0.5 + random() * 0.5)), signal);
      }
    }

    throw lastError ?? new RagProviderError('upstream_error', { attempt: maxAttempts });
  }

  async function embedMany(
    inputs: readonly string[],
    inputType: EmbeddingInputType,
    options_: EmbedOptions = {},
  ): Promise<number[][]> {
    if (inputs.length === 0) return [];

    const batches = batchInputs(inputs, batchSize);
    const tasks = batches.map(
      (batch) => () =>
        postBatchWithRetry(
          batch.map((entry) => entry.text),
          inputType,
          options_.signal,
        ),
    );

    const batchResults = await runWithConcurrency(tasks, concurrency);

    const vectors = new Array<number[] | undefined>(inputs.length);
    batches.forEach((batch, batchIndex) => {
      const result = batchResults[batchIndex];
      if (!result) throw new RagMalformedReplyError('batch_result_missing');
      batch.forEach((entry, position) => {
        vectors[entry.index] = result[position];
      });
    });

    const complete: number[][] = [];
    for (const vector of vectors) {
      if (!vector) throw new RagMalformedReplyError('batch_result_missing');
      complete.push(vector);
    }
    return complete;
  }

  return {
    id: NVIDIA_EMBEDDING_TRANSPORT_ID,
    model,
    dimensions,
    embedPassages: (inputs, embedOptions) => embedMany(inputs, 'passage', embedOptions ?? {}),
    async embedQuery(input, embedOptions) {
      const [vector] = await embedMany([input], 'query', embedOptions ?? {});
      if (!vector) throw new RagMalformedReplyError('reply_count_mismatch');
      return vector;
    },
  };
}

/** Whether an embedding call is possible at all. Used by live-only gates. */
export function hasEmbeddingCredential(): boolean {
  return readApiKey() !== null;
}
