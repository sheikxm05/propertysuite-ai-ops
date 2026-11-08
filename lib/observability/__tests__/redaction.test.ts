/**
 * Redaction and logging.
 *
 * The thing being proven is a negative: that document text, message bodies, tokens and
 * personal data *cannot* reach a log line. So most of these tests assert absence, and
 * several of them deliberately try to sneak a value through — nested, in an array, as an
 * object key, inside the free-text message — because those are the routes a denylist
 * would miss.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger, setLogLevel, systemLogger } from '../logger';
import { LOGGABLE_FIELDS, redactFields, redactMetadata, scrubText } from '../redaction';

/** Captures what the logger writes, whichever transport it chooses. */
function captureLines(run: () => void): string[] {
  const lines: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    lines.push(args.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    run();
  } finally {
    stdout.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
  return lines;
}

function captureRecords(run: () => void): Record<string, unknown>[] {
  return captureLines(run).map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  setLogLevel('info');
});

describe('the allowlist itself', () => {
  const forbidden = [
    'email',
    'phone',
    'full_name',
    'name',
    'address_line',
    'title',
    'description',
    'content',
    'message',
    'body',
    'text',
    'token',
    'access_token',
    'refresh_token',
    'authorization',
    'cookie',
    'password',
    'api_key',
    'key',
    'secret',
    'extracted_data',
    'storage_path',
    'metadata',
    'payload',
    'signed_url',
    'rent_amount',
  ];

  for (const field of forbidden) {
    it(`never allows "${field}"`, () => {
      expect(LOGGABLE_FIELDS.has(field)).toBe(false);
    });
  }

  it('allows the operational fields the wrapper depends on', () => {
    for (const field of [
      'request_id',
      'route',
      'method',
      'status_code',
      'duration_ms',
      'organization_id',
      'profile_id',
      'role',
      'error_code',
      'reason',
      'pg_code',
      'action',
      'entity_type',
      'entity_id',
    ]) {
      expect(LOGGABLE_FIELDS.has(field), field).toBe(true);
    }
  });
});

describe('redactFields', () => {
  it('keeps allowlisted fields and drops everything else', () => {
    const { fields, redacted } = redactFields({
      organization_id: 'org-1',
      email: 'tenant@example.com',
      description: 'The AC is leaking onto the floor',
    });
    expect(fields).toEqual({ organization_id: 'org-1' });
    expect(redacted).toBe(2);
  });

  it('drops an unknown key without walking into it', () => {
    const { fields } = redactFields({
      ticket: { ticket_id: 'abc', description: 'secret' },
    });
    expect(fields).toEqual({});
  });

  it('filters nested objects under an allowlisted key', () => {
    const { fields } = redactFields({
      // `provider` is allowlisted; its contents are filtered on their own merits.
      provider: { model: 'claude-sonnet-5', api_key: 'sk-ant-abcdefghijkl' },
    });
    expect(fields).toEqual({ provider: { model: 'claude-sonnet-5' } });
  });

  it('reports the number dropped, not the names', () => {
    const result = redactFields({ 'tenant@example.com': 1, phone: '+971501234567' });
    expect(result.fields).toEqual({});
    expect(result.redacted).toBe(2);
    expect(JSON.stringify(result)).not.toContain('tenant@example.com');
  });

  it('filters objects inside an allowlisted array', () => {
    const { fields } = redactFields({
      // `reason` is allowlisted and holds a list of objects.
      reason: [{ code: 'x', description: 'leak' }],
    });
    expect(fields).toEqual({ reason: [{ code: 'x' }] });
  });

  it('truncates a long allowlisted string rather than logging a blob', () => {
    const { fields } = redactFields({ reason: 'a'.repeat(2000) });
    expect(String(fields.reason).length).toBeLessThanOrEqual(513);
  });

  it('stops at a depth bound so a cyclic structure cannot hang it', () => {
    const cyclic: Record<string, unknown> = { reason: 'root' };
    cyclic.provider = cyclic;
    expect(() => redactFields(cyclic)).not.toThrow();
  });

  it('ignores non-object input', () => {
    expect(redactFields('a string').fields).toEqual({});
    expect(redactFields(null).fields).toEqual({});
    expect(redactFields(42).fields).toEqual({});
  });
});

