/**
 * The token bucket, its defaults, and the AI ceiling.
 *
 * Time is injected rather than slept on, so refill behaviour is tested exactly instead
 * of approximately.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  RATE_LIMIT_DEFAULTS,
  applyAiCeiling,
  bucketCount,
  consume,
  defaultRuleFor,
  isAiPath,
  resetRateLimits,
} from '../index';

beforeEach(() => {
  resetRateLimits();
});

describe('the bucket', () => {
  it('allows up to the burst, then refuses', () => {
    const rule = { key: 'k', perMinute: 3 };
    const results = [0, 1, 2, 3].map(() => consume(rule, 'user-1', 1_000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it('reports remaining tokens', () => {
    const rule = { key: 'k', perMinute: 3 };
    expect(consume(rule, 'user-1', 1_000).remaining).toBe(2);
    expect(consume(rule, 'user-1', 1_000).remaining).toBe(1);
    expect(consume(rule, 'user-1', 1_000).remaining).toBe(0);
  });

  it('refills continuously, not on a window boundary', () => {
    const rule = { key: 'k', perMinute: 60 }; // one token per second
    for (let i = 0; i < 60; i += 1) consume(rule, 'user-1', 0);
    expect(consume(rule, 'user-1', 0).allowed).toBe(false);
    expect(consume(rule, 'user-1', 1_000).allowed).toBe(true);
    expect(consume(rule, 'user-1', 1_000).allowed).toBe(false);
    expect(consume(rule, 'user-1', 3_000).allowed).toBe(true);
  });

  it('never refills past the burst', () => {
    const rule = { key: 'k', perMinute: 60, burst: 2 };
    consume(rule, 'user-1', 0);
    consume(rule, 'user-1', 0);
    // An hour of idleness must not bank 3600 tokens.
    const results = [0, 1, 2].map(() => consume(rule, 'user-1', 3_600_000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
  });

  it('suggests a retry delay of at least one second', () => {
    const rule = { key: 'k', perMinute: 1 };
    consume(rule, 'user-1', 0);
    const denied = consume(rule, 'user-1', 0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('isolates subjects, so one user cannot exhaust another', () => {
    const rule = { key: 'k', perMinute: 1 };
    expect(consume(rule, 'user-1', 0).allowed).toBe(true);
    expect(consume(rule, 'user-1', 0).allowed).toBe(false);
    expect(consume(rule, 'user-2', 0).allowed).toBe(true);
  });

  it('isolates buckets, so one route cannot exhaust another', () => {
    expect(consume({ key: 'read', perMinute: 1 }, 'user-1', 0).allowed).toBe(true);
    expect(consume({ key: 'read', perMinute: 1 }, 'user-1', 0).allowed).toBe(false);
    expect(consume({ key: 'write', perMinute: 1 }, 'user-1', 0).allowed).toBe(true);
  });

  it('treats a zero limit as a one-token bucket rather than a lockout', () => {
    expect(consume({ key: 'k', perMinute: 0 }, 'user-1', 0).allowed).toBe(true);
  });

  it('sweeps idle buckets so the map cannot grow without bound', () => {
    consume({ key: 'k', perMinute: 10 }, 'user-1', 0);
    expect(bucketCount()).toBe(1);
    // Far past the TTL; the next call sweeps and then creates its own bucket.
    consume({ key: 'k', perMinute: 10 }, 'user-2', 60 * 60 * 1000);
    expect(bucketCount()).toBe(1);
  });
});

describe('defaults', () => {
  it('is strictest on the AI prefix', () => {
    expect(RATE_LIMIT_DEFAULTS.ai.perMinute).toBeLessThan(RATE_LIMIT_DEFAULTS.mutation.perMinute);
    expect(RATE_LIMIT_DEFAULTS.mutation.perMinute).toBeLessThan(RATE_LIMIT_DEFAULTS.read.perMinute);
  });

  it('recognises the frozen AI prefix', () => {
    expect(isAiPath('/api/v1/ai')).toBe(true);
    expect(isAiPath('/api/v1/ai/maintenance/classify')).toBe(true);
    expect(isAiPath('/api/v1/aircon')).toBe(false);
    expect(isAiPath('/api/v1/properties')).toBe(false);
  });

  it('picks the AI rule for an AI route whatever the method', () => {
    expect(defaultRuleFor('/api/v1/ai/documents/extract', 'POST').key).toBe('ai');
    expect(defaultRuleFor('/api/v1/ai/documents/extract', 'GET').key).toBe('ai');
  });

  it('separates reads from writes elsewhere', () => {
    expect(defaultRuleFor('/api/v1/properties', 'GET').key).toBe('read');
    expect(defaultRuleFor('/api/v1/properties', 'POST').key).toBe('mutation');
    expect(defaultRuleFor('/api/v1/properties', 'PATCH').key).toBe('mutation');
  });
});

describe('the AI ceiling', () => {
  it('caps a looser declared limit on an AI route', () => {
    const capped = applyAiCeiling({ key: 'classify', perMinute: 600 }, '/api/v1/ai/x');
    expect(capped.perMinute).toBe(RATE_LIMIT_DEFAULTS.ai.perMinute);
    expect(capped.burst).toBe(RATE_LIMIT_DEFAULTS.ai.burst);
    expect(capped.key).toBe('classify');
  });

  it('leaves a stricter declared limit alone', () => {
    expect(applyAiCeiling({ key: 'classify', perMinute: 2 }, '/api/v1/ai/x').perMinute).toBe(2);
  });

  it('does not touch a non-AI route', () => {
    expect(applyAiCeiling({ key: 'bulk', perMinute: 600 }, '/api/v1/properties').perMinute).toBe(
      600,
    );
  });
});
