// Tests for authentication and authorisation.
//
// These exist because of a real bug: middleware/auth.js imported
// securityLog from ./logger, logger.js did not export it, and so every
// refused request threw a TypeError inside the catch and came back as
// **500 instead of 401**. The API looked broken and, worse, an auth failure
// was indistinguishable from a server fault.
//
// The Jest API tests cover this too, but they need supertest and the AWS
// SDK installed. These run with nothing but Node, so `npm run test:unit`
// catches the same bug on any machine, including a fresh clone with no
// install yet. That is the point: the cheapest test that would have caught
// it should be the one that always runs.
//
// db/dynamo.js is replaced in the require cache before auth.js is loaded,
// so no AWS SDK is needed either.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

// --- stub the database before anything requires it --------------------------
const dynamoPath = require.resolve('../../db/dynamo');

const TABLES = { USERS: 'Users', SESSIONS: 'Sessions' };
let items = new Map();

require.cache[dynamoPath] = {
  id: dynamoPath,
  filename: dynamoPath,
  loaded: true,
  exports: {
    TABLES,
    INDEXES: {},
    async getItem(table, key) {
      return items.get(`${table}|${Object.values(key)[0]}`) ?? null;
    },
  },
};

const { requireAuth, requireRole, requireServiceToken } = require('../../middleware/auth');

// --- helpers ----------------------------------------------------------------
const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const seconds = () => Math.floor(Date.now() / 1000);

const VALID = 'a-valid-token-at-least-twenty-chars';
const EXPIRED = 'an-expired-token-at-least-twenty-ch';

function reset() {
  items = new Map();
  items.set(`Sessions|${hash(VALID)}`, { id: hash(VALID), user_id: 'user-admin', expires_at: seconds() + 3600 });
  items.set(`Sessions|${hash(EXPIRED)}`, { id: hash(EXPIRED), user_id: 'user-admin', expires_at: seconds() - 60 });
  items.set('Users|user-admin', { id: 'user-admin', role: 'admin', name: 'Admin' });
}

/** A request and response pair close enough to Express for the middleware. */
function fakeReq(authorization) {
  return {
    method: 'GET',
    path: '/api/routes',
    get: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
    ip: '127.0.0.1',
  };
}

