// Route & Stop service layer. Owner: Yahia Wael (247330).
//
// Every SQL statement in this service lives in this file. The controller
// above it knows about HTTP and nothing about tables; this layer knows about
// tables and has never seen a req or a res. That is the separation Lab 3
// asks for, and it is what made it possible to move the Cloud Issue Tracker
// from a JSON file to Postgres without touching a route or a controller.
//
// Two rules hold throughout:
//   1. Values always reach Postgres as bind parameters via sql`...${value}`.
//      No statement is built by joining strings, so no input can change the
//      shape of a query.
//   2. Anything that has to be all-or-nothing goes through transaction().
//      A reorder that half-applies leaves the stops out of sequence; a
//      cancellation whose event is lost leaves parents waiting at the kerb.

const { requireSql, transaction } = require('../db');
const { badRequest, notFound, conflict } = require('../middleware/errors');
const { findConflicts, planTrips } = require('../lib/tripPlanner');
const resequence = require('../lib/resequence');

const SERVICE_NAME = 'route-stop';

// Postgres DATE columns come back as JavaScript Date objects, which would be
// serialised with a time and a timezone the value never had. Every query
// below therefore formats dates with to_char(..., 'YYYY-MM-DD'), so a
// calendar day stays a calendar day all the way to the client.

/** Escapes the LIKE metacharacters so a search for "100%" is a literal search. */
function likeLiteral(value) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// ============================================================================
// Routes
// ============================================================================

/**
 * Ranked route search.
 *
 * The proposal promises "search by name or area". A plain ILIKE gives that
 * but orders the answers arbitrarily, so a parent typing "R-01" can find the
 * exact route below three partial matches. Scoring the match and ordering by
 * the score puts an exact code first, then a code prefix, then a name, then
 * an area, which is the order a person expects.
 */
async function searchRoutes({ search = '', area = '', page = 1, limit = 20, includeInactive = false }) {
  const sql = requireSql();
  const term = search.trim().toLowerCase();
  const pattern = `%${likeLiteral(term)}%`;
  const prefix = `${likeLiteral(term)}%`;
  const areaTerm = area.trim().toLowerCase();
  const offset = (page - 1) * limit;

  const rows = await sql`
    SELECT r.id,
           r.code,
           r.name,
           r.area,
           r.is_active,
           COUNT(s.id)::int AS stop_count,
           (COUNT(*) OVER ())::int AS total_count,
           CASE
             WHEN ${term}::text = '' THEN 0
             WHEN lower(r.code) = ${term}::text THEN 100
             WHEN lower(r.code) LIKE ${prefix} ESCAPE '\\' THEN 80
             WHEN lower(r.name) LIKE ${prefix} ESCAPE '\\' THEN 60
             WHEN lower(r.name) LIKE ${pattern} ESCAPE '\\' THEN 40
             WHEN lower(r.area) LIKE ${pattern} ESCAPE '\\' THEN 20
             ELSE 0
           END AS match_score
    FROM routes r
    LEFT JOIN stops s ON s.route_id = r.id
    WHERE (${includeInactive}::boolean OR r.is_active = TRUE)
      AND (${areaTerm}::text = '' OR lower(r.area) = ${areaTerm}::text)
      AND (
        ${term}::text = ''
        OR lower(r.code) LIKE ${pattern} ESCAPE '\\'
        OR lower(r.name) LIKE ${pattern} ESCAPE '\\'
        OR lower(r.area) LIKE ${pattern} ESCAPE '\\'
      )
    GROUP BY r.id
    ORDER BY match_score DESC, r.code ASC
    LIMIT ${limit} OFFSET ${offset}`;

  const total = rows.length > 0 ? rows[0].total_count : 0;
  return {
    items: rows.map(({ total_count, match_score, ...route }) => route),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit))
  };
}

async function getRoute(id, { withStops = true } = {}) {
  const sql = requireSql();
  const routes = await sql`
    SELECT id, code, name, area, is_active, created_at, updated_at
    FROM routes WHERE id = ${id} LIMIT 1`;
  if (!routes[0]) return null;

  if (!withStops) return routes[0];
  const stops = await listStops(id);
  return { ...routes[0], stops };
}

