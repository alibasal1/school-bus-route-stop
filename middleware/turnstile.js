// Cloudflare Turnstile verification.
//
// Threat 1 in the proposal is automated clients hammering the write
// endpoints. A login already stops anonymous bots, but it does not stop a
// script driving a real account, and the widget on its own stops nothing at
// all: anyone can skip the page and call the API directly with curl. The
// protection is this server-side check. That is the Lab 3 trust boundary
// applied to bot defence: the browser's claim means nothing until the server
// has confirmed it with Cloudflare.
//
// Verified with fetch against Cloudflare's siteverify endpoint, so no npm
// package and no extra supply-chain risk for a single HTTP call.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SECRET = (process.env.TURNSTILE_SECRET_KEY || '').trim();
const ENABLED = Boolean(SECRET);

if (!ENABLED && process.env.NODE_ENV === 'production') {
  console.warn(
    JSON.stringify({ level: 'warn', msg: 'Turnstile disabled: TURNSTILE_SECRET_KEY is not set' })
  );
}

function reject(res, message) {
  return res.status(403).json({
    error: { code: 'BOT_CHECK_FAILED', message, request_id: res.locals.requestId }
  });
}

/**
 * Guard a state-changing endpoint with a Turnstile token.
 *
 * Disabled when no secret is configured, so the service still runs locally
 * and in the Postman tests without a Cloudflare account. The warning above
 * makes that visible in the logs of a production deployment.
 */
let skipLogged = false;

function verifyTurnstile(req, res, next) {
  if (!ENABLED) {
    // Floci has no Turnstile secret, and failing every write there would
    // make the whole service undemonstrable. Skipping is recorded once per
    // container so it is never a silent hole: the log says the control is
    // off, and docs/threat-model.md says the same.
    if (!skipLogged) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'SECURITY',
          kind: 'turnstile_skipped',
          msg: 'TURNSTILE_SECRET_KEY is not set, bot check skipped for all writes',
        })
      );
      skipLogged = true;
    }
    return next();
  }

  const token = req.get('X-Turnstile-Token');
  if (!token) {
    return reject(res, 'Bot check token is missing.');
  }

  const body = new URLSearchParams({ secret: SECRET, response: token });
  // Cloudflare uses the caller's IP as a further signal. x-forwarded-for is
  // attacker-controlled, so it is passed as a hint only; the verdict still
  // comes from the token.
  const ip = (req.get('x-forwarded-for') || '').split(',')[0].trim();
  if (ip) body.set('remoteip', ip);

  fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(3000)
  })
    .then((response) => response.json())
    .then((result) => {
      if (result.success) return next();
      console.warn(
        JSON.stringify({
          level: 'warn',
          request_id: res.locals.requestId,
          msg: 'turnstile rejected',
          codes: result['error-codes']
        })
      );
      // The caller is told it failed, not why: the error codes say whether a
      // token was expired, already spent or forged, which is a map for
      // someone tuning an attack.
      return reject(res, 'Bot check failed. Reload the page and try again.');
    })
    .catch((error) => {
      // Fail closed. Unlike rate limiting, where failing open keeps a working
      // service usable, letting unverified writes through whenever Cloudflare
      // is slow would hand an attacker the way around the control: make the
      // check time out, then write freely.
      console.error(
        JSON.stringify({
          level: 'error',
          request_id: res.locals.requestId,
          msg: 'turnstile verification unavailable',
          error: error.message
        })
      );
      return res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Could not complete the bot check. Please try again.',
          request_id: res.locals.requestId
        }
      });
    });
}

module.exports = { verifyTurnstile, isEnabled: ENABLED };
