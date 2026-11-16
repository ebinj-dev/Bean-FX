/**
 * M19 §13 — request rate limiting.
 *
 * Fixed-window counters keyed by (bucket, identity). Identity = user id when
 * authenticated, else the client IP from x-forwarded-for (first hop). The
 * production deployment runs multiple instances behind a reverse proxy, so
 * this in-process store is the DEV fallback: set RATE_LIMIT_REDIS_URL (or any
 * shared store adapter) in production — see docs/M19_ENVIRONMENT_VARIABLES.md.
 * Enforcement is real here (per-process) and honest in the docs: multi-instance
 * deployments MUST provide a shared store before relying on global limits.
 */

type Window = { count: number; resetAt: number };

const buckets = new Map<string, Window>();
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, w] of buckets) {
    if (w.resetAt <= now) buckets.delete(k);
  }
}

export type RateLimitRule = {
  /** Max requests inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
};

/** Default rules (documented in docs/M19_ENVIRONMENT_VARIABLES.md). */
export const RATE_LIMITS = {
  auth: { limit: 10, windowSec: 300 } as RateLimitRule, // login/register/reset
  register: { limit: 5, windowSec: 3600 } as RateLimitRule,
  upload: { limit: 60, windowSec: 3600 } as RateLimitRule,
  ai: { limit: 40, windowSec: 3600 } as RateLimitRule, // generation endpoints
  render: { limit: 10, windowSec: 3600 } as RateLimitRule, // durable renders
  api: { limit: 600, windowSec: 300 } as RateLimitRule, // general authenticated API
} as const;

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "local";
}

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSec: number;
};

/**
 * RATE_LIMIT_SCALE scales every limit (default 1). Test/dev environments raise
 * it so functional suites do not exhaust real quotas; production MUST run at 1.
 * Documented in docs/M19_ENVIRONMENT_VARIABLES.md.
 */
const SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE ?? 1));

export function checkRateLimit(bucket: string, identity: string, rule: RateLimitRule): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const key = `${bucket}:${identity}`;
  const win = buckets.get(key);
  if (!win || win.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowSec * 1000 });
    return { ok: true, remaining: rule.limit * SCALE - 1, resetAt: now + rule.windowSec * 1000, retryAfterSec: 0 };
  }
  win.count += 1;
  const ok = win.count <= rule.limit * SCALE;
  return {
    ok,
    remaining: Math.max(0, rule.limit - win.count),
    resetAt: win.resetAt,
    retryAfterSec: ok ? 0 : Math.ceil((win.resetAt - now) / 1000),
  };
}

/** Standard 429 response with honest headers. */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({ error: "Too many requests. Please retry later.", retryAfterSec: result.retryAfterSec }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(result.retryAfterSec),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}

/** Convenience guard: returns a 429 Response when limited, else null. */
export function enforceRateLimit(req: Request, bucket: string, identity: string, rule: RateLimitRule): Response | null {
  const result = checkRateLimit(bucket, identity, rule);
  return result.ok ? null : rateLimitResponse(result);
}
