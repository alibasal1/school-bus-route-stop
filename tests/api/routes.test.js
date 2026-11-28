// API tests: the whole stack except AWS.
//
//   npm run test:api
//
// Supertest drives the real Express app, so the routes, the guards, the
// controller, the validation and the service layer all run. Only two things
// are replaced: db/dynamo.js by the in-memory fake, and the SQS client by a
// recorder, so the tests need no Floci and finish in about a second.
//
// What these cover that the unit tests cannot: access control, status
// codes, and the fact that cancelling a trip sends exactly one message.

const request = require('supertest');
const { createHash } = require('crypto');
const { createFakeDynamo } = require('../helpers/fakeDynamo');
const { TABLES } = require('../../db/dynamo');

// --- the SQS recorder --------------------------------------------------------
// Captures every SendMessage instead of talking to a queue, so a test can
// assert on how many messages went out and what was in them.
const sentMessages = [];
jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    async send(command) {
      sentMessages.push(command.input);
      return {};
    }
  },
  SendMessageCommand: class {
    constructor(input) {
      this.input = input;
    }
  },
}));

// --- the database ------------------------------------------------------------
let fake;
jest.mock('../../db/dynamo', () => {
  const actual = jest.requireActual('../../db/dynamo');
  return {
    ...actual,
    getItem: (...args) => global.__fake.getItem(...args),
    putItem: (...args) => global.__fake.putItem(...args),
    updateItem: (...args) => global.__fake.updateItem(...args),
    deleteItem: (...args) => global.__fake.deleteItem(...args),
    queryAll: (...args) => global.__fake.queryAll(...args),
    scanAll: (...args) => global.__fake.scanAll(...args),
    transactWrite: (...args) => global.__fake.transactWrite(...args),
    batchWrite: (...args) => global.__fake.batchWrite(...args),
    ping: (...args) => global.__fake.ping(...args),
  };
});

const app = require('../../app');

// --- test data ---------------------------------------------------------------
const ADMIN_TOKEN = 'admin-token-for-tests-0000000000';
const PARENT_TOKEN = 'parent-token-for-tests-000000000';
const EXPIRED_TOKEN = 'expired-token-for-tests-00000000';

const hash = (token) => createHash('sha256').update(token, 'utf8').digest('hex');
const seconds = () => Math.floor(Date.now() / 1000);

function seed() {
  return {
    [TABLES.USERS]: [
      { id: 'user-admin', role: 'admin', name: 'Admin' },
      { id: 'user-parent', role: 'parent', name: 'Parent One' },
    ],
    [TABLES.SESSIONS]: [
      { id: hash(ADMIN_TOKEN), user_id: 'user-admin', expires_at: seconds() + 3600 },
      { id: hash(PARENT_TOKEN), user_id: 'user-parent', expires_at: seconds() + 3600 },
      // Deliberately in the past.
      { id: hash(EXPIRED_TOKEN), user_id: 'user-parent', expires_at: seconds() - 60 },
    ],
    [TABLES.ROUTES]: [
      { id: 'route-cairo-demo', code: 'R1', name: 'Maadi Morning Line', area: 'Maadi', is_active: true },
      { id: 'route-nasr', code: 'R2', name: 'Nasr City Line', area: 'Nasr City', is_active: true },
    ],
    [TABLES.STOPS]: [
      { id: 'stop-1', route_id: 'route-cairo-demo', name: 'Road 9', stop_order: 1 },
      { id: 'stop-2', route_id: 'route-cairo-demo', name: 'Maadi Club', stop_order: 2 },
      { id: 'stop-3', route_id: 'route-cairo-demo', name: 'School Gate', stop_order: 3 },
    ],
    [TABLES.TRIPS]: [
      {
        id: 'trip:route-cairo-demo:morning',
        route_id: 'route-cairo-demo',
        run_type: 'morning',
        status: 'active',
        cancelled_date: null,
      },
    ],
  };
}

const asAdmin = (req) => req.set('Authorization', `Bearer ${ADMIN_TOKEN}`);
const asParent = (req) => req.set('Authorization', `Bearer ${PARENT_TOKEN}`);

beforeEach(() => {
  fake = createFakeDynamo(seed());
  global.__fake = fake;
  sentMessages.length = 0;
  process.env.INTERNAL_API_KEY = 'x'.repeat(40);
});

// ============================================================================
// Authentication and authorisation
// ============================================================================

