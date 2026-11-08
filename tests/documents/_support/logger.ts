/**
 * A capturing logger.
 *
 * Two jobs. The obvious one is keeping the test output readable — the worker logs on
 * every job and a passing suite should be quiet.
 *
 * The one that matters is making log *content* assertable. CLAUDE.md rule 8 forbids
 * logging document text, message bodies, tokens or personal data, and the only way to
 * test a prohibition is to capture everything that was logged and look. `lines` holds
 * every call, message and field bag, so a test can assert that a tenant's name never
 * appears anywhere in the output of a job that just read their tenancy contract.
 *
 * Note that this logger does **not** apply the redaction allowlist from
 * `lib/observability/redaction.ts`. That is deliberate: it captures what the call sites
 * *passed*, not what the real logger would have kept. Testing against the redacted
 * output would prove only that redaction works — which `lib/observability`'s own suite
 * already does — and would hide a call site that hands document text to a logger and
 * gets away with it today because the field name happens to be unlisted.
 */

import type { Logger, LogFields } from '@/lib/observability/logger';

export interface CapturedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields;
}

export interface CapturingLogger extends Logger {
  readonly lines: CapturedLine[];
  /** Every message and every field value, concatenated. For "must not contain" checks. */
  allText(): string;
}

export function createCapturingLogger(bound: LogFields = {}): CapturingLogger {
  const lines: CapturedLine[] = [];

  const make = (boundFields: LogFields): CapturingLogger => {
    const log =
      (level: CapturedLine['level']) =>
      (message: string, fields: LogFields = {}): void => {
        lines.push({ level, message, fields: { ...boundFields, ...fields } });
      };

    return {
      lines,
      requestId: 'test-request-id',
      debug: log('debug'),
      info: log('info'),
      warn: log('warn'),
      error: log('error'),
      child: (fields: LogFields) => make({ ...boundFields, ...fields }),
      allText: () =>
        lines.map((line) => `${line.message} ${JSON.stringify(line.fields)}`).join('\n'),
    };
  };

  return make(bound);
}
