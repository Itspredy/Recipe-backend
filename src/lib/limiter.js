/**
 * Rate limiting.
 *
 * Every uncached import costs real money (managed scraper + AI), so an open
 * endpoint is a billing liability, not just a load concern. Two independent
 * limits per client:
 *
 *   • burst  — requests per short window, stops hammering.
 *   • daily  — imports per rolling day, caps the worst-case spend per user and
 *              is the natural place to enforce a free-tier quota later.
 *
 * State is in-process. With one instance that is exact; across several replicas
 * each holds its own counters, so the effective limit scales with instance
 * count. That is fine for the current single-instance deployment — move to
 * Redis if you scale out and need it exact.
 */

const BURST_MAX = Number(process.env.RATE_LIMIT_BURST ?? 10);
const BURST_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
const DAILY_MAX = Number(process.env.RATE_LIMIT_DAILY ?? 100);
const DAY_MS = 24 * 60 * 60 * 1000;

const buckets = new Map(); // key -> { burst: number[], dayCount, dayStart }

// Stale entries would otherwise accumulate for every IP ever seen.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    const idle = now - bucket.dayStart > DAY_MS && !bucket.burst.some((t) => now - t < BURST_WINDOW_MS);
    if (idle) buckets.delete(key);
  }
}, 60 * 60 * 1000);
sweep.unref?.();

/**
 * Identify the caller. Behind Railway/any proxy the socket address is the
 * proxy's, so prefer the client-supplied device id, then the forwarded IP.
 */
export function clientKey(req) {
  const deviceId = req.get('x-device-id');
  if (deviceId) return `device:${deviceId.slice(0, 100)}`;
  const forwarded = (req.get('x-forwarded-for') ?? '').split(',')[0].trim();
  return `ip:${forwarded || req.socket.remoteAddress || 'unknown'}`;
}

/**
 * Express middleware. Rejects with 429 and a friendly message the app can show.
 * Only applied to the expensive endpoints — /health stays open.
 */
export function rateLimit(req, res, next) {
  const key = clientKey(req);
  const now = Date.now();
  const bucket = buckets.get(key) ?? { burst: [], dayCount: 0, dayStart: now };

  bucket.burst = bucket.burst.filter((t) => now - t < BURST_WINDOW_MS);
  if (now - bucket.dayStart >= DAY_MS) {
    bucket.dayStart = now;
    bucket.dayCount = 0;
  }

  if (bucket.burst.length >= BURST_MAX) {
    buckets.set(key, bucket);
    res.set('Retry-After', String(Math.ceil(BURST_WINDOW_MS / 1000)));
    return res.status(429).json({ error: 'Slow down a moment, then try again.' });
  }

  if (bucket.dayCount >= DAILY_MAX) {
    buckets.set(key, bucket);
    return res.status(429).json({ error: "You've hit today's import limit. Try again tomorrow." });
  }

  bucket.burst.push(now);
  bucket.dayCount += 1;
  buckets.set(key, bucket);
  next();
}

export function limiterStatus() {
  return { trackedClients: buckets.size, burstMax: BURST_MAX, dailyMax: DAILY_MAX };
}
