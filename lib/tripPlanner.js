// Trip planning: the part of this service that is not CRUD.
//
// Two jobs live here, both written as pure functions over data the caller has
// already loaded. No SQL, no req/res, no clock of their own. That is what
// lets tests/tripPlanner.test.js check the calendar edge cases and the
// double-booking rules directly, and it is why the same planning code can run
// behind an HTTP request or inside a scheduled job without changing.
//
//   planTrips()     decides which trips SHOULD exist over a date range, from
//                   each route's recurring schedule, minus holidays, minus
//                   days that already have a trip.
//   findConflicts() decides whether one proposed trip can be allowed to
//                   exist, given everything else already on the calendar.

const { eachDate, isoDayOfWeek, daysBetween, withinWindow } = require('./dates');

const MAX_GENERATION_DAYS = 120;

// Why a trip was not generated for a given day. Returned to the admin so the
// preview explains itself instead of just showing a shorter list.
const SKIP = {
  NOT_A_SERVICE_DAY: 'not_a_service_day',
  OUTSIDE_WINDOW: 'outside_schedule_window',
  HOLIDAY: 'public_holiday',
  ALREADY_EXISTS: 'trip_already_exists',
  CONFLICT: 'conflict'
};

const CONFLICT = {
  ROUTE_SLOT_TAKEN: 'ROUTE_SLOT_TAKEN',
  BUS_DOUBLE_BOOKED: 'BUS_DOUBLE_BOOKED',
  SUPERVISOR_DOUBLE_BOOKED: 'SUPERVISOR_DOUBLE_BOOKED',
  BUS_ROUTE_MISMATCH: 'BUS_ROUTE_MISMATCH',
  ROUTE_INACTIVE: 'ROUTE_INACTIVE',
  ROUTE_HAS_NO_STOPS: 'ROUTE_HAS_NO_STOPS'
};

/** Key identifying one slot on the calendar. */
function slotKey(routeId, date, runType) {
  return `${routeId}|${date}|${runType}`;
}

/**
 * Check one proposed trip against the rest of the calendar.
 *
 * @param {object} candidate      { routeId, busId, serviceDate, runType }
 * @param {object} context
 *   route         { id, is_active, stop_count }
 *   bus           { id, route_id, supervisor_id } or null
 *   activeTrips   active trips already in the same slot, each
 *                 { id, route_id, bus_id, supervisor_id, service_date, run_type }
 * @returns {Array<{code: string, message: string}>} empty when the trip is allowed
 */
function findConflicts(candidate, context) {
  const { routeId, busId, serviceDate, runType } = candidate;
  const { route, bus, activeTrips = [] } = context;
  const conflicts = [];

  if (route && route.is_active === false) {
    conflicts.push({
      code: CONFLICT.ROUTE_INACTIVE,
      message: 'This route is not active, so no trip can run on it.'
    });
  }

  // A trip with no stops cannot tell a parent anything, and the Schedule &
  // Arrival service has nowhere to hang arrival times. Catching it here is
  // much clearer than an empty timetable appearing in the parent's app.
  if (route && Number(route.stop_count) === 0) {
    conflicts.push({
      code: CONFLICT.ROUTE_HAS_NO_STOPS,
      message: 'Add at least one stop to this route before creating a trip for it.'
    });
  }

  const sameSlot = activeTrips.filter(
    (trip) => trip.service_date === serviceDate && trip.run_type === runType
  );

  if (sameSlot.some((trip) => trip.route_id === routeId)) {
    conflicts.push({
      code: CONFLICT.ROUTE_SLOT_TAKEN,
      message: `This route already has an active ${runType} trip on ${serviceDate}.`
    });
  }

  if (busId) {
    const busClash = sameSlot.find((trip) => trip.bus_id === busId && trip.route_id !== routeId);
    if (busClash) {
      conflicts.push({
        code: CONFLICT.BUS_DOUBLE_BOOKED,
        message: `That bus is already running another ${runType} trip on ${serviceDate}.`
      });
    }

    // The supervisor rides the bus, so two buses sharing a supervisor in the
    // same slot is the same physical impossibility as one bus on two routes.
    // The database cannot express this with a unique index, because the
    // supervisor lives on buses and the slot lives on trips, so it is checked
    // here and the two queries that feed it are in services/routes.js.
    if (bus && bus.supervisor_id) {
      const supervisorClash = sameSlot.find(
        (trip) => trip.bus_id !== busId && trip.supervisor_id === bus.supervisor_id
      );
      if (supervisorClash) {
        conflicts.push({
          code: CONFLICT.SUPERVISOR_DOUBLE_BOOKED,
          message: `That bus's supervisor is already on another ${runType} trip on ${serviceDate}.`
        });
      }
    }

    // A bus permanently assigned to route A should not quietly be sent out on
    // route B; that is nearly always a mistaken id rather than an intention.
    if (bus && bus.route_id && bus.route_id !== routeId) {
      conflicts.push({
        code: CONFLICT.BUS_ROUTE_MISMATCH,
        message: 'That bus is assigned to a different route. Reassign the bus first.'
      });
    }
  }

  return conflicts;
}

