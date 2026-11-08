/**
 * Per-user, per-route token-bucket rate limiting.
 *
 * A token bucket rather than a fixed window because a fixed window lets a caller spend
 * a whole minute's budget in the last second of one window and the first second of the
 * next — twice the intended burst. A bucket refills continuously, so the sustained rate
 * and the burst are both bounded by construction.
 *
 * The subject is always the authenticated profile id, never an IP address and never a
 * client-supplied header. An IP is shared by an office and spoofable through a proxy
 * chain; a profile id comes from `resolveMembership`, which reads trusted rows only
 * (CLAUDE.md rule 5).
 *
 * **Scope limitation, stated plainly:** the store is a process-local `Map`. On a single
 * server this is exact; across N serverless instances the effective limit is up to N×.
 * That is adequate for the MVP's purpose — blunting a runaway client and capping AI
 * spend — and not adequate as a security control on its own. Swapping in a shared store
 * is a `lib/rate-limit/**` change, which W2-L4 owns; nothing outside this module needs
 * to change for it.
 */

/** Frozen defaults. AI routes are stricter because each call costs money and tokens. */
export const RATE_LIMIT_DEFAULTS = {
  /** Anything under `/api/v1/ai/*`. Deliberately low: a model call is expensive. */
  ai: { perMinute: 10, burst: 10 },
  /** Writes. Enough for a busy manager, far below a scripted loop. */
  mutation: { perMinute: 60, burst: 20 },
  /** Reads. */
  read: { perMinute: 120, burst: 40 },
} as const;

export interface RateLimitRule {
  /** Bucket name. Scopes the counter, so two routes can share or separate a budget. */
  key: string;
  /** Sustained requests per minute. Also the bucket capacity unless `burst` is given. */
  perMinute: number;
  /** Maximum instantaneous burst. Defaults to `perMinute`. */
  burst?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until one token is available. Zero when `allowed`. */
  retryAfterSeconds: number;
  /** The sustained limit, for the caller's `X-RateLimit-*` headers if wanted. */
  limit: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Buckets never outlive this much idleness, so the map cannot grow without bound. */
const BUCKET_TTL_MS = 10 * 60 * 1000;

/** How often a `consume` call sweeps expired buckets. Amortised, no timer. */
const SWEEP_INTERVAL_MS = 60 * 1000;

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

/**
 * Spends one token for `subject` against `rule`.
 *
 * `now` is injectable so the unit tests can advance time without sleeping; production
 * callers omit it.
 */
export function consume(
  rule: RateLimitRule,
  subject: string,
  now: number = Date.now(),
): RateLimitDecision {
  sweep(now);

  const capacity = Math.max(1, rule.burst ?? rule.perMinute);
  const refillPerMs = rule.perMinute / 60_000;
  const id = `${rule.key}:${subject}`;

  const existing = buckets.get(id);
  const bucket: Bucket = existing ?? { tokens: capacity, updatedAt: now };

  if (existing) {
    const elapsed = Math.max(0, now - existing.updatedAt);
    bucket.tokens = Math.min(capacity, existing.tokens + elapsed * refillPerMs);
    bucket.updatedAt = now;
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    buckets.set(id, bucket);
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: 0,
      limit: rule.perMinute,
    };
  }

  buckets.set(id, bucket);
  const deficit = 1 - bucket.tokens;
  return {
    allowed: false,
    remaining: 0,
    retryAfterSeconds: Math.max(1, Math.ceil(deficit / refillPerMs / 1000)),
    limit: rule.perMinute,
  };
}

/**
 * Picks a rule when a route did not declare one.
 *
 * `/api/v1/ai/*` is matched on the pathname rather than opted into, so a new AI route
 * is rate limited on the day it is written and not on the day somebody notices.
 */
export function defaultRuleFor(pathname: string, method: string): RateLimitRule {
  if (isAiPath(pathname)) {
    return {
      key: 'ai',
      perMinute: RATE_LIMIT_DEFAULTS.ai.perMinute,
      burst: RATE_LIMIT_DEFAULTS.ai.burst,
    };
  }
  if (method === 'GET' || method === 'HEAD') {
    return {
      key: 'read',
      perMinute: RATE_LIMIT_DEFAULTS.read.perMinute,
      burst: RATE_LIMIT_DEFAULTS.read.burst,
    };
  }
  return {
    key: 'mutation',
    perMinute: RATE_LIMIT_DEFAULTS.mutation.perMinute,
    burst: RATE_LIMIT_DEFAULTS.mutation.burst,
  };
}

/** True for the `/api/v1/ai` prefix frozen in §5.5. */
export function isAiPath(pathname: string): boolean {
  return pathname === '/api/v1/ai' || pathname.startsWith('/api/v1/ai/');
}

/**
 * Caps a declared rule at the AI ceiling when the route lives under `/api/v1/ai/*`.
 *
 * Without this a feature lane could declare `{ key: 'classify', perMinute: 600 }` and
 * quietly undo the stricter AI default. A route may be *more* restrictive than the
 * ceiling; it may not be less.
 */
export function applyAiCeiling(rule: RateLimitRule, pathname: string): RateLimitRule {
  if (!isAiPath(pathname)) return rule;
  const ceiling = RATE_LIMIT_DEFAULTS.ai;
  return {
    key: rule.key,
    perMinute: Math.min(rule.perMinute, ceiling.perMinute),
    burst: Math.min(rule.burst ?? rule.perMinute, ceiling.burst),
  };
}

/** Clears all buckets. For tests only. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

/** Current bucket count. Exposed so a health endpoint can report memory pressure. */
export function bucketCount(): number {
  return buckets.size;
}

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [id, bucket] of buckets) {
    if (now - bucket.updatedAt > BUCKET_TTL_MS) buckets.delete(id);
  }
}