async function createRoute({ code, name, area }) {
  const sql = requireSql();
  try {
    const rows = await sql`
      INSERT INTO routes (code, name, area)
      VALUES (${code.trim().toUpperCase()}, ${name.trim()}, ${area.trim()})
      RETURNING id, code, name, area, is_active, created_at, updated_at`;
    return { ...rows[0], stops: [] };
  } catch (error) {
    // 23505 is unique_violation. Turning it into a readable 409 is better
    // than a 500, and better than checking first: checking first still races
    // with another admin saving the same code a millisecond later.
    if (error.code === '23505') {
      throw conflict(`A route with code ${code.trim().toUpperCase()} already exists.`);
    }
    throw error;
  }
}

/** Partial update: only the fields present in `changes` are written. */
async function updateRoute(id, changes) {
  const sql = requireSql();
  const existing = await getRoute(id, { withStops: false });
  if (!existing) return null;

  // COALESCE with a null-able parameter keeps this a single static statement
  // instead of a dynamically assembled SET clause.
  const next = {
    code: changes.code === undefined ? null : changes.code.trim().toUpperCase(),
    name: changes.name === undefined ? null : changes.name.trim(),
    area: changes.area === undefined ? null : changes.area.trim(),
    is_active: changes.is_active === undefined ? null : Boolean(changes.is_active)
  };

  try {
    const rows = await sql`
      UPDATE routes
      SET code       = COALESCE(${next.code}, code),
          name       = COALESCE(${next.name}, name),
          area       = COALESCE(${next.area}, area),
          is_active  = COALESCE(${next.is_active}, is_active),
          updated_at = now()
      WHERE id = ${id}
      RETURNING id, code, name, area, is_active, created_at, updated_at`;
    return { ...rows[0], stops: await listStops(id) };
  } catch (error) {
    if (error.code === '23505') {
      throw conflict(`A route with code ${next.code} already exists.`);
    }
    throw error;
  }
}

/**
 * Delete a route.
 *
 * Refused while trips reference it. Deleting would cascade away trips that
 * the Schedule & Arrival service has already hung arrival times on and that
 * parents have in their saved stops: the data would vanish from three
 * services at once with no record of why. Deactivating keeps the history and
 * hides the route from search, which is what "we do not run this any more"
 * actually means.
 */
async function deleteRoute(id) {
  const sql = requireSql();
  const existing = await getRoute(id, { withStops: false });
  if (!existing) return null;

  const [{ trip_count }] = await sql`
    SELECT COUNT(*)::int AS trip_count FROM trips WHERE route_id = ${id}`;
  if (trip_count > 0) {
    throw conflict(
      `This route has ${trip_count} trip(s) in its history and cannot be deleted. Deactivate it instead.`,
      { trip_count, hint: 'PUT /api/routes/:id with { "is_active": false }' }
    );
  }

  await sql`DELETE FROM routes WHERE id = ${id}`;
  return existing;
}

// ============================================================================
// Stops
// ============================================================================

async function listStops(routeId) {
  const sql = requireSql();
  return sql`
    SELECT id, route_id, name, landmark, stop_order
    FROM stops WHERE route_id = ${routeId}
    ORDER BY stop_order ASC`;
}

async function getStop(id) {
  const sql = requireSql();
  const rows = await sql`
    SELECT id, route_id, name, landmark, stop_order FROM stops WHERE id = ${id} LIMIT 1`;
  return rows[0] || null;
}

/**
 * Append a stop, or insert it at `position` and push the rest down.
 *
 * The position is chosen by the server from the stops that exist, never
 * taken from the client, so two admins adding a stop at the same moment
 * cannot both claim position 4.
 */
async function addStop(routeId, { name, landmark = null, position = null }) {
  const sql = requireSql();
  const route = await getRoute(routeId, { withStops: false });
  if (!route) return null;

  const stops = await listStops(routeId);
  const target = position === null ? resequence.nextPosition(stops) : position;
  if (target < 1 || target > stops.length + 1) {
    throw badRequest(`Position must be between 1 and ${stops.length + 1}.`);
  }

  const inserted = await transaction([
    // Make room: everything at or after the target moves down one. Safe
    // because the unique constraint on (route_id, stop_order) is DEFERRABLE,
    // so the momentarily duplicated positions are only checked at COMMIT.
    sql`UPDATE stops SET stop_order = stop_order + 1, updated_at = now()
        WHERE route_id = ${routeId} AND stop_order >= ${target}`,
    sql`INSERT INTO stops (route_id, name, landmark, stop_order)
        VALUES (${routeId}, ${name.trim()}, ${landmark ? landmark.trim() : null}, ${target})
        RETURNING id, route_id, name, landmark, stop_order`
  ]);

  return inserted[1][0];
}

