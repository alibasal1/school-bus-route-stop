// Rate limiting.
//
// The parent-facing search is the one endpoint anyone with a login can call
// as often as they like, and the admin writes are the ones that cost the
// most. Neither should be reachable thousands of times a minute from one
// account: on the Neon free plan a scripted loop exhausts the compute-hour
// budget and takes the whole app down for every family, which is a denial of
// service that costs the attacker nothing.
//
// This is an APPLICATION-level limit, kept even though API Gateway is
// configured with throttling (10 rps, burst 20) in infra/deploy.sh. Floci
// stores the throttle settings but does not enforce them, so on the demo
// machine the only limit that actually fires is this one. On real AWS both
// apply, which is the Lab 8 point about defence in depth: the edge limit
// protects the platform, this one protects the database.
//
// Counters live in Upstash Redis when it is configured, so the limit is
// shared by every Lambda container. Without it the module falls back to an
// in-memory counter, which is per-container and therefore an approximation.

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DISTRIBUTED = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// --- in-memory fallback ------------------------------------------------------
const buckets = new Map();

function memoryHit(key, windowSeconds) {
  const now = Date.now();
  const resetAt = Math.ceil(now / (windowSeconds * 1000)) * windowSeconds * 1000;
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt !== resetAt) {
    buckets.set(key, { count: 1, resetAt });
    // Opportunistic cleanup: without it the Map grows with every distinct
    // caller for as long as the container lives.
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
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(windowSeconds), 'NX'],
    ]),
    signal: AbortSignal.timeout(1500),
  });

  if (!response.ok) throw new Error(`Upstash responded ${response.status}`);
  const results = await response.json();
  return { count: Number(results[0]?.result ?? 0), resetAt: Date.now() + windowSeconds * 1000 };
}

/**
 * The address the limit is counted against.
 *
 * On Lambda this is requestContext.http.sourceIp from the API Gateway event:
 * the address the gateway actually accepted the connection from. It is NOT
 * X-Forwarded-For, which is a header the client writes itself — a caller who
 * sets a new value on every request would get an unlimited budget, which is
 * the same as having no rate limit at all.
 *
 * On a PC there is no event, so req.ip is used; the dev server is not
 * reachable from outside, so there is nothing to spoof.
 */
function clientIp(req) {
  const fromEvent = req.awsEvent?.requestContext?.http?.sourceIp;
  if (fromEvent) return fromEvent;
  return req.ip || 'unknown';
}

/**
 * Who is being limited.
 *
 * A logged-in caller is limited by user id, so one person cannot dodge the
 * limit by changing networks. Everyone else is limited by source address.
 */
function identify(req) {
  if (req.user && req.user.id) return `u:${req.user.id}`;
  return `ip:${clientIp(req)}`;
}

/**
 * @param {object} options
 *   limit          requests allowed per window
 *   windowSeconds  length of the window
 *   name           appears in the key, so read and write limits are separate
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
          error: error.message,
        })
      );
      return next();
    }

    const remaining = Math.max(0, limit - result.count);
    const resetIn = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetIn));

    if (result.count > limit) {
      res.setHeader('Retry-After', String(resetIn));
      // A SECURITY line, so a flood is visible in CloudWatch and can be
      // alarmed on. The address is recorded; no token ever is.
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'SECURITY',
          kind: 'rate_limited',
          request_id: res.locals.requestId,
          bucket: name,
          ip: clientIp(req),
          user_id: req.user?.id ?? null,
          path: req.path,
        })
      );
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down and try again shortly.',
          request_id: res.locals.requestId,
        },
      });
    }

    return next();
  };
}

module.exports = { rateLimit, isDistributed: DISTRIBUTED, clientIp };
