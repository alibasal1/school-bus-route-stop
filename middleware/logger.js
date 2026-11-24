// Request logging.
//
// One JSON object per request. JSON rather than a sentence because these
// lines land in Vercel Logs (and in CloudWatch when the service runs on
// Lambda), where structured fields can be filtered and alerted on:
// "every 401 in the last hour", "p95 duration by path". A human-readable
// line cannot be queried that way.
//
// What is deliberately NOT logged: request bodies, Authorization headers,
// session tokens, cookies, query strings. Lecture 7 makes the point that logs
// are themselves security-sensitive data; a log that records a bearer token
// hands an attacker with log access a working login. The path is recorded
// with its query string stripped for the same reason.

const { randomUUID } = require('crypto');

/** Attaches a request id and start time before anything else runs. */
function requestContext(req, res, next) {
  // Honour an id from the edge (Vercel sends x-vercel-id) so one request can
  // be followed across the CDN, this service and the database logs.
  const inbound = req.get('x-request-id') || req.get('x-vercel-id');
  const requestId = sanitiseId(inbound) || randomUUID();

  res.locals.requestId = requestId;
  res.locals.startedAt = process.hrtime.bigint();
  res.setHeader('X-Request-Id', requestId);
  next();
}

function sanitiseId(value) {
  if (typeof value !== 'string') return null;
  // An inbound header is untrusted input: cap it and strip anything that
  // could break log parsing or inject a newline into the log stream.
  const cleaned = value.replace(/[^\w.:-]/g, '').slice(0, 64);
  return cleaned || null;
}

function logger(req, res, next) {
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - res.locals.startedAt) / 1e6;
    const line = {
      level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      service: 'route-stop',
      request_id: res.locals.requestId,
      method: req.method,
      path: req.route ? req.baseUrl + req.route.path : req.path.split('?')[0],
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10,
      // Who, not what: the user id is enough to investigate an incident and
      // cannot be used to impersonate anyone, unlike the token itself.
      user_id: req.user ? req.user.id : null,
      role: req.user ? req.user.role : null
    };
    console.log(JSON.stringify(line));
  });
  next();
}

/**
 * A SECURITY line.
 *
 * Refused requests are logged under one fixed word so CloudWatch can filter
 * on it: infra/deploy.sh puts a metric filter on "SECURITY" and an alarm on
 * top of that, so a burst of refusals raises something instead of sitting in
 * a log nobody reads.
 *
 * What goes in: what was refused, where from, and which user if known.
 * What never goes in: tokens, Authorization headers, bodies, secrets.
 */
function securityLog(req, res, kind, extra = {}) {
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'SECURITY',
      kind,
      service: 'route-stop',
      request_id: res.locals?.requestId ?? null,
      method: req.method,
      path: req.path,
      ip: req.awsEvent?.requestContext?.http?.sourceIp ?? req.ip ?? null,
      user_id: req.user?.id ?? null,
      ...extra,
    })
  );
}

module.exports = logger;
module.exports.logger = logger;
module.exports.requestContext = requestContext;
module.exports.securityLog = securityLog;