async function updateStop(id, { name, landmark }) {
  const sql = requireSql();
  const rows = await sql`
    UPDATE stops
    SET name       = COALESCE(${name === undefined ? null : name.trim()}, name),
        landmark   = CASE WHEN ${landmark === undefined} THEN landmark
                          ELSE ${landmark === null ? null : String(landmark).trim()} END,
        updated_at = now()
    WHERE id = ${id}
    RETURNING id, route_id, name, landmark, stop_order`;
  return rows[0] || null;
}

/** Delete a stop and close the gap it leaves, in one transaction. */
async function deleteStop(id) {
  const sql = requireSql();
  const stop = await getStop(id);
  if (!stop) return null;

  const stops = await listStops(stop.route_id);
  const changes = resequence.planAfterDelete(stops, id);

  await transaction([
    sql`DELETE FROM stops WHERE id = ${id}`,
    ...buildReorderStatements(sql, stop.route_id, changes)
  ]);

  return stop;
}

/**
 * Apply a new ordering for every stop on a route.
 *
 * The whole permutation is written in a single UPDATE driven by unnest, so
 * the statement stays static (no SQL assembled from the request) and the
 * DEFERRABLE constraint sees one consistent state at COMMIT.
 */
function buildReorderStatements(sql, routeId, changes) {
  if (changes.length === 0) return [];
  const ids = changes.map((change) => change.id);
  const orders = changes.map((change) => change.stop_order);
  return [
    sql`
      UPDATE stops AS s
      SET stop_order = v.ord, updated_at = now()
      FROM (
        SELECT * FROM unnest(${ids}::uuid[], ${orders}::int[]) AS t(id, ord)
      ) AS v
      WHERE s.id = v.id AND s.route_id = ${routeId}`
  ];
}

async function reorderStops(routeId, { orderedIds, move }) {
  const sql = requireSql();
  const route = await getRoute(routeId, { withStops: false });
  if (!route) return null;

  const stops = await listStops(routeId);
  if (stops.length === 0) {
    throw badRequest('This route has no stops to reorder.');
  }

  const changes = move
    ? resequence.planMove(stops, move.stop_id, move.to_position)
    : resequence.planFullOrder(stops, orderedIds);

  if (changes.length > 0) {
    await transaction(buildReorderStatements(sql, routeId, changes));
  }

  return { route_id: routeId, moved: changes.length, stops: await listStops(routeId) };
}

// ============================================================================
// Buses
// ============================================================================

async function listBuses() {
  const sql = requireSql();
  return sql`
    SELECT b.id, b.plate_number, b.capacity, b.route_id, b.supervisor_id,
           r.code AS route_code
    FROM buses b
    LEFT JOIN routes r ON r.id = b.route_id
    ORDER BY b.plate_number`;
}

async function getBus(id) {
  const sql = requireSql();
  const rows = await sql`
    SELECT id, plate_number, capacity, route_id, supervisor_id FROM buses WHERE id = ${id} LIMIT 1`;
  return rows[0] || null;
}

async function createBus({ plate_number, capacity = 40, route_id = null, supervisor_id = null }) {
  const sql = requireSql();

  // Checked here rather than relying on the foreign key so the caller gets
  // "that route does not exist" instead of a constraint name.
  if (route_id && !(await getRoute(route_id, { withStops: false }))) {
    throw notFound('That route does not exist.');
  }
  if (supervisor_id) {
    const supervisors = await sql`
      SELECT id, role FROM users WHERE id = ${supervisor_id} LIMIT 1`;
    if (!supervisors[0]) throw notFound('That supervisor account does not exist.');
    if (supervisors[0].role !== 'supervisor') {
      throw badRequest('That user is not a bus supervisor.');
    }
  }

  try {
    const rows = await sql`
      INSERT INTO buses (plate_number, capacity, route_id, supervisor_id)
      VALUES (${plate_number.trim()}, ${capacity}, ${route_id}, ${supervisor_id})
      RETURNING id, plate_number, capacity, route_id, supervisor_id, created_at`;
    return rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw conflict(`A bus with plate number ${plate_number.trim()} already exists.`);
    }
    throw error;
  }
}

