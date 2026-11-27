// Tests for the trip planner: the logic the service is judged on.
//
// Run with `npm test`. No database and no server: planTrips and
// findConflicts are pure functions over data, which is exactly why the
// calendar edge cases below can be checked at all. Testing this through HTTP
// would need a live Neon instance and a month of seeded rows per case.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planTrips, findConflicts, CONFLICT, SKIP } = require('../../lib/tripPlanner');

const ROUTE_A = '11111111-1111-4111-8111-111111111111';
const ROUTE_B = '22222222-2222-4222-8222-222222222222';
const BUS_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BUS_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SUPERVISOR = 'cccccccc-3333-4333-8333-cccccccccccc';

const routes = new Map([
  [ROUTE_A, { id: ROUTE_A, is_active: true, stop_count: 3 }],
  [ROUTE_B, { id: ROUTE_B, is_active: true, stop_count: 2 }]
]);

const buses = new Map([
  [BUS_1, { id: BUS_1, route_id: null, supervisor_id: SUPERVISOR }],
  [BUS_2, { id: BUS_2, route_id: null, supervisor_id: SUPERVISOR }]
]);

/** Sunday-to-Thursday morning run, the normal Egyptian school week. */
function schedule(overrides = {}) {
  return {
    route_id: ROUTE_A,
    run_type: 'morning',
    days_of_week: [7, 1, 2, 3, 4], // Sun, Mon, Tue, Wed, Thu
    bus_id: BUS_1,
    active_from: '2026-01-01',
    active_to: null,
    ...overrides
  };
}

test('generates one trip per service day and skips the weekend', () => {
  // 2026-03-01 is a Sunday, 2026-03-07 a Saturday.
  const plan = planTrips({ from: '2026-03-01', to: '2026-03-07', schedules: [schedule()], routes, buses });

  assert.equal(plan.trips.length, 5);
  assert.deepEqual(
    plan.trips.map((trip) => trip.service_date),
    ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']
  );
  assert.equal(plan.summary.skipped_by_reason[SKIP.NOT_A_SERVICE_DAY], 2); // Fri + Sat
});

test('skips public holidays and says so', () => {
  const plan = planTrips({
    from: '2026-03-01',
    to: '2026-03-05',
    schedules: [schedule()],
    routes,
    buses,
    holidays: new Set(['2026-03-03'])
  });

  assert.equal(plan.trips.length, 4);
  assert.ok(!plan.trips.some((trip) => trip.service_date === '2026-03-03'));
  const holiday = plan.skipped.find((entry) => entry.service_date === '2026-03-03');
  assert.equal(holiday.reason, SKIP.HOLIDAY);
});

test('never creates a second trip for a slot that already has one', () => {
  const plan = planTrips({
    from: '2026-03-01',
    to: '2026-03-02',
    schedules: [schedule()],
    routes,
    buses,
    existingTrips: [
      {
        id: 'existing',
        route_id: ROUTE_A,
        bus_id: BUS_1,
        service_date: '2026-03-01',
        run_type: 'morning',
        supervisor_id: SUPERVISOR
      }
    ]
  });

  assert.equal(plan.trips.length, 1);
  assert.equal(plan.trips[0].service_date, '2026-03-02');
  assert.equal(plan.skipped.find((e) => e.service_date === '2026-03-01').reason, SKIP.ALREADY_EXISTS);
});

test('is idempotent: running the same plan twice adds nothing the second time', () => {
  const input = { from: '2026-03-01', to: '2026-03-05', schedules: [schedule()], routes, buses };
  const first = planTrips(input);

  const second = planTrips({
    ...input,
    existingTrips: first.trips.map((trip) => ({ ...trip, id: 'x', supervisor_id: SUPERVISOR }))
  });

  assert.equal(second.trips.length, 0);
  assert.equal(second.summary.skipped_by_reason[SKIP.ALREADY_EXISTS], 5);
});

test('respects the schedule window', () => {
  const plan = planTrips({
    from: '2026-03-01',
    to: '2026-03-05',
    schedules: [schedule({ active_from: '2026-03-03', active_to: '2026-03-04' })],
    routes,
    buses
  });

  assert.deepEqual(
    plan.trips.map((trip) => trip.service_date),
    ['2026-03-03', '2026-03-04']
  );
});

