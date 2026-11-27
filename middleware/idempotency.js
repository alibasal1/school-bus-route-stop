// Idempotent writes.
//
// Three things in this system retry: an admin double-clicking "create", the
// browser resending after a timeout, and the scheduled job being invoked
// twice because the first run's answer was lost. Without protection the
// second attempt creates a second route.
//
// A client that sends `Idempotency-Key: <unique string>` gets exactly-once
// behaviour: the first request does the work and its response is stored,
// and any repeat of the same key replays that stored response without
// touching the database again. The same key with a *different* body is a
// client bug and answers 409 rather than returning someone else's result.
//
// The key is scoped to the endpoint and the user, so two people cannot
// collide by picking the same string, and one user's key cannot replay
// another's response.
//
// Stored in DynamoDB with a TTL attribute, so old keys are removed by the
// table itself rather than by a job we would have to remember to run.

const { createHash } = require('crypto');
const { getItem, putItem } = require('../db/dynamo');

const TABLE = `${process.env.TABLE_PREFIX || ''}IdempotencyKeys`;
const MAX_KEY_LENGTH = 100;
// Long enough to cover a retry storm, short enough that the table stays
// small. DynamoDB deletes the item itself once this passes.
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
          request_id: res.locals.requestId,
        },
      });
    }

    const id = `${name}|${req.user?.id ?? 'anonymous'}|${key}`;
    const hash = fingerprint(req.body);

    let stored = null;
    try {
      stored = await getItem(TABLE, { id });
    } catch (error) {
      // A missing table must not break every write. Idempotency is a
      // safety net; losing it is worth a warning, not an outage.
      console.warn(
        JSON.stringify({ level: 'warn', msg: 'idempotency table unreadable', error: error.message })
      );
      return next();
    }

    if (stored) {
      if (stored.request_hash !== hash) {
        return res.status(409).json({
          error: {
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key was already used with a different request body.',
            request_id: res.locals.requestId,
          },
        });
      }
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(stored.status_code).json(stored.response_body);
    }

    // Nothing stored yet: let the handler run, and capture what it answers.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only successful writes are worth replaying. Storing a 400 would pin
      // the caller to its own mistake even after it fixed the body.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        putItem(TABLE, {
          id,
          user_id: req.user?.id ?? null,
          request_hash: hash,
          status_code: res.statusCode,
          response_body: body,
          created_at: new Date().toISOString(),
          expires_at: Math.floor(Date.now() / 1000) + RETENTION_HOURS * 3600,
        }).catch((error) => {
          // The write already succeeded, so this must not fail the request;
          // it only means a retry would repeat the work.
          console.error(
            JSON.stringify({
              level: 'error',
              request_id: res.locals.requestId,
              msg: 'could not store idempotency key',
              error: error.message,
            })
          );
        });
      }
      return originalJson(body);
    };

    return next();
  };
}

module.exports = { idempotent, TABLE, RETENTION_HOURS };