/**
 * Work out every trip that should be created across a date range.
 *
 * @param {object} input
 *   from, to      inclusive YYYY-MM-DD bounds
 *   schedules     [{ route_id, run_type, days_of_week, bus_id, active_from, active_to }]
 *   routes        Map of route id -> { id, is_active, stop_count }
 *   buses         Map of bus id -> { id, route_id, supervisor_id }
 *   holidays      Set of YYYY-MM-DD with no school bus
 *   existingTrips active trips already stored in the range
 * @returns {{ trips: Array, skipped: Array, summary: object }}
 */
function planTrips({
  from,
  to,
  schedules = [],
  routes = new Map(),
  buses = new Map(),
  holidays = new Set(),
  existingTrips = []
}) {
  const span = daysBetween(from, to);
  if (span < 0) {
    throw Object.assign(new Error('The end date must not be before the start date.'), {
      code: 'INVALID_RANGE'
    });
  }
  if (span + 1 > MAX_GENERATION_DAYS) {
    throw Object.assign(
      new Error(`A generation run covers at most ${MAX_GENERATION_DAYS} days.`),
      { code: 'RANGE_TOO_LONG' }
    );
  }

  // Trips planned so far count as "already on the calendar" for the runs that
  // follow, otherwise two schedules sharing a bus would both be accepted in
  // the same pass and only collide later at the database.
  const calendar = existingTrips.map((trip) => ({
    ...trip,
    supervisor_id: trip.supervisor_id ?? buses.get(trip.bus_id)?.supervisor_id ?? null
  }));

  const taken = new Set(
    calendar.map((trip) => slotKey(trip.route_id, trip.service_date, trip.run_type))
  );

  const trips = [];
  const skipped = [];
  const dates = eachDate(from, to);

  for (const schedule of schedules) {
    const serviceDays = new Set(schedule.days_of_week);
    const route = routes.get(schedule.route_id);
    const bus = schedule.bus_id ? buses.get(schedule.bus_id) ?? null : null;

    for (const date of dates) {
      if (!withinWindow(date, schedule.active_from, schedule.active_to)) {
        skipped.push({ ...slotOf(schedule, date), reason: SKIP.OUTSIDE_WINDOW });
        continue;
      }
      if (!serviceDays.has(isoDayOfWeek(date))) {
        skipped.push({ ...slotOf(schedule, date), reason: SKIP.NOT_A_SERVICE_DAY });
        continue;
      }
      // Holidays come from the Favorites & Alerts service, which fills them
      // from Calendarific once a year. If that table is empty the generator
      // still runs; it just does not skip anything.
      if (holidays.has(date)) {
        skipped.push({ ...slotOf(schedule, date), reason: SKIP.HOLIDAY });
        continue;
      }
      if (taken.has(slotKey(schedule.route_id, date, schedule.run_type))) {
        skipped.push({ ...slotOf(schedule, date), reason: SKIP.ALREADY_EXISTS });
        continue;
      }

      const candidate = {
        routeId: schedule.route_id,
        busId: schedule.bus_id ?? null,
        serviceDate: date,
        runType: schedule.run_type
      };

      const conflicts = findConflicts(candidate, { route, bus, activeTrips: calendar });
      if (conflicts.length > 0) {
        skipped.push({
          ...slotOf(schedule, date),
          reason: SKIP.CONFLICT,
          conflicts
        });
        continue;
      }

      const planned = {
        route_id: schedule.route_id,
        bus_id: schedule.bus_id ?? null,
        service_date: date,
        run_type: schedule.run_type,
        source: 'generated'
      };
      trips.push(planned);
      calendar.push({
        ...planned,
        id: null,
        status: 'active',
        supervisor_id: bus?.supervisor_id ?? null
      });
      taken.add(slotKey(schedule.route_id, date, schedule.run_type));
    }
  }

  return {
    trips,
    skipped,
    summary: {
      from,
      to,
      days: span + 1,
      schedules: schedules.length,
      planned: trips.length,
      skipped: skipped.length,
      skipped_by_reason: countBy(skipped, 'reason')
    }
  };
}

function slotOf(schedule, date) {
  return { route_id: schedule.route_id, service_date: date, run_type: schedule.run_type };
}

function countBy(items, field) {
  return items.reduce((totals, item) => {
    totals[item[field]] = (totals[item[field]] || 0) + 1;
    return totals;
  }, {});
}

module.exports = {
  MAX_GENERATION_DAYS,
  SKIP,
  CONFLICT,
  slotKey,
  findConflicts,
  planTrips
};
