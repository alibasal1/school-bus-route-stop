// Rate limiting.
//
// The parent-facing search is the one endpoint in this service that anyone
// with a login can call as often as they like, and the admin writes are the
// ones that cost the most. Neither should be reachable thousands of times a
// minute from one account: on the Neon free plan a scripted loop exhausts the
// compute-hour budget and takes the whole app down for every family, which is
// a denial of service that costs the attacker nothing.
//
// Counters live in Upstash Redis, reached over its REST API with fetch, so
// the limit is shared by every serverless instance. That matters: a counter
// held in a Vercel function's memory is per-instance, and the platform starts
// as many instances as it likes, so an in-memory "10 per minute" is really
// "10 per minute per instance" and an attacker with concurrency walks past it.
//
// When Upstash is not configured the module falls back to an in-memory
// counter so the service still runs locally and in the lab demo. The fallback
// is honest about what it is: it logs once at startup and is documented in
// docs/cloud-services.md as a development-only approximation.

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DISTRIBUTED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

if (!DISTRIBUTED && process.env.NODE_ENV === 'production') {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'Rate limiting is in-memory only; set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN'
    })
  );
}

// --- in-memory fallback ------------------------------------------------------
const buckets = new Map();

function memoryHit(key, windowSeconds) {
  const now = Date.now();
  const resetAt = Math.ceil(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt !== resetAt) {
    buckets.set(key, { count: 1, resetAt });
    // Opportunistic cleanup: without it the Map grows with every distinct
    // caller for as long as the instance lives.
    if (buckets.size > 10000) {
      for (const [existing, value] of buckets) {
        if (value.resetAt < now) buckets.delete(existing);
      }
    }
    return { count: 1, resetAt };
  }
  bucket.count += 1;
  return { count: bucket.count, resetAt };
}

// --- Upstash -----------------------------------------------------------------
/**
 * INCR the window key and set its expiry in one round trip.
 *
 * EXPIRE ... NX only sets the TTL when the key has none, so the window starts
 * at the first request and is not pushed forward by later ones (which would
 * let a steady stream of requests keep a window open forever).
 */
async function redisHit(key, windowSeconds) {
  const response = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(windowSeconds), 'NX']
    ]),
    signal: AbortSignal.timeout(1500)
  });

  if (!response.ok) {
    throw new Error(`Upstash responded ${response.status}`);
  }
  const results = await response.json();
  const count = Number(results[0]?.result ?? 0);
  return { count, resetAt: Date.now() + windowSeconds * 1000 };
}

/**
 * Who is being limited.
 *
 * A logged-in caller is limited by user id, so one person cannot dodge the
 * limit by changing networks. Anonymous callers are limited by IP, taken from
 * the left-most entry of x-forwarded-for because that is the value Vercel's
 * proxy sets. The header is attacker-controlled in general, which is why it
 * is only ever used for rate limiting and never for access decisions.
 */
function identify(req) {
  if (req.user && req.user.id) return `u:${req.user.id}`;
  const forwarded = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  return `ip:${forwarded || req.ip || 'unknown'}`;
}

/**
 * @param {object} options
 *   limit   requests allowed per window
 *   windowSeconds  length of the window
 *   name    appears in the Redis key, so read and write limits are separate
 */
function rateLimit({ limit = 60, windowSeconds = 60, name = 'default' } = {}) {
  return async function rateLimiter(req, res, next) {
    const window = Math.floor(Date.now() / (windowSeconds * 1000));
    const key = `rl:${name}:${identify(req)}:${window}`;

    let result;
    try {
      result = DISTRIBUTED ? await redisHit(key, windowSeconds) : memoryHit(key, windowSeconds);
    } catch (error) {
      // Fail open. A rate limiter that takes the API down when its own
      // backing store is unreachable has become the outage it was meant to
      // prevent. The event is logged so the gap is visible afterwards.
      console.warn(
        JSON.stringify({
          level: 'warn',
          request_id: res.locals.requestId,
          msg: 'rate limiter unavailable, allowing request',
          error: error.message
        })
      );
      return next();
    }

    const remaining = Math.max(0, limit - result.count);
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((result.resetAt - Date.now()) / 1000)));

    if (result.count > limit) {
      res.setHeader('Retry-After', String(Math.ceil((result.resetAt - Date.now()) / 1000)));
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down and try again shortly.',
          request_id: res.locals.requestId
        }
      });
    }

    return next();
  };
}

module.exports = { rateLimit, isDistributed: DISTRIBUTED };
