// Idempotent writes.
//
// Three things in this system retry: an admin double-clicking "create", the
// browser resending after a timeout, and the scheduled generator being run
// twice because the first run's answer was lost. Without protection the
// second attempt creates a second route, or a second month of trips.
//
// A client that sends `Idempotency-Key: <unique string>` gets exactly-once
// behaviour: the first request does the work and its response is stored, and
// any repeat of the same key replays that stored response without touching
// the database again. The same key with a *different* body is a client bug
// and answers 409 rather than silently returning someone else's result.
//
// The key is scoped to the endpoint and the user, so two people cannot
// collide by picking the same string, and one user's key cannot replay
// another's response.

const { createHash } = require('crypto');
const { requireSql } = require('../db');

const MAX_KEY_LENGTH = 100;
// Long enough to cover a retry storm or a cron re-run, short enough that the
// table stays small. Older rows are swept by the maintenance job.
const RETENTION_HOURS = 24;

function fingerprint(body) {
  return createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex');
}

/**
 * @param {string} name stable label for the endpoint, e.g. 'POST /api/routes'
 */
function idempotent(name) {
  return async function idempotency(req, res, next) {
    const key = (req.get('Idempotency-Key') || '').trim();
    if (!key) return next(); // The header is optional; without it, normal behaviour.

    if (key.length > MAX_KEY_LENGTH || !/^[\w.:-]+$/.test(key)) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters of letters, numbers, dot, colon, underscore or hyphen.`,
          request_id: res.locals.requestId
        }
      });
    }

    const sql = requireSql();
    const endpoint = `${name}|${req.user?.id ?? 'anonymous'}`;
    const hash = fingerprint(req.body);

    try {
      const existing = await sql`
        SELECT request_hash, status_code, response_body
        FROM idempotency_keys
        WHERE key = ${key} AND endpoint = ${endpoint}
        LIMIT 1`;

      if (existing[0]) {
        if (existing[0].request_hash !== hash) {
          return res.status(409).json({
            error: {
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'This Idempotency-Key was already used with a different request body.',
              request_id: res.locals.requestId
            }
          });
        }
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(existing[0].status_code).json(existing[0].response_body);
      }
    } catch (error) {
      return next(error);
    }

    // Nothing stored yet: let the handler run, and capture what it answers.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only successful writes are worth replaying. Storing a 400 would pin
      // the caller to its own mistake even after it fixed the body.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        sql`
          INSERT INTO idempotency_keys
            (key, endpoint, user_id, request_hash, status_code, response_body)
          VALUES (${key}, ${endpoint}, ${req.user?.id ?? null}, ${hash},
                  ${res.statusCode}, ${JSON.stringify(body)}::jsonb)
          ON CONFLICT (key, endpoint) DO NOTHING`.catch((error) => {
          // The write itself already succeeded, so this must not fail the
          // request; it only means a retry would repeat the work.
          console.error(
            JSON.stringify({
              level: 'error',
              request_id: res.locals.requestId,
              msg: 'could not store idempotency key',
              error: error.message
            })
          );
        });
      }
      return originalJson(body);
    };

    return next();
  };
}

/** Deletes keys older than the retention window. Called by the maintenance job. */
async function sweepIdempotencyKeys() {
  const sql = requireSql();
  const rows = await sql`
    DELETE FROM idempotency_keys
    WHERE created_at < now() - (${RETENTION_HOURS} || ' hours')::interval
    RETURNING key`;
  return rows.length;
}

module.exports = { idempotent, sweepIdempotencyKeys, RETENTION_HOURS };