function fakeRes() {
  const res = {
    locals: { requestId: 'req-test' },
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

/** Runs a middleware and reports whether it called next() or answered. */
async function run(middleware, req, res) {
  let nextCalled = false;
  let nextError = null;
  await middleware(req, res, (error) => {
    nextCalled = true;
    nextError = error ?? null;
  });
  return { nextCalled, nextError };
}

// Keeps the SECURITY lines out of the test output while still running them,
// so a crash inside securityLog would still fail the test.
function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  return Promise.resolve(fn()).finally(() => {
    console.warn = warn;
  });
}

// ============================================================================

test('no token answers 401, not 500', async () => {
  reset();
  const res = fakeRes();
  const result = await quiet(() => run(requireAuth, fakeReq(undefined), res));

  // The regression: securityLog was missing, it threw, the error reached
  // the catch, next(error) ran, and the error handler turned it into 500.
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  assert.equal(result.nextCalled, false);
});

test('a token that is not a Bearer token answers 401', async () => {
  reset();
  const res = fakeRes();
  await quiet(() => run(requireAuth, fakeReq('Basic abcdefghijklmnopqrst'), res));
  assert.equal(res.statusCode, 401);
});

test('an unknown token answers 401 with the same message as an expired one', async () => {
  reset();

  const unknownRes = fakeRes();
  await quiet(() => run(requireAuth, fakeReq('Bearer this-token-was-never-issued-xx'), unknownRes));

  const expiredRes = fakeRes();
  await quiet(() => run(requireAuth, fakeReq(`Bearer ${EXPIRED}`), expiredRes));

  assert.equal(unknownRes.statusCode, 401);
  assert.equal(expiredRes.statusCode, 401);
  // Identical wording on purpose: a different message would tell someone
  // probing with stolen tokens which ones were once real.
  assert.equal(unknownRes.body.error.message, expiredRes.body.error.message);
});

test('an expired session answers 401 even though the row exists', async () => {
  reset();
  const res = fakeRes();
  await quiet(() => run(requireAuth, fakeReq(`Bearer ${EXPIRED}`), res));
  assert.equal(res.statusCode, 401);
});

test('a session whose user no longer exists answers 401', async () => {
  reset();
  items.delete('Users|user-admin');
  const res = fakeRes();
  await quiet(() => run(requireAuth, fakeReq(`Bearer ${VALID}`), res));
  assert.equal(res.statusCode, 401);
});

test('a valid token sets the user and calls next', async () => {
  reset();
  const req = fakeReq(`Bearer ${VALID}`);
  const res = fakeRes();
  const result = await run(requireAuth, req, res);

  assert.equal(result.nextCalled, true);
  assert.equal(result.nextError, null);
  assert.deepEqual(req.user, { id: 'user-admin', role: 'admin', name: 'Admin' });
});

test('the role comes from the Users table, never from the request', async () => {
  reset();
  // A caller claiming to be an admin in the body or a header changes
  // nothing: the role is read from the table the client cannot write.
  const req = fakeReq(`Bearer ${VALID}`);
  req.body = { role: 'admin' };
  items.set('Users|user-admin', { id: 'user-admin', role: 'parent', name: 'Parent' });

  await run(requireAuth, req, fakeRes());
  assert.equal(req.user.role, 'parent');
});

test('requireRole answers 403 for the wrong role and calls next for the right one', async () => {
  const refused = fakeRes();
  const parentReq = { ...fakeReq(), user: { id: 'u1', role: 'parent' } };
  const refusedResult = await quiet(() => run(requireRole('admin'), parentReq, refused));

  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.error.code, 'FORBIDDEN');
  assert.equal(refusedResult.nextCalled, false);

  const allowed = fakeRes();
  const adminReq = { ...fakeReq(), user: { id: 'u2', role: 'admin' } };
  const allowedResult = await run(requireRole('admin'), adminReq, allowed);
  assert.equal(allowedResult.nextCalled, true);
});

test('requireRole answers 401, not 403, when nobody is signed in', async () => {
  // Guards against a route being wired with requireRole alone: a 403 there
  // would hide the fact that the route is not authenticated at all.
  const res = fakeRes();
  await run(requireRole('admin'), fakeReq(), res);
  assert.equal(res.statusCode, 401);
});

test('the internal endpoint refuses a wrong or missing service key', async () => {
  process.env.INTERNAL_API_KEY = 'k'.repeat(40);

  const wrong = fakeRes();
  const wrongReq = { ...fakeReq(), get: (name) => (name === 'X-Internal-Key' ? 'nope' : undefined) };
  await quiet(() => run(requireServiceToken, wrongReq, wrong));
  assert.equal(wrong.statusCode, 401);

  const right = fakeRes();
  const rightReq = {
    ...fakeReq(),
    get: (name) => (name === 'X-Internal-Key' ? 'k'.repeat(40) : undefined),
  };
  const result = await run(requireServiceToken, rightReq, right);
  assert.equal(result.nextCalled, true);
  assert.equal(rightReq.user.role, 'service');
});

test('the internal endpoint is closed when no key is configured', async () => {
  // Refusing beats defaulting to open when configuration is missing.
  const saved = process.env.INTERNAL_API_KEY;
  delete process.env.INTERNAL_API_KEY;

  const res = fakeRes();
  const req = { ...fakeReq(), get: () => undefined };
  const error = console.error;
  console.error = () => {};
  await run(requireServiceToken, req, res);
  console.error = error;

  assert.equal(res.statusCode, 503);
  process.env.INTERNAL_API_KEY = saved;
});