// ============================================================================
// Schedules  (the recurring pattern trip generation reads)
// ============================================================================

async function listSchedules(routeId = null) {
  const sql = requireSql();
  return sql`
    SELECT s.id, s.route_id, s.run_type, s.days_of_week, s.bus_id,
           to_char(s.active_from, 'YYYY-MM-DD') AS active_from,
           to_char(s.active_to,   'YYYY-MM-DD') AS active_to
    FROM route_schedules s
    WHERE (${routeId}::uuid IS NULL OR s.route_id = ${routeId})
    ORDER BY s.route_id, s.run_type`;
}

/** One schedule per route per run type, so saving replaces the existing one. */
async function upsertSchedule(routeId, { run_type, days_of_week, bus_id = null, active_from, active_to = null }) {
  const sql = requireSql();
  if (!(await getRoute(routeId, { withStops: false }))) return null;
  if (bus_id && !(await getBus(bus_id))) throw notFound('That bus does not exist.');

  const rows = await sql`
    INSERT INTO route_schedules (route_id, run_type, days_of_week, bus_id, active_from, active_to)
    VALUES (${routeId}, ${run_type}, ${days_of_week}::smallint[], ${bus_id},
            ${active_from}::date, ${active_to}::date)
    ON CONFLICT ON CONSTRAINT route_schedules_one_per_run DO UPDATE
      SET days_of_week = EXCLUDED.days_of_week,
          bus_id       = EXCLUDED.bus_id,
          active_from  = EXCLUDED.active_from,
          active_to    = EXCLUDED.active_to,
          updated_at   = now()
    RETURNING id, route_id, run_type, days_of_week, bus_id,
              to_char(active_from, 'YYYY-MM-DD') AS active_from,
              to_char(active_to,   'YYYY-MM-DD') AS active_to`;
  return rows[0];
}

// ============================================================================
// Trips
// ============================================================================

const TRIP_COLUMNS = `
  t.id, t.route_id, t.bus_id,
  to_char(t.service_date, 'YYYY-MM-DD') AS service_date,
  t.run_type, t.status, t.cancellation_reason, t.cancelled_at, t.source, t.created_at`;

async function searchTrips({
  route_id = null,
  date = null,
  from = null,
  to = null,
  status = null,
  run_type = null,
  page = 1,
  limit = 50
}) {
  const sql = requireSql();
  const offset = (page - 1) * limit;

  const rows = await sql`
    SELECT t.id, t.route_id, t.bus_id,
           to_char(t.service_date, 'YYYY-MM-DD') AS service_date,
           t.run_type, t.status, t.cancellation_reason, t.cancelled_at, t.source,
           r.code AS route_code, r.name AS route_name, r.area AS route_area,
           b.plate_number,
           (COUNT(*) OVER ())::int AS total_count
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    LEFT JOIN buses b ON b.id = t.bus_id
    WHERE (${route_id}::uuid IS NULL OR t.route_id = ${route_id})
      AND (${date}::date   IS NULL OR t.service_date = ${date}::date)
      AND (${from}::date   IS NULL OR t.service_date >= ${from}::date)
      AND (${to}::date     IS NULL OR t.service_date <= ${to}::date)
      AND (${status}::text IS NULL OR t.status = ${status})
      AND (${run_type}::text IS NULL OR t.run_type = ${run_type})
    ORDER BY t.service_date ASC, t.run_type ASC, r.code ASC
    LIMIT ${limit} OFFSET ${offset}`;

  const total = rows.length > 0 ? rows[0].total_count : 0;
  return {
    items: rows.map(({ total_count, ...trip }) => trip),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit))
  };
}

async function getTrip(id) {
  const sql = requireSql();
  const rows = await sql`
    SELECT t.id, t.route_id, t.bus_id,
           to_char(t.service_date, 'YYYY-MM-DD') AS service_date,
           t.run_type, t.status, t.cancellation_reason, t.cancelled_at, t.source, t.created_at,
           r.code AS route_code, r.name AS route_name
    FROM trips t
    JOIN routes r ON r.id = t.route_id
    WHERE t.id = ${id}
    LIMIT 1`;
  return rows[0] || null;
}