describe('redactMetadata — the audit row path', () => {
  it('strips document text and PII before an audit row is written', () => {
    expect(
      redactMetadata({
        entity_id: 'doc-1',
        extracted_data: { tenant_name: 'A. Person' },
        storage_path: 'org-1/documents/x.pdf',
        verification_status: 'pending',
      }),
    ).toEqual({ entity_id: 'doc-1', verification_status: 'pending' });
  });
});

describe('scrubText — the backstop for the free-text message', () => {
  it('masks a JWT', () => {
    const text = 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def';
    expect(scrubText(text)).toContain('[redacted-jwt]');
    expect(scrubText(text)).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('masks an Anthropic key', () => {
    expect(scrubText('key sk-ant-api03-ABCDEFGHIJKLMNOP')).toBe('key [redacted-key]');
  });

  it('masks a bearer header value', () => {
    expect(scrubText('Authorization: Bearer abcdef1234567890')).toContain('Bearer [redacted]');
  });

  it('masks an email address', () => {
    expect(scrubText('failed for tenant.one@example.co.uk')).toBe('failed for [redacted-email]');
  });

  it('masks a UAE mobile number', () => {
    expect(scrubText('called +971 50 123 4567')).toContain('[redacted-phone]');
  });

  it('leaves ordinary diagnostics alone', () => {
    expect(scrubText('ticket transition rejected')).toBe('ticket transition rejected');
  });
});

describe('the logger', () => {
  it('carries the correlation id on every line', () => {
    const records = captureRecords(() => {
      const logger = createLogger({ requestId: 'req-abc-123' });
      logger.info('one');
      logger.warn('two');
      logger.error('three');
    });
    expect(records).toHaveLength(3);
    for (const record of records) expect(record.request_id).toBe('req-abc-123');
  });

  it('scrubs the message as well as the fields', () => {
    const [record] = captureRecords(() => {
      createLogger({ requestId: 'r1' }).error('could not reach a.person@example.com', {
        email: 'a.person@example.com',
      });
    });
    expect(record?.msg).toBe('could not reach [redacted-email]');
    expect(record?.email).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('a.person@example.com');
  });

  it('records how many fields it dropped', () => {
    const [record] = captureRecords(() => {
      createLogger({ requestId: 'r1' }).info('x', { title: 'a', description: 'b', route: '/x' });
    });
    expect(record?.redacted).toBe(2);
    expect(record?.route).toBe('/x');
  });

  it('redacts base fields once, at creation', () => {
    const [record] = captureRecords(() => {
      createLogger({ requestId: 'r1', base: { route: '/api/v1/x', full_name: 'A Person' } }).info(
        'x',
      );
    });
    expect(record?.route).toBe('/api/v1/x');
    expect(record?.full_name).toBeUndefined();
    expect(record?.redacted).toBe(1);
  });

  it('inherits and extends bound fields through child()', () => {
    const [record] = captureRecords(() => {
      createLogger({ requestId: 'r1', base: { route: '/r' } })
        .child({ role: 'tenant', phone: '+971501234567' })
        .info('x', { status_code: 200 });
    });
    expect(record?.route).toBe('/r');
    expect(record?.role).toBe('tenant');
    expect(record?.status_code).toBe(200);
    expect(record?.phone).toBeUndefined();
  });

  it('honours the level floor', () => {
    const records = captureRecords(() => {
      setLogLevel('warn');
      const logger = createLogger({ requestId: 'r1' });
      logger.debug('dropped');
      logger.info('dropped');
      logger.warn('kept');
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('warn');
  });

  it('emits one JSON object per line', () => {
    const lines = captureLines(() => createLogger({ requestId: 'r1' }).info('x'));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(String(lines[0]))).not.toThrow();
  });

  it('generates a correlation id when none is supplied', () => {
    const [record] = captureRecords(() => systemLogger({ event: 'boot' }).info('started'));
    expect(String(record?.request_id).length).toBeGreaterThan(7);
    expect(record?.runtime).toBe('node');
  });
});
