/**
 * Structured logger.
 *
 * Three properties matter more than features:
 *
 *  1. **Correlated.** Every line carries the `request_id` of the request that produced
 *     it, so a failure can be traced from the browser's network tab through the handler
 *     to a background job.
 *  2. **Redacting by allowlist.** Fields are dropped unless named in
 *     `lib/observability/redaction.ts`. Document text, message bodies, tokens and PII
 *     are unloggable by construction, not by the author remembering to omit them
 *     (CLAUDE.md rule 8). The free-text message is scrubbed for token and PII patterns
 *     as a backstop.
 *  3. **Machine-readable.** One JSON object per line. A later lane can ship these to a
 *     collector without reparsing a human-oriented format.
 *
 * Transport is deliberately dull: `process.stdout` when it exists, `console` otherwise
 * (the edge runtime, a browser). No transport dependency, nothing to configure.
 */

import { newRequestId } from './correlation';
import { redactFields, scrubText } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured fields accepted by a log call. Keys not on the allowlist are dropped, so
 * the type is deliberately permissive — the filter is a runtime guarantee, and making
 * it a compile-time one would force every call site to cast.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger with additional bound fields. Bound fields are redacted once, here. */
  child(fields: LogFields): Logger;
  /** The correlation id every line from this logger carries. */
  readonly requestId: string;
}

/** Shape written to the transport. Flat by design: no nested `fields` envelope. */
interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  request_id: string;
  redacted?: number;
  [key: string]: unknown;
}

let minimumLevel: LogLevel = 'info';

/** Raises or lowers the floor. Called once at boot by a later lane if needed. */
export function setLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

export interface CreateLoggerOptions {
  /** Correlation id. Generated when omitted. */
  requestId?: string;
  /** Fields bound to every line, for example `route` and `method`. */
  base?: LogFields;
}

/** Creates a logger. `withApiHandler` creates one per request and puts it on `ctx`. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const requestId = options.requestId ?? newRequestId();
  const bound = redactFields(options.base ?? {});
  return build(requestId, bound.fields, bound.redacted);
}

/**
 * A process-level logger for code outside a request — boot, scheduled work, a job
 * runner picking up its first row. Each call still gets a correlation id so its lines
 * can be grouped.
 */
export function systemLogger(fields: LogFields = {}): Logger {
  return createLogger({ base: { ...fields, runtime: detectRuntime() } });
}

/* -------------------------------------------------------------- internals -- */

function build(
  requestId: string,
  boundFields: Record<string, unknown>,
  boundRedacted: number,
): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minimumLevel]) return;

    const { fields: safe, redacted } = redactFields(fields ?? {});
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg: scrubText(String(message ?? '')),
      request_id: requestId,
      ...boundFields,
      ...safe,
    };
    const dropped = redacted + boundRedacted;
    if (dropped > 0) record.redacted = dropped;

    write(level, record);
  };

  return {
    requestId,
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => {
      const extra = redactFields(fields);
      return build(requestId, { ...boundFields, ...extra.fields }, boundRedacted + extra.redacted);
    },
  };
}

function write(level: LogLevel, record: LogRecord): void {
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // A circular reference survived redaction somehow. Never lose the correlation id.
    line = JSON.stringify({
      ts: record.ts,
      level,
      msg: 'log serialisation failed',
      request_id: record.request_id,
    });
  }

  const stdout = typeof process !== 'undefined' ? process.stdout : undefined;
  if (stdout && typeof stdout.write === 'function') {
    stdout.write(`${line}\n`);
    return;
  }
  // Edge runtime or browser. `console.warn`/`console.error` are the only console
  // methods permitted by eslint.config.mjs, and info-level lines are rare here.
  if (level === 'error') console.error(line);
  else console.warn(line);
}

function detectRuntime(): string {
  if (typeof window !== 'undefined') return 'browser';
  if (typeof process === 'undefined') return 'edge';
  return 'node';
}
