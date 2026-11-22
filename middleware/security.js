// Response headers for the API itself.
//
// Lab 5 put security headers on the frontend with vercel.json. That protects
// the page, not the API: an attacker can point a browser straight at
// /api/routes, and a JSON response that the browser is willing to sniff,
// frame or cache is its own small problem. These headers are the API's half.
//
// Written by hand rather than with helmet so each one can be justified in the
// report, and because a dependency that is only setting six headers is a
// supply-chain risk (Lecture 9) for very little gain.

const CORS_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function securityHeaders(req, res, next) {
  // This service only ever answers JSON. Telling the browser that nothing may
  // be loaded, framed or executed from these responses costs nothing and
  // removes a whole class of "the API rendered my HTML" mistakes.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

  // Only meaningful over HTTPS, which is what Vercel serves. Stops a browser
  // that has seen the API once from being downgraded to plain HTTP later.
  if (req.secure || req.get('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Express advertises itself by default. Version banners only help someone
  // looking for a framework with a known CVE.
  res.removeHeader('X-Powered-By');

  // Anything behind a login is private to one user: no shared cache, not the
  // browser's and not the CDN's. Endpoints that are safe to cache override
  // this deliberately (see services cacheControl()).
  if (!CORS_SAFE_METHODS.has(req.method)) {
    res.setHeader('Cache-Control', 'no-store');
  }

  next();
}

/**
 * Reject a body that is not JSON before any handler reads it.
 *
 * Express's json parser simply ignores a body with the wrong Content-Type,
 * which turns a client mistake into a confusing "title is required" instead
 * of the 415 the contract promises.
 */
function requireJsonBody(req, res, next) {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be application/json.',
        request_id: res.locals.requestId
      }
    });
  }
  return next();
}

/** Marks a response as cacheable by the browser and the CDN for `seconds`. */
function cacheControl(res, seconds, { shared = false } = {}) {
  const scope = shared ? 'public' : 'private';
  res.setHeader(
    'Cache-Control',
    `${scope}, max-age=${seconds}, stale-while-revalidate=${seconds * 2}`
  );
}

module.exports = { securityHeaders, requireJsonBody, cacheControl };
