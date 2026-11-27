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
 * One SECURITY line for a refused request.
 *
 * This is what auth.js and rateLimit.js call when they turn a request away.
 * It exists for two reasons:
 *   1. CloudWatch. infra/deploy.sh puts a metric filter on
 *      { $.event = "SECURITY" } and an alarm above 20 in five minutes, so a
 *      burst of refusals becomes a number on a graph instead of a line
 *      nobody reads.
 *   2. Investigating afterwards. The request id here is the same one the
 *      caller was given in the error body, so a complaint can be traced to
 *      an exact line.
 *
 * The line starts with the word SECURITY so it can also be found with a
 * plain grep, not only with a JSON filter.
 *
 * What goes in: what was refused, where from, and which user if known.
 * What NEVER goes in: the token, the Authorization header, the body, the
 * query string. Lecture 7's point is that logs are themselves sensitive: a
 * log holding a bearer token hands anyone with log access a working login.
 * The user id is safe, because it cannot be used to impersonate anyone.
 *
 * @param {object} req
 * @param {object} res
 * @param {string} reason  short code, e.g. auth_missing_token
 * @param {object} extra   anything else safe to record
 */
function securityLog(req, res, reason, extra = {}) {
  console.warn(
    `SECURITY ${JSON.stringify({
      event: 'SECURITY',
      level: 'warn',
      service: 'route-stop',
      reason,
      method: req.method,
      path: req.path ? req.path.split('?')[0] : null,
      request_id: res.locals ? res.locals.requestId : null,
      status: res.statusCode,
      user_id: req.user ? req.user.id : null,
      ip: req.awsEvent?.requestContext?.http?.sourceIp ?? req.ip ?? null,
      ...extra
    })}`
  );
}

module.exports = logger;
module.exports.logger = logger;
module.exports.requestContext = requestContext;
module.exports.securityLog = securityLog;