/**
 * Everything findConflicts() needs to judge one slot.
 *
 * Loaded in one query per concern rather than inside the planner, so the
 * planner itself stays pure and testable.
 */
async function loadSlotContext({ routeId, busId, dates }) {
  const sql = requireSql();

  const [routes, buses, activeTrips] = await Promise.all([
    sql`
      SELECT r.id, r.is_active, COUNT(s.id)::int AS stop_count
      FROM routes r LEFT JOIN stops s ON s.route_id = r.id
      WHERE r.id = ${routeId}
      GROUP BY r.id`,
    busId
      ? sql`SELECT id, route_id, supervisor_id FROM buses WHERE id = ${busId}`
      : Promise.resolve([]),
    sql`
      SELECT t.id, t.route_id, t.bus_id,
             to_char(t.service_date, 'YYYY-MM-DD') AS service_date,
             t.run_type, b.supervisor_id
      FROM trips t
      LEFT JOIN buses b ON b.id = t.bus_id
      WHERE t.status = 'active'
        AND t.service_date = ANY(${dates}::date[])`
  ]);

  return { route: routes[0] || null, bus: buses[0] || null, activeTrips };
}

/**
 * Create one trip, refusing anything the calendar cannot support.
 *
 * This is the step that makes trip creation more than an INSERT: before any
 * row is written the proposed trip is checked against the route's state and
 * every other active trip in the same slot, and a clash comes back as 409
 * with the reasons listed, not as a database error.
 */
async function createTrip({ route_id, bus_id = null, service_date, run_type }) {
  const sql = requireSql();
  const context = await loadSlotContext({ routeId: route_id, busId: bus_id, dates: [service_date] });
  if (!context.route) throw notFound('That route does not exist.');
  if (bus_id && !context.bus) throw notFound('That bus does not exist.');

  const conflicts = findConflicts(
    { routeId: route_id, busId: bus_id, serviceDate: service_date, runType: run_type },
    context
  );
  if (conflicts.length > 0) {
    throw conflict('This trip clashes with the existing timetable.', { conflicts });
  }

  try {
    const result = await transaction([
      sql`
        INSERT INTO trips (route_id, bus_id, service_date, run_type, source)
        VALUES (${route_id}, ${bus_id}, ${service_date}::date, ${run_type}, 'manual')
        RETURNING id, route_id, bus_id,
                  to_char(service_date, 'YYYY-MM-DD') AS service_date,
                  run_type, status, source, created_at`,
      sql`
        INSERT INTO route_events (event_type, route_id, payload)
        VALUES ('trip.created', ${route_id},
                ${JSON.stringify({ service_date, run_type, bus_id })}::jsonb)`
    ]);
    return result[0][0];
  } catch (error) {
    // The unique constraints are the backstop for two admins saving at the
    // same instant, after both passed the check above.
    if (error.code === '23505') {
      throw conflict('Another trip was created for this slot a moment ago. Reload and try again.');
    }
    throw error;
  }
}

/**
 * Who is affected if this trip does not run.
 *
 * Reads the Schedule & Arrival service's `students` table, which this service
 * never writes. If that table does not exist yet (the three schemas can be
 * applied in any order during development) the count comes back null rather
 * than failing the cancellation: knowing who to tell is useful, but it must
 * not be able to block the cancellation itself.
 */
async function tripImpact(trip) {
  const sql = requireSql();
  const stops = await listStops(trip.route_id);

  let affectedStudents = null;
  try {
    const rows = await sql`
      SELECT COUNT(DISTINCT st.id)::int AS students,
             COUNT(DISTINCT st.parent_id)::int AS parents
      FROM students st
      WHERE st.stop_id = ANY(${stops.map((stop) => stop.id)}::uuid[])`;
    affectedStudents = rows[0];
  } catch (error) {
    if (error.code !== '42P01') throw error; // 42P01 = undefined_table
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'students table not present; impact count skipped' })
    );
  }

  return {
    trip_id: trip.id,
    route_id: trip.route_id,
    service_date: trip.service_date,
    run_type: trip.run_type,
    stops: stops.map((stop) => ({ id: stop.id, name: stop.name, stop_order: stop.stop_order })),
    stop_count: stops.length,
    affected_students: affectedStudents ? affectedStudents.students : null,
    affected_parents: affectedStudents ? affectedStudents.parents : null
  };
}