describe('access control', () => {
  test('no token is 401', async () => {
    const response = await request(app).get('/api/routes');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  test('an invented token is 401, with the same message as an expired one', async () => {
    const unknown = await request(app)
      .get('/api/routes')
      .set('Authorization', 'Bearer this-token-was-never-issued-aaaa');
    const expired = await request(app)
      .get('/api/routes')
      .set('Authorization', `Bearer ${EXPIRED_TOKEN}`);

    expect(unknown.status).toBe(401);
    expect(expired.status).toBe(401);
    // Identical wording on purpose: a different message would tell an
    // attacker which stolen tokens were once real.
    expect(unknown.body.error.message).toBe(expired.body.error.message);
  });

  test('an expired session is 401 even though the row exists', async () => {
    const response = await request(app)
      .get('/api/routes')
      .set('Authorization', `Bearer ${EXPIRED_TOKEN}`);
    expect(response.status).toBe(401);
  });

  test('a parent may read routes', async () => {
    const response = await asParent(request(app).get('/api/routes'));
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
  });

  test('a parent may NOT create a route', async () => {
    const response = await asParent(request(app).post('/api/routes')).send({
      code: 'R9',
      name: 'Parent Should Not Create This',
      area: 'Maadi',
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test('a parent may NOT cancel a trip', async () => {
    const response = await asParent(
      request(app).patch('/api/trips/trip:route-cairo-demo:morning/status')
    ).send({ status: 'cancelled', reason: 'Not allowed' });
    expect(response.status).toBe(403);
    expect(sentMessages).toHaveLength(0);
  });

  test('the internal endpoint refuses a wrong key', async () => {
    const response = await request(app)
      .post('/api/internal/events/retry')
      .set('X-Internal-Key', 'wrong-key')
      .send({});
    expect(response.status).toBe(401);
  });
});

// ============================================================================
// Input validation
// ============================================================================

describe('validation', () => {
  test('a bad id is 400, not a lookup', async () => {
    const response = await asAdmin(request(app).get("/api/routes/1' OR '1'='1"));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('a NoSQL injection object in an id is 400', async () => {
    const response = await asAdmin(request(app).post('/api/trips')).send({
      route_id: { $ne: null },
      run_type: 'morning',
    });
    expect(response.status).toBe(400);
  });

  test('a short name is 400', async () => {
    const response = await asAdmin(request(app).post('/api/routes')).send({
      code: 'R9',
      name: 'ab',
      area: 'Maadi',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/between 3 and 100/);
  });

  test('a client-chosen id is refused rather than ignored', async () => {
    const response = await asAdmin(request(app).post('/api/routes')).send({
      id: 'HACKED-1',
      code: 'R9',
      name: 'Injected Line',
      area: 'Maadi',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/set by the server/);
  });

  test('the wrong content type is 415', async () => {
    const response = await asAdmin(request(app).post('/api/routes'))
      .set('Content-Type', 'text/plain')
      .send('code=R9');
    expect(response.status).toBe(415);
  });

  test('a path that does not exist is 404 with its own code', async () => {
    const response = await asAdmin(request(app).get('/api/nonsense'));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

// ============================================================================
// Routes and stops
// ============================================================================

describe('routes', () => {
  test('create then list', async () => {
    const created = await asAdmin(request(app).post('/api/routes')).send({
      code: 'r3',
      name: 'Sheikh Zayed Express',
      area: 'Sheikh Zayed',
    });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe('R3'); // normalised to upper case
    expect(created.body.id).toMatch(/^route-/);

    const list = await asAdmin(request(app).get('/api/routes'));
    expect(list.body.total).toBe(3);
  });

  test('a duplicate code is 409', async () => {
    const response = await asAdmin(request(app).post('/api/routes')).send({
      code: 'R1',
      name: 'Another Maadi Line',
      area: 'Maadi',
    });
    expect(response.status).toBe(409);
  });

  test('search ranks an exact code first', async () => {
    const response = await asParent(request(app).get('/api/routes?search=R2'));
    expect(response.body.items[0].code).toBe('R2');
  });

  test('a route with trips cannot be deleted', async () => {
    const response = await asAdmin(request(app).delete('/api/routes/route-cairo-demo'));
    expect(response.status).toBe(409);
    expect(response.body.error.message).toMatch(/Deactivate it instead/);
  });
});

describe('stops', () => {
  test('reordering rewrites the whole sequence', async () => {
    const response = await asAdmin(
      request(app).put('/api/routes/route-cairo-demo/stops/order')
    ).send({ stop_ids: ['stop-3', 'stop-1', 'stop-2'] });

    expect(response.status).toBe(200);
    expect(response.body.stops.map((stop) => stop.id)).toEqual(['stop-3', 'stop-1', 'stop-2']);
    expect(response.body.stops.map((stop) => stop.stop_order)).toEqual([1, 2, 3]);
  });

  test('a partial list is refused and nothing moves', async () => {
    const response = await asAdmin(
      request(app).put('/api/routes/route-cairo-demo/stops/order')
    ).send({ stop_ids: ['stop-1'] });

    expect(response.status).toBe(400);
    const after = await asAdmin(request(app).get('/api/routes/route-cairo-demo'));
    expect(after.body.stops.map((stop) => stop.stop_order)).toEqual([1, 2, 3]);
  });

  test('deleting a middle stop closes the gap', async () => {
    const response = await asAdmin(request(app).delete('/api/stops/stop-2'));
    expect(response.status).toBe(204);

    const after = await asAdmin(request(app).get('/api/routes/route-cairo-demo'));
    expect(after.body.stops.map((stop) => stop.stop_order)).toEqual([1, 2]);
  });

  test('a new stop is appended at the end', async () => {
    const response = await asAdmin(request(app).post('/api/routes/route-cairo-demo/stops')).send({
      name: 'New Corner',
    });
    expect(response.status).toBe(201);
    expect(response.body.stop_order).toBe(4);
  });
});

// ============================================================================
// Trips and the event to Ali's queue
// ============================================================================

describe('trips', () => {
  test('cancelling sends exactly one SQS message, in the agreed shape', async () => {
    const response = await asAdmin(
      request(app).patch('/api/trips/trip:route-cairo-demo:morning/status')
    ).send({ status: 'cancelled', reason: 'Bus 14 is in for repair', date: '2026-11-30' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('cancelled');
    expect(response.body.cancelled_date).toBe('2026-11-30');

    expect(sentMessages).toHaveLength(1);
    const body = JSON.parse(sentMessages[0].MessageBody);
    expect(body.event_type).toBe('trip.cancelled');
    expect(body.route_id).toBe('route-cairo-demo');
    expect(body.trip_id).toBe('trip:route-cairo-demo:morning');
    expect(body.event_id).toEqual(expect.any(String));
    expect(body.occurred_at).toEqual(expect.any(String));
    expect(body.payload).toMatchObject({
      service_date: '2026-11-30',
      run_type: 'morning',
      route_code: 'R1',
      reason: 'Bus 14 is in for repair',
    });
    // Ali filters on this attribute.
    expect(sentMessages[0].MessageAttributes.event_type.StringValue).toBe('trip.cancelled');
  });

  test('cancelling twice is 409 and does not send a second message', async () => {
    const first = await asAdmin(
      request(app).patch('/api/trips/trip:route-cairo-demo:morning/status')
    ).send({ status: 'cancelled', reason: 'First' });
    expect(first.status).toBe(200);

    const second = await asAdmin(
      request(app).patch('/api/trips/trip:route-cairo-demo:morning/status')
    ).send({ status: 'cancelled', reason: 'Second' });

    expect(second.status).toBe(409);
    // One cancellation, one alert. A second message would mean every family
    // is told twice.
    expect(sentMessages).toHaveLength(1);
  });

  test('a cancel needs a reason', async () => {
    const response = await asAdmin(
      request(app).patch('/api/trips/trip:route-cairo-demo:morning/status')
    ).send({ status: 'cancelled' });
    expect(response.status).toBe(400);
    expect(sentMessages).toHaveLength(0);
  });

  test('creating a trip for a route that already has that run is 409', async () => {
    const response = await asAdmin(request(app).post('/api/trips')).send({
      route_id: 'route-cairo-demo',
      run_type: 'morning',
    });
    expect(response.status).toBe(409);
  });

  test('a route with no stops cannot have a trip', async () => {
    const response = await asAdmin(request(app).post('/api/trips')).send({
      route_id: 'route-nasr', // seeded with no stops
      run_type: 'morning',
    });
    expect(response.status).toBe(409);
    expect(response.body.error.details.conflicts[0].code).toBe('ROUTE_HAS_NO_STOPS');
  });

  test('creating a trip sends a trip.created event', async () => {
    await asAdmin(request(app).post('/api/routes/route-nasr/stops')).send({ name: 'Abbas El Akkad' });
    sentMessages.length = 0;

    const response = await asAdmin(request(app).post('/api/trips')).send({
      route_id: 'route-nasr',
      run_type: 'afternoon',
    });

    expect(response.status).toBe(201);
    expect(sentMessages).toHaveLength(1);
    expect(JSON.parse(sentMessages[0].MessageBody).event_type).toBe('trip.created');
  });
});

// ============================================================================
// Health and headers
// ============================================================================

describe('platform', () => {
  test('health needs no login', async () => {
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  test('every response carries the security headers', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    // A version banner only helps someone looking for a known CVE.
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
