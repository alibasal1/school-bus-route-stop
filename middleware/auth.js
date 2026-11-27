// Authentication and authorisation.
//
// Login and signup live in Ahmed's service. This service never sees a
// password: it is handed a bearer token and checks it against the shared
// Sessions and Users tables in DynamoDB, which is why all three backends can
// keep their own copy of this file and still agree on who the caller is.
//
// Two separate questions, kept separate on purpose:
//   requireAuth  -> authentication. Who is this? No valid session: 401.
//   requireRole  -> authorisation. May they do this? Wrong role: 403.
// Mixing them produces the classic bug where a logged-in parent is treated
// as an admin because the code only ever asked whether a token was present.

const { createHash, timingSafeEqual } = require('crypto');
const { TABLES, getItem } = require('../db/dynamo');
const { securityLog } = require('./logger');

function sendError(res, status, code, message) {
  const body = { error: { code, message } };
  if (res.locals && res.locals.requestId) body.error.request_id = res.locals.requestId;
  return res.status(status).json(body);
}

/**
 * Sessions are keyed by the SHA-256 hex of the token, never the token.
 *
 * So the table holds nothing anyone can log in with: an attacker who reads
 * every session row still cannot present a valid Authorization header,
 * because a hash cannot be turned back into the token it came from.
 */
function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function bearerToken(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  // A plausible token is a long opaque string. Rejecting obvious junk here
  // means it never costs a DynamoDB read.
  if (token.length < 20 || token.length > 512) return null;
  return token;
}

/** Unix seconds, as Ahmed's sessions store them. */
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      securityLog(req, res, 'auth_missing_token');
      return sendError(res, 401, 'UNAUTHENTICATED', 'Please log in.');
    }

    const session = await getItem(TABLES.SESSIONS, { id: hashToken(token) });

    // expires_at is Unix seconds. A missing session and an expired one get
    // exactly the same answer: saying which it was would tell someone
    // probing with stolen tokens which ones were once real.
    const expired =
      !session || !session.expires_at || Number(session.expires_at) <= nowSeconds();

    if (expired) {
      securityLog(req, res, 'auth_invalid_session');
      return sendError(
        res,
        401,
        'UNAUTHENTICATED',
        'Your session has expired. Please log in again.'
      );
    }

    const user = await getItem(TABLES.USERS, { user_id: session.user_id });
    if (!user) {
      // A session pointing at a user who no longer exists is not a valid
      // login, whatever the session row says.
      securityLog(req, res, 'auth_user_missing', { user_id: session.user_id });
      return sendError(res, 401, 'UNAUTHENTICATED', 'Please log in again.');
    }

    // The role comes from the Users table, never from the request and never
    // from anything the client can influence.
    req.user = {
      id: user.user_id,
      role: user.role,
      name: user.name || user.email || user.user_id,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

const ROLES = ['parent', 'admin', 'supervisor'];

/**
 * Allow only the listed roles.
 *
 * Always used after requireAuth. The !req.user guard is there in case a
 * route is ever wired with requireRole alone, which would otherwise answer
 * 403 to an anonymous caller and hide the fact that the route is unprotected.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 401, 'UNAUTHENTICATED', 'Please log in.');
    }
    if (!roles.includes(req.user.role)) {
      securityLog(req, res, 'authz_role_refused', { role: req.user.role, needed: roles });
      return sendError(res, 403, 'FORBIDDEN', 'You do not have permission to do that.');
    }
    return next();
  };
}

/**
 * Machine-to-machine authentication for /api/internal/*.
 *
 * The scheduled generation has no session. It presents a shared secret held
 * in the platform's encrypted configuration. Compared with timingSafeEqual
 * so the comparison takes the same time whatever the guess, which denies an
 * attacker the byte-by-byte feedback a plain === would leak.
 */
function requireServiceToken(req, res, next) {
  const expected = (process.env.INTERNAL_API_KEY || '').trim();
  if (!expected || expected.length < 32) {
    console.error(JSON.stringify({ level: 'error', msg: 'INTERNAL_API_KEY missing or too short' }));
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Internal endpoints are not configured.');
  }

  if (!equals((req.get('X-Internal-Key') || '').trim(), expected)) {
    securityLog(req, res, 'internal_key_refused');
    return sendError(res, 401, 'UNAUTHENTICATED', 'Invalid internal key.');
  }

  req.user = { id: null, role: 'service', name: 'internal' };
  return next();
}

/**
 * Authentication for the scheduled job.
 *
 * EventBridge invokes the function directly on Floci and sends the internal
 * key in the event's headers. A real API Gateway cron would use
 * Authorization: Bearer with CRON_SECRET instead. Either is accepted, both
 * in constant time, and the route is closed when neither secret is set.
 */
function requireScheduler(req, res, next) {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const internalKey = (process.env.INTERNAL_API_KEY || '').trim();

  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const presentedKey = (req.get('X-Internal-Key') || '').trim();

  const matches =
    (cronSecret.length >= 16 && equals(bearer, cronSecret)) ||
    (internalKey.length >= 32 && equals(presentedKey, internalKey));

  if (!matches) {
    securityLog(req, res, 'scheduler_credential_refused');
    return sendError(res, 401, 'UNAUTHENTICATED', 'Invalid scheduler credential.');
  }

  req.user = { id: null, role: 'service', name: 'scheduler' };
  return next();
}

function equals(presented, expected) {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = {
  ROLES,
  requireAuth,
  requireRole,
  requireServiceToken,
  requireScheduler,
  sendError,
  hashToken,
};