/**
 * Cancel a trip and record the event that tells parents.
 *
 * The status change and the outbox row are written in one transaction. If
 * the alerts service is down, the event simply waits in route_events until
 * the forwarder picks it up; it can never be lost, and the cancellation can
 * never succeed silently with nobody informed. That is the whole reason this
 * is not a direct HTTP call to Ali's service.
 */
async function cancelTrip(id, { reason, userId }) {
  const sql = requireSql();
  const trip = await getTrip(id);
  if (!trip) return null;
  if (trip.status === 'cancelled') {
    throw conflict('That trip is already cancelled.');
  }

  const impact = await tripImpact(trip);

  const result = await transaction([
    sql`
      UPDATE trips
      SET status = 'cancelled',
          cancellation_reason = ${reason},
          cancelled_at = now(),
          cancelled_by = ${userId}
      WHERE id = ${id} AND status = 'active'
      RETURNING id, route_id, bus_id,
                to_char(service_date, 'YYYY-MM-DD') AS service_date,
                run_type, status, cancellation_reason, cancelled_at`,
    sql`
      INSERT INTO route_events (event_type, route_id, trip_id, payload)
      VALUES ('trip.cancelled', ${trip.route_id}, ${id},
              ${JSON.stringify({
                service_date: trip.service_date,
                run_type: trip.run_type,
                route_code: trip.route_code,
                reason,
                stop_ids: impact.stops.map((stop) => stop.id),
                affected_students: impact.affected_students
              })}::jsonb)
      RETURNING id`
  ]);

  const updated = result[0][0];
  if (!updated) {
    // The WHERE ... AND status = 'active' guard lost a race with another
    // admin cancelling the same trip.
    throw conflict('That trip was cancelled by someone else a moment ago.');
  }

  return { ...updated, impact, event_id: result[1][0].id };
}

/**
 * Generate the trips a date range should contain.
 *
 * This is the function the whole service is built around. Instead of an
 * admin creating one trip per route per day by hand (roughly 40 forms a week
 * for three routes), they describe the pattern once in route_schedules and
 * this expands it: skipping non-service days, skipping public holidays taken
 * from the Favorites & Alerts service, skipping days that already have a
 * trip, and refusing anything that would double-book a bus or a supervisor.
 *
 * `dryRun` returns the plan without writing, so the admin sees exactly what
 * would be created and why each skipped day was skipped before committing.
 */
async function generateTrips({ from, to, routeId = null, dryRun = false, userId = null }) {
  const sql = requireSql();

  const [schedules, routeRows, busRows, holidays, existingTrips] = await Promise.all([
    sql`
      SELECT id, route_id, run_type, days_of_week, bus_id,
             to_char(active_from, 'YYYY-MM-DD') AS active_from,
             to_char(active_to,   'YYYY-MM-DD') AS active_to
      FROM route_schedules
      WHERE (${routeId}::uuid IS NULL OR route_id = ${routeId})`,
    sql`
      SELECT r.id, r.is_active, COUNT(s.id)::int AS stop_count
      FROM routes r LEFT JOIN stops s ON s.route_id = r.id
      GROUP BY r.id`,
    sql`SELECT id, route_id, supervisor_id FROM buses`,
    loadHolidays(from, to),
    sql`
      SELECT t.id, t.route_id, t.bus_id,
             to_char(t.service_date, 'YYYY-MM-DD') AS service_date,
             t.run_type, b.supervisor_id
      FROM trips t
      LEFT JOIN buses b ON b.id = t.bus_id
      WHERE t.status = 'active'
        AND t.service_date BETWEEN ${from}::date AND ${to}::date`
  ]);

  const plan = planTrips({
    from,
    to,
    schedules,
    routes: new Map(routeRows.map((route) => [route.id, route])),
    buses: new Map(busRows.map((bus) => [bus.id, bus])),
    holidays,
    existingTrips
  });

  if (dryRun || plan.trips.length === 0) {
    return { ...plan, created: 0, dry_run: dryRun };
  }

  const routeIds = plan.trips.map((trip) => trip.route_id);
  const busIds = plan.trips.map((trip) => trip.bus_id);
  const dates = plan.trips.map((trip) => trip.service_date);
  const runTypes = plan.trips.map((trip) => trip.run_type);

  // One bulk INSERT rather than a loop: a month of trips for three routes is
  // ~60 rows, and 60 round trips to Neon from a serverless function is slow
  // enough to hit the function timeout. ON CONFLICT DO NOTHING makes the
  // whole run safe to retry after a timeout, alongside the Idempotency-Key.
  const result = await transaction([
    sql`
      INSERT INTO trips (route_id, bus_id, service_date, run_type, source)
      SELECT t.route_id, t.bus_id, t.service_date, t.run_type, 'generated'
      FROM unnest(${routeIds}::uuid[], ${busIds}::uuid[], ${dates}::date[], ${runTypes}::text[])
           AS t(route_id, bus_id, service_date, run_type)
      ON CONFLICT DO NOTHING
      RETURNING id, route_id,
                to_char(service_date, 'YYYY-MM-DD') AS service_date,
                run_type`,
    sql`
      INSERT INTO route_events (event_type, payload)
      VALUES ('trips.generated',
              ${JSON.stringify({ from, to, route_id: routeId, planned: plan.trips.length, by: userId })}::jsonb)`
  ]);

  const created = result[0];
  return { ...plan, created: created.length, created_trips: created, dry_run: false };
}

