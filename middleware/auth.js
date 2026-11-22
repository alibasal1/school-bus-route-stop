// Authentication and authorisation.
//
// Login itself lives in school-bus-schedule-arrival. This service never sees
// a password: it is handed a bearer token and checks it against the shared
// `sessions` table, which is why all three backends can keep their own copy
// of this file and still agree on who the caller is.
//
// Two separate questions, kept separate on purpose (Lecture 9):
//   requireAuth  -> authentication. Who is this? No valid session: 401.
//   requireRole  -> authorisation. May they do this? Wrong role: 403.
// Mixing them produces the classic bug where a logged-in parent is treated
// as an admin because the code only ever asked "is there a token?".

const { createHash, timingSafeEqual } = require('crypto');
const { requireSql } = require('../db');

function sendError(res, status, code, message) {
  const body = { error: { code, message } };
  if (res.locals && res.locals.requestId) body.error.request_id = res.locals.requestId;
  return res.status(status).json(body);
}

/**
 * The database stores a hash of the session token, never the token itself.
 * A leaked database backup then contains nothing anyone can log in with,
 * exactly as with the password hashes next to it.
 */
function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function bearerToken(req) {
  const header = req.get('Authorization') || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  // A plausible token is a long opaque string. Rejecting anything else here
  // keeps obvious junk from reaching the database at all.
  if (token.length < 20 || token.length > 512) return null;
  return token;
}

async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      return sendError(res, 401, 'UNAUTHENTICATED', 'Please log in.');
    }

    const sql = requireSql();
    const rows = await sql`
      SELECT s.user_id,
             s.expires_at,
             u.role,
             u.name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${hashToken(token)}
      LIMIT 1`;

    const session = rows[0];
    // One message for "no such session" and for "expired": telling the
    // caller which one it was only helps someone probing for live tokens.
    if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
      return sendError(res, 401, 'UNAUTHENTICATED', 'Your session has expired. Please log in again.');
    }

    req.user = { id: session.user_id, role: session.role, name: session.name };
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Allow only the listed roles.
 *
 * Always used after requireAuth. The !req.user check is a guard against a
 * route being wired up with requireRole alone, which would otherwise answer
 * 403 for an anonymous caller and hide the fact that the route is unprotected.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 401, 'UNAUTHENTICATED', 'Please log in.');
    }
    if (!roles.includes(req.user.role)) {
      return sendError(res, 403, 'FORBIDDEN', 'You do not have permission to do that.');
    }
    return next();
  };
}

/**
 * Machine-to-machine authentication for /api/internal/*.
 *
 * The scheduled generator and the event forwarder are not people and have no
 * session. They present a shared secret held only in the platform's encrypted
 * environment variables. Compared with timingSafeEqual so that the comparison
 * takes the same time whatever the guess, which denies an attacker the
 * byte-by-byte feedback a plain === would leak.
 */
function requireServiceToken(req, res, next) {
  const expected = (process.env.INTERNAL_API_KEY || '').trim();
  if (!expected || expected.length < 32) {
    // Refusing to run beats defaulting to "open" when the key is missing.
    console.error(JSON.stringify({ level: 'error', msg: 'INTERNAL_API_KEY missing or too short' }));
    return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Internal endpoints are not configured.');
  }

  const presented = (req.get('X-Internal-Key') || '').trim();
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return sendError(res, 401, 'UNAUTHENTICATED', 'Invalid internal key.');
  }

  req.user = { id: null, role: 'service', name: 'internal' };
  return next();
}

/**
 * Authentication for the scheduled job.
 *
 * Vercel Cron can only send a GET, and it signs the call with
 * `Authorization: Bearer $CRON_SECRET` rather than a header we choose. An
 * EventBridge rule or a curl from the lab sends X-Internal-Key instead.
 * Either is accepted, both are compared in constant time, and the route is
 * closed when neither secret is configured.
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
  requireAuth,
  requireRole,
  requireServiceToken,
  requireScheduler,
  sendError,
  hashToken
};