test('two routes sharing one bus do not both get the same slot', () => {
  // The clash only exists because of the first schedule's own output, so a
  // planner that checked solely against the database would miss it and the
  // insert would fail later with a constraint error.
  const plan = planTrips({
    from: '2026-03-01',
    to: '2026-03-01',
    schedules: [schedule(), schedule({ route_id: ROUTE_B })],
    routes,
    buses
  });

  assert.equal(plan.trips.length, 1);
  const refused = plan.skipped.find((entry) => entry.route_id === ROUTE_B);
  assert.equal(refused.reason, SKIP.CONFLICT);
  assert.equal(refused.conflicts[0].code, CONFLICT.BUS_DOUBLE_BOOKED);
});

test('refuses a range that is inverted or too long', () => {
  assert.throws(() => planTrips({ from: '2026-03-10', to: '2026-03-01', schedules: [] }), /end date/);
  assert.throws(() => planTrips({ from: '2026-01-01', to: '2026-12-31', schedules: [] }), /at most/);
});

test('a leap day is a normal service day', () => {
  // 2028-02-29 is a Tuesday. Date arithmetic that rolled over would drop it.
  const plan = planTrips({
    from: '2028-02-28',
    to: '2028-02-29',
    schedules: [schedule()],
    routes,
    buses
  });
  assert.ok(plan.trips.some((trip) => trip.service_date === '2028-02-29'));
});

// --- findConflicts ----------------------------------------------------------

test('a route with no stops cannot have a trip', () => {
  const conflicts = findConflicts(
    { routeId: ROUTE_A, busId: null, serviceDate: '2026-03-01', runType: 'morning' },
    { route: { id: ROUTE_A, is_active: true, stop_count: 0 }, bus: null, activeTrips: [] }
  );
  assert.equal(conflicts[0].code, CONFLICT.ROUTE_HAS_NO_STOPS);
});

test('an inactive route cannot have a trip', () => {
  const conflicts = findConflicts(
    { routeId: ROUTE_A, busId: null, serviceDate: '2026-03-01', runType: 'morning' },
    { route: { id: ROUTE_A, is_active: false, stop_count: 3 }, bus: null, activeTrips: [] }
  );
  assert.ok(conflicts.some((conflict) => conflict.code === CONFLICT.ROUTE_INACTIVE));
});

test('one supervisor cannot ride two buses in the same slot', () => {
  const conflicts = findConflicts(
    { routeId: ROUTE_A, busId: BUS_1, serviceDate: '2026-03-01', runType: 'morning' },
    {
      route: routes.get(ROUTE_A),
      bus: buses.get(BUS_1),
      activeTrips: [
        {
          id: 'other',
          route_id: ROUTE_B,
          bus_id: BUS_2,
          supervisor_id: SUPERVISOR,
          service_date: '2026-03-01',
          run_type: 'morning'
        }
      ]
    }
  );
  assert.ok(conflicts.some((conflict) => conflict.code === CONFLICT.SUPERVISOR_DOUBLE_BOOKED));
});

test('a bus belonging to another route is refused', () => {
  const conflicts = findConflicts(
    { routeId: ROUTE_A, busId: BUS_1, serviceDate: '2026-03-01', runType: 'morning' },
    {
      route: routes.get(ROUTE_A),
      bus: { id: BUS_1, route_id: ROUTE_B, supervisor_id: null },
      activeTrips: []
    }
  );
  assert.equal(conflicts[0].code, CONFLICT.BUS_ROUTE_MISMATCH);
});

test('the afternoon slot is free even when the morning one is taken', () => {
  const conflicts = findConflicts(
    { routeId: ROUTE_A, busId: BUS_1, serviceDate: '2026-03-01', runType: 'afternoon' },
    {
      route: routes.get(ROUTE_A),
      bus: buses.get(BUS_1),
      activeTrips: [
        {
          id: 'morning',
          route_id: ROUTE_A,
          bus_id: BUS_1,
          supervisor_id: SUPERVISOR,
          service_date: '2026-03-01',
          run_type: 'morning'
        }
      ]
    }
  );
  assert.deepEqual(conflicts, []);
});

test('a cancelled trip frees its slot', () => {
  // cancelTrip removes the trip from the active set, so the planner is only
  // ever given active trips. This documents the assumption.
  const conflicts = findConflicts(
    { routeId: ROUTE_A, busId: BUS_1, serviceDate: '2026-03-01', runType: 'morning' },
    { route: routes.get(ROUTE_A), bus: buses.get(BUS_1), activeTrips: [] }
  );
  assert.deepEqual(conflicts, []);
});