/**
 * Public holidays for the range, read from the Favorites & Alerts service.
 *
 * Tolerant by design: during development that service's schema may not be
 * applied yet, and the generator should still work, just without skipping
 * holidays. A missing table is logged, not thrown.
 */
async function loadHolidays(from, to) {
  const sql = requireSql();
  try {
    const rows = await sql`
      SELECT to_char(date, 'YYYY-MM-DD') AS date
      FROM holidays
      WHERE date BETWEEN ${from}::date AND ${to}::date`;
    return new Set(rows.map((row) => row.date));
  } catch (error) {
    if (error.code !== '42P01') throw error;
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'holidays table not present; generating without it' })
    );
    return new Set();
  }
}

// ============================================================================
// Outbox and audit
// ============================================================================

/** Events the forwarder has not yet pushed to SNS. */
async function pendingEvents(limit = 100) {
  const sql = requireSql();
  return sql`
    SELECT id, event_type, route_id, trip_id, payload, occurred_at, attempts
    FROM route_events
    WHERE published_at IS NULL
    ORDER BY occurred_at ASC
    LIMIT ${limit}`;
}

async function markEventsPublished(ids) {
  const sql = requireSql();
  const rows = await sql`
    UPDATE route_events SET published_at = now()
    WHERE id = ANY(${ids}::uuid[]) AND published_at IS NULL
    RETURNING id`;
  return rows.length;
}

async function markEventFailed(id, message) {
  const sql = requireSql();
  await sql`
    UPDATE route_events
    SET attempts = attempts + 1, last_error = ${String(message).slice(0, 500)}
    WHERE id = ${id}`;
}

/**
 * Record a state-changing action.
 *
 * Written after the response is decided, and never allowed to fail the
 * request: an audit write that breaks a cancellation would mean the safest
 * thing the admin can do is avoid the audited action.
 */
async function recordAudit({ userId, role, action, resourceType, resourceId, statusCode, requestId }) {
  try {
    const sql = requireSql();
    await sql`
      INSERT INTO audit_log
        (service, user_id, user_role, action, resource_type, resource_id, status_code, request_id)
      VALUES (${SERVICE_NAME}, ${userId}, ${role}, ${action}, ${resourceType},
              ${resourceId ? String(resourceId) : null}, ${statusCode}, ${requestId})`;
  } catch (error) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'audit write failed', error: error.message })
    );
  }
}

/** Used by /api/ready: proves the service can actually reach its database. */
async function ping() {
  const sql = requireSql();
  const rows = await sql`SELECT 1 AS ok`;
  return rows[0].ok === 1;
}

module.exports = {
  searchRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  listStops,
  getStop,
  addStop,
  updateStop,
  deleteStop,
  reorderStops,
  listBuses,
  getBus,
  createBus,
  listSchedules,
  upsertSchedule,
  searchTrips,
  getTrip,
  createTrip,
  cancelTrip,
  tripImpact,
  generateTrips,
  pendingEvents,
  markEventsPublished,
  markEventFailed,
  recordAudit,
  ping
};
