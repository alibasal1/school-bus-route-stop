// Route & Stop service layer, on DynamoDB. Owner: Yahia Wael (247330).
//
// Every table access in this service lives in this file. The controller
// above it knows about HTTP and nothing about tables; this layer knows about
// tables and has never seen a req or a res. That separation is what let the
// service move from Neon to DynamoDB without touching a single route or
// controller: only this file and db/ changed.
//
// Two rules hold throughout:
//   1. Values always reach DynamoDB as ExpressionAttributeValues, never
//      pasted into an expression string, for the same reason SQL used bind
//      parameters. Ids are checked against an allow-list first, so an
//      object such as {"$ne": null} is refused before it gets here.
//   2. Anything that has to be all-or-nothing goes through transactWrite.
//      A reorder that half-applies leaves the stops out of sequence.
//
// TRIP OWNERSHIP, agreed with the team and to be confirmed with Ahmed:
// Trips and TripStops use Ahmed's design. A Trip is the recurring run for
// one route and one run type ("R1 morning"), not one row per day. This
// service CREATES and CANCELS trips; Ahmed's service READS them for
// arrivals, and Ali's "next bus" reads them too. Cancelling a single day
// sets cancelled_date, which is why cancel takes a date.

const { randomUUID } = require('crypto');
const {
  TABLES,
  INDEXES,
  getItem,
  putItem,
  updateItem,
  deleteItem,
  queryAll,
  scanAll,
  transactWrite,
  ping,
} = require('../db/dynamo');
const { badRequest, notFound, conflict } = require('../middleware/errors');
const { findConflicts } = require('../lib/tripPlanner');
const resequence = require('../lib/resequence');
const events = require('./events');

const SERVICE_NAME = 'route-stop';

/** Readable ids, in Ahmed's style, rather than raw UUIDs. */
function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 12)}`;
}

function nowIso() {
  return new Date().toISOString();
}

// ============================================================================
// Routes
// ============================================================================

/**
 * Ranked route search.
 *
 * DynamoDB cannot do "contains, ordered by how well it matches", so the
 * search reads the routes and ranks them here. That is honest at this size:
 * one school has a handful of routes, and the whole table is a few kilobytes.
 * If it ever grew, the answer is an OpenSearch index or a search-term
 * attribute, not a bigger scan; see docs/architecture.md.
 *
 * An exact area filter uses the area-index GSI instead, which is a real
 * query and does not read the table.
 */
async function searchRoutes({ search = '', area = '', page = 1, limit = 20, includeInactive = false }) {
  const term = search.trim().toLowerCase();
  const areaTerm = area.trim();

  let routes;
  if (areaTerm) {
    routes = await queryAll({
      TableName: TABLES.ROUTES,
      IndexName: INDEXES.ROUTE_AREA,
      KeyConditionExpression: '#area = :area',
      ExpressionAttributeNames: { '#area': 'area' },
      ExpressionAttributeValues: { ':area': areaTerm },
    });
  } else {
    routes = await scanAll({ TableName: TABLES.ROUTES });
  }

  const scored = routes
    .filter((route) => includeInactive || route.is_active !== false)
    .map((route) => ({ route, score: matchScore(route, term) }))
    .filter((entry) => term === '' || entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.route.code).localeCompare(String(b.route.code)));

  const total = scored.length;
  const start = (page - 1) * limit;
  const items = await Promise.all(
    scored.slice(start, start + limit).map(async ({ route }) => ({
      ...publicRoute(route),
      stop_count: (await listStops(route.id)).length,
    }))
  );

  return { items, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) };
}

/** Exact code first, then code prefix, then name, then area. */
function matchScore(route, term) {
  if (term === '') return 0;
  const code = String(route.code || '').toLowerCase();
  const name = String(route.name || '').toLowerCase();
  const area = String(route.area || '').toLowerCase();
  if (code === term) return 100;
  if (code.startsWith(term)) return 80;
  if (name.startsWith(term)) return 60;
  if (name.includes(term)) return 40;
  if (area.includes(term)) return 20;
  return 0;
}

/** Only the fields the API promises. Nothing internal leaks out. */
function publicRoute(route) {
  return {
    id: route.id,
    code: route.code,
    name: route.name,
    area: route.area,
    is_active: route.is_active !== false,
    created_at: route.created_at,
    updated_at: route.updated_at,
  };
}

async function getRoute(id, { withStops = true } = {}) {
  const route = await getItem(TABLES.ROUTES, { id });
  if (!route) return null;
  if (!withStops) return publicRoute(route);
  return { ...publicRoute(route), stops: await listStops(id) };
}

async function createRoute({ code, name, area }) {
  const normalisedCode = code.trim().toUpperCase();

  // DynamoDB can only guarantee uniqueness on the key, and the key is id,
  // not code. So the duplicate check is a read followed by a conditional
  // write: the read gives a readable 409, and attribute_not_exists(id) on
  // the write is the backstop against two admins saving at the same instant.
  const existing = await scanAll({
    TableName: TABLES.ROUTES,
    FilterExpression: '#code = :code',
    ExpressionAttributeNames: { '#code': 'code' },
    ExpressionAttributeValues: { ':code': normalisedCode },
  });
  if (existing.length > 0) {
    throw conflict(`A route with code ${normalisedCode} already exists.`);
  }

  const route = {
    id: newId('route'),
    code: normalisedCode,
    name: name.trim(),
    area: area.trim(),
    is_active: true,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  await putItem(TABLES.ROUTES, route, {
    ConditionExpression: 'attribute_not_exists(id)',
  });
  return { ...publicRoute(route), stops: [] };
}

async function updateRoute(id, changes) {
  const existing = await getItem(TABLES.ROUTES, { id });
  if (!existing) return null;

  const sets = ['updated_at = :updated'];
  const names = {};
  const values = { ':updated': nowIso() };

  if (changes.code !== undefined) {
    const nextCode = changes.code.trim().toUpperCase();
    if (nextCode !== existing.code) {
      const clash = await scanAll({
        TableName: TABLES.ROUTES,
        FilterExpression: '#code = :code',
        ExpressionAttributeNames: { '#code': 'code' },
        ExpressionAttributeValues: { ':code': nextCode },
      });
      if (clash.length > 0) throw conflict(`A route with code ${nextCode} already exists.`);
    }
    sets.push('#code = :code');
    names['#code'] = 'code';
    values[':code'] = nextCode;
  }
  if (changes.name !== undefined) {
    sets.push('#name = :name');
    names['#name'] = 'name';
    values[':name'] = changes.name.trim();
  }
  if (changes.area !== undefined) {
    sets.push('#area = :area');
    names['#area'] = 'area';
    values[':area'] = changes.area.trim();
  }
  if (changes.is_active !== undefined) {
    sets.push('is_active = :active');
    values[':active'] = Boolean(changes.is_active);
  }

  const updated = await updateItem(TABLES.ROUTES, { id }, {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(id)',
  });

  return { ...publicRoute(updated), stops: await listStops(id) };
}

/**
 * Delete a route.
 *
 * Refused while trips reference it. Deleting would strand trips that
 * Ahmed's service hangs arrival times on and that parents have saved in
 * Ali's My stops: the data would vanish from three services at once with no
 * record of why. Deactivating keeps the history and hides the route from
 * search, which is what "we do not run this any more" actually means.
 */
async function deleteRoute(id) {
  const existing = await getRoute(id, { withStops: false });
  if (!existing) return null;

  const trips = await tripsForRoute(id);
  if (trips.length > 0) {
    throw conflict(
      `This route has ${trips.length} trip(s) and cannot be deleted. Deactivate it instead.`,
      { trip_count: trips.length, hint: 'PUT /api/routes/:id with { "is_active": false }' }
    );
  }

  // Stops are not cascaded by DynamoDB, so they are removed explicitly.
  // Leaving them would be worse than a slow delete: orphan stops still
  // answer a route-id query and would reappear if the id were reused.
  const stops = await listStops(id);
  for (let i = 0; i < stops.length; i += 25) {
    await transactWrite(
      stops.slice(i, i + 25).map((stop) => ({
        Delete: { TableName: TABLES.STOPS, Key: { id: stop.id } },
      }))
    );
  }
  await deleteItem(TABLES.ROUTES, { id });
  return existing;
}

// ============================================================================
// Stops
// ============================================================================

async function listStops(routeId) {
  const stops = await queryAll({
    TableName: TABLES.STOPS,
    IndexName: INDEXES.BY_ROUTE,
    KeyConditionExpression: 'route_id = :route',
    ExpressionAttributeValues: { ':route': routeId },
  });
  return stops
    .map((stop) => ({
      id: stop.id,
      route_id: stop.route_id,
      name: stop.name,
      landmark: stop.landmark ?? null,
      stop_order: Number(stop.stop_order),
      lat: stop.lat ?? null,
      lng: stop.lng ?? null,
    }))
    .sort((a, b) => a.stop_order - b.stop_order);
}

async function getStop(id) {
  const stop = await getItem(TABLES.STOPS, { id });
  if (!stop) return null;
  return { ...stop, stop_order: Number(stop.stop_order) };
}

/**
 * Append a stop, or insert it at `position` and push the rest down.
 *
 * The position is worked out by the server from the stops that exist, never
 * taken from the client, so two admins adding a stop at the same moment
 * cannot both claim position 4.
 */
async function addStop(routeId, { name, landmark = null, position = null, lat = null, lng = null }) {
  const route = await getItem(TABLES.ROUTES, { id: routeId });
  if (!route) return null;

  const stops = await listStops(routeId);
  const target = position === null ? resequence.nextPosition(stops) : position;
  if (target < 1 || target > stops.length + 1) {
    throw badRequest(`Position must be between 1 and ${stops.length + 1}.`);
  }

  const stop = {
    id: newId('stop'),
    route_id: routeId,
    name: name.trim(),
    landmark: landmark ? String(landmark).trim() : null,
    stop_order: target,
    lat,
    lng,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  // Making room and inserting happen together, so a failure cannot leave two
  // stops sharing a position.
  const shifted = stops
    .filter((existing) => existing.stop_order >= target)
    .map((existing) => ({
      Update: {
        TableName: TABLES.STOPS,
        Key: { id: existing.id },
        UpdateExpression: 'SET stop_order = :order, updated_at = :now',
        ExpressionAttributeValues: { ':order': existing.stop_order + 1, ':now': nowIso() },
      },
    }));

  await transactWrite([
    ...shifted,
    { Put: { TableName: TABLES.STOPS, Item: stop, ConditionExpression: 'attribute_not_exists(id)' } },
  ]);

  return stop;
}

async function updateStop(id, { name, landmark }) {
  const existing = await getItem(TABLES.STOPS, { id });
  if (!existing) return null;

  const sets = ['updated_at = :now'];
  const names = {};
  const values = { ':now': nowIso() };

  if (name !== undefined) {
    sets.push('#name = :name');
    names['#name'] = 'name';
    values[':name'] = name.trim();
  }
  if (landmark !== undefined) {
    sets.push('landmark = :landmark');
    values[':landmark'] = landmark === null ? null : String(landmark).trim();
  }

  const updated = await updateItem(TABLES.STOPS, { id }, {
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    ExpressionAttributeValues: values,
    ConditionExpression: 'attribute_exists(id)',
  });
  return { ...updated, stop_order: Number(updated.stop_order) };
}

/** Delete a stop and close the gap it leaves, in one transaction. */
async function deleteStop(id) {
  const stop = await getStop(id);
  if (!stop) return null;

  const stops = await listStops(stop.route_id);
  const changes = resequence.planAfterDelete(stops, id);

  await transactWrite([
    { Delete: { TableName: TABLES.STOPS, Key: { id } } },
    ...reorderItems(changes),
  ]);
  return stop;
}

function reorderItems(changes) {
  return changes.map((change) => ({
    Update: {
      TableName: TABLES.STOPS,
      Key: { id: change.id },
      UpdateExpression: 'SET stop_order = :order, updated_at = :now',
      ExpressionAttributeValues: { ':order': change.stop_order, ':now': nowIso() },
      ConditionExpression: 'attribute_exists(id)',
    },
  }));
}

/**
 * Apply a new ordering for every stop on a route.
 *
 * The whole permutation goes in one TransactWriteItems, so the sequence is
 * never half-applied. This is what replaces the deferrable unique constraint
 * the SQL version relied on: DynamoDB has no such constraint, so the
 * guarantee comes from the transaction plus the fact that only this function
 * is allowed to set stop_order.
 */
async function reorderStops(routeId, { orderedIds, move }) {
  const route = await getItem(TABLES.ROUTES, { id: routeId });
  if (!route) return null;

  const stops = await listStops(routeId);
  if (stops.length === 0) throw badRequest('This route has no stops to reorder.');
  if (stops.length > 100) {
    throw badRequest('A route with more than 100 stops cannot be reordered in one request.');
  }

  const changes = move
    ? resequence.planMove(stops, move.stop_id, move.to_position)
    : resequence.planFullOrder(stops, orderedIds);

  if (changes.length > 0) await transactWrite(reorderItems(changes));

  return { route_id: routeId, moved: changes.length, stops: await listStops(routeId) };
}

// ============================================================================
// Buses
// ============================================================================

async function listBuses() {
  const buses = await scanAll({ TableName: TABLES.BUSES });
  const routes = new Map();
  for (const bus of buses) {
    if (bus.route_id && !routes.has(bus.route_id)) {
      routes.set(bus.route_id, await getItem(TABLES.ROUTES, { id: bus.route_id }));
    }
  }
  return buses
    .map((bus) => ({
      id: bus.id,
      plate_number: bus.plate_number,
      capacity: Number(bus.capacity ?? 40),
      route_id: bus.route_id ?? null,
      supervisor_id: bus.supervisor_id ?? null,
      route_code: routes.get(bus.route_id)?.code ?? null,
    }))
    .sort((a, b) => String(a.plate_number).localeCompare(String(b.plate_number)));
}

async function getBus(id) {
  return getItem(TABLES.BUSES, { id });
}

async function createBus({ plate_number, capacity = 40, route_id = null, supervisor_id = null }) {
  if (route_id && !(await getItem(TABLES.ROUTES, { id: route_id }))) {
    throw notFound('That route does not exist.');
  }
  if (supervisor_id) {
    // Users is read-only for this service. The check is here so the caller
    // gets "that user is not a supervisor" instead of a bus that silently
    // never gets a supervisor.
    const user = await getItem(TABLES.USERS, { user_id: supervisor_id });
    if (!user) throw notFound('That supervisor account does not exist.');
    if (user.role !== 'supervisor') throw badRequest('That user is not a bus supervisor.');
  }

  const plate = plate_number.trim();
  const clash = await scanAll({
    TableName: TABLES.BUSES,
    FilterExpression: 'plate_number = :plate',
    ExpressionAttributeValues: { ':plate': plate },
  });
  if (clash.length > 0) throw conflict(`A bus with plate number ${plate} already exists.`);

  const bus = {
    id: newId('bus'),
    plate_number: plate,
    capacity,
    route_id,
    supervisor_id,
    created_at: nowIso(),
  };
  await putItem(TABLES.BUSES, bus, { ConditionExpression: 'attribute_not_exists(id)' });
  return bus;
}

// ============================================================================
// Schedules (this service owns RouteSchedules)
// ============================================================================

async function listSchedules(routeId = null) {
  if (!routeId) return scanAll({ TableName: TABLES.SCHEDULES });
  return queryAll({
    TableName: TABLES.SCHEDULES,
    IndexName: INDEXES.BY_ROUTE,
    KeyConditionExpression: 'route_id = :route',
    ExpressionAttributeValues: { ':route': routeId },
  });
}

/** One schedule per route per run type, so saving replaces the existing one. */
async function upsertSchedule(routeId, { run_type, days_of_week, bus_id = null, active_from, active_to = null }) {
  if (!(await getItem(TABLES.ROUTES, { id: routeId }))) return null;
  if (bus_id && !(await getBus(bus_id))) throw notFound('That bus does not exist.');

  // A deterministic id is what makes this an upsert rather than a duplicate:
  // saving twice overwrites the same item.
  const schedule = {
    id: `sched:${routeId}:${run_type}`,
    route_id: routeId,
    run_type,
    days_of_week,
    bus_id,
    active_from,
    active_to,
    updated_at: nowIso(),
  };
  await putItem(TABLES.SCHEDULES, schedule);
  return schedule;
}

// ============================================================================
// Trips  (Ahmed's table design)
// ============================================================================

function publicTrip(trip, route) {
  return {
    id: trip.id,
    route_id: trip.route_id,
    bus_id: trip.bus_id ?? null,
    run_type: trip.run_type,
    status: trip.status,
    cancelled_date: trip.cancelled_date ?? null,
    cancellation_reason: trip.cancellation_reason ?? null,
    cancelled_at: trip.cancelled_at ?? null,
    source: trip.source ?? 'manual',
    created_at: trip.created_at,
    route_code: route?.code ?? null,
    route_name: route?.name ?? null,
  };
}

async function tripsForRoute(routeId) {
  return queryAll({
    TableName: TABLES.TRIPS,
    IndexName: INDEXES.BY_ROUTE,
    KeyConditionExpression: 'route_id = :route',
    ExpressionAttributeValues: { ':route': routeId },
  });
}

async function searchTrips({ route_id = null, date = null, status = null, run_type = null, page = 1, limit = 50 }) {
  const trips = route_id ? await tripsForRoute(route_id) : await scanAll({ TableName: TABLES.TRIPS });

  const filtered = trips.filter((trip) => {
    if (status && trip.status !== status) return false;
    if (run_type && trip.run_type !== run_type) return false;
    // A trip is "on" a date unless that is the day it was cancelled.
    if (date && trip.cancelled_date && trip.cancelled_date !== date && status === 'cancelled') {
      return false;
    }
    return true;
  });

  const routes = new Map();
  for (const trip of filtered) {
    if (!routes.has(trip.route_id)) {
      routes.set(trip.route_id, await getItem(TABLES.ROUTES, { id: trip.route_id }));
    }
  }

  const sorted = filtered.sort(
    (a, b) =>
      String(routes.get(a.route_id)?.code ?? '').localeCompare(
        String(routes.get(b.route_id)?.code ?? '')
      ) || String(a.run_type).localeCompare(String(b.run_type))
  );

  const total = sorted.length;
  const start = (page - 1) * limit;
  return {
    items: sorted.slice(start, start + limit).map((trip) => publicTrip(trip, routes.get(trip.route_id))),
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getTrip(id) {
  const trip = await getItem(TABLES.TRIPS, { id });
  if (!trip) return null;
  return publicTrip(trip, await getItem(TABLES.ROUTES, { id: trip.route_id }));
}

/**
 * Everything findConflicts() needs to judge one trip.
 *
 * Loaded here rather than inside the planner, so the planner stays a pure
 * function and can be tested without any AWS client at all.
 */
async function loadSlotContext({ routeId, busId }) {
  const [route, stops, bus, allTrips] = await Promise.all([
    getItem(TABLES.ROUTES, { id: routeId }),
    listStops(routeId),
    busId ? getBus(busId) : Promise.resolve(null),
    scanAll({ TableName: TABLES.TRIPS }),
  ]);

  const buses = new Map();
  const activeTrips = [];
  for (const trip of allTrips) {
    if (trip.status !== 'active') continue;
    if (trip.bus_id && !buses.has(trip.bus_id)) {
      buses.set(trip.bus_id, await getBus(trip.bus_id));
    }
    activeTrips.push({
      id: trip.id,
      route_id: trip.route_id,
      bus_id: trip.bus_id ?? null,
      // The planner compares slots. With Ahmed's recurring trips the slot is
      // the run type, so a constant stands in for the date.
      service_date: 'recurring',
      run_type: trip.run_type,
      supervisor_id: buses.get(trip.bus_id)?.supervisor_id ?? null,
    });
  }

  return {
    route: route ? { ...route, stop_count: stops.length } : null,
    bus,
    activeTrips,
  };
}

/**
 * Create one trip, refusing anything the timetable cannot support.
 *
 * This is the step that makes trip creation more than a write: before any
 * item is stored, the proposed trip is checked against the route's state and
 * every other active trip in the same run, and a clash comes back as 409
 * with the reasons listed.
 */
async function createTrip({ route_id, bus_id = null, run_type, source = 'manual' }) {
  const context = await loadSlotContext({ routeId: route_id, busId: bus_id });
  if (!context.route) throw notFound('That route does not exist.');
  if (bus_id && !context.bus) throw notFound('That bus does not exist.');

  const conflicts = findConflicts(
    { routeId: route_id, busId: bus_id, serviceDate: 'recurring', runType: run_type },
    context
  );
  if (conflicts.length > 0) {
    throw conflict('This trip clashes with the existing timetable.', { conflicts });
  }

  const trip = {
    // Deterministic, so a retry cannot create a second trip for the same
    // route and run. The conditional write below turns a repeat into a 409
    // rather than a silent overwrite.
    id: `trip:${route_id}:${run_type}`,
    route_id,
    bus_id,
    run_type,
    status: 'active',
    cancelled_date: null,
    source,
    created_at: nowIso(),
  };

  try {
    await putItem(TABLES.TRIPS, trip, { ConditionExpression: 'attribute_not_exists(id)' });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw conflict(`This route already has a ${run_type} trip.`);
    }
    throw error;
  }

  await events.publish({
    eventType: events.EVENT_TYPES.TRIP_CREATED,
    routeId: route_id,
    tripId: trip.id,
    payload: {
      service_date: null,
      run_type,
      route_code: context.route.code,
      reason: null,
    },
  });

  return publicTrip(trip, context.route);
}

/**
 * Who is affected if this trip does not run.
 *
 * Reads Ahmed's Students table if it exists. A missing table is a warning,
 * not a failure: knowing who to tell is useful, but it must never be able to
 * block a cancellation.
 */
async function tripImpact(trip) {
  const stops = await listStops(trip.route_id);

  let students = null;
  let parents = null;
  try {
    const all = await scanAll({ TableName: `${process.env.TABLE_PREFIX || ''}Students` });
    const stopIds = new Set(stops.map((stop) => stop.id));
    const affected = all.filter((student) => stopIds.has(student.stop_id));
    students = affected.length;
    parents = new Set(affected.map((student) => student.parent_id)).size;
  } catch (error) {
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'Students table not readable; impact count skipped' })
    );
  }

  return {
    trip_id: trip.id,
    route_id: trip.route_id,
    run_type: trip.run_type,
    stops: stops.map((stop) => ({ id: stop.id, name: stop.name, stop_order: stop.stop_order })),
    stop_count: stops.length,
    affected_students: students,
    affected_parents: parents,
  };
}

/**
 * Cancel a trip for one day, and tell the parents.
 *
 * The item is updated first, then the event is recorded and sent. The order
 * matters: an event for a cancellation that did not happen is worse than a
 * cancellation whose event is retried a minute later.
 *
 * The conditional write is what makes two admins pressing cancel at the same
 * moment safe: the second one fails the condition and gets a 409 instead of
 * sending a second alert to every family.
 */
async function cancelTrip(id, { reason, date, userId }) {
  const stored = await getItem(TABLES.TRIPS, { id });
  if (!stored) return null;
  if (stored.status === 'cancelled') throw conflict('That trip is already cancelled.');

  const route = await getItem(TABLES.ROUTES, { id: stored.route_id });
  const impact = await tripImpact(stored);

  let updated;
  try {
    updated = await updateItem(TABLES.TRIPS, { id }, {
      UpdateExpression:
        'SET #status = :cancelled, cancelled_date = :date, cancellation_reason = :reason, cancelled_at = :now, cancelled_by = :by',
      ConditionExpression: '#status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': 'cancelled',
        ':active': 'active',
        ':date': date,
        ':reason': reason,
        ':now': nowIso(),
        ':by': userId ?? null,
      },
    });
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      throw conflict('That trip was cancelled by someone else a moment ago.');
    }
    throw error;
  }

  const event = await events.publish({
    eventType: events.EVENT_TYPES.TRIP_CANCELLED,
    routeId: stored.route_id,
    tripId: id,
    payload: {
      service_date: date,
      run_type: stored.run_type,
      route_code: route?.code ?? null,
      reason,
    },
  });

  return {
    ...publicTrip(updated, route),
    impact,
    event_id: event.event_id,
    event_delivered: event.delivered,
  };
}

/**
 * Make sure every active route with stops has the trips its schedule says.
 *
 * With Ahmed's recurring trips this is simpler than the per-day version it
 * replaces: one trip per route and run type. It is still not a plain write.
 * It works out what SHOULD exist from the saved schedules, skips what
 * already exists, and refuses anything that would double-book a bus or a
 * supervisor, reporting why in each case.
 *
 * `dryRun` is the default, so an admin always sees the plan before anything
 * is written. The daily EventBridge run calls it with dryRun false.
 */
async function generateTrips({ routeId = null, dryRun = true, userId = null }) {
  const schedules = await listSchedules(routeId);
  const planned = [];
  const skipped = [];

  for (const schedule of schedules) {
    const context = await loadSlotContext({
      routeId: schedule.route_id,
      busId: schedule.bus_id ?? null,
    });

    if (!context.route) {
      skipped.push({ ...slotOf(schedule), reason: 'route_missing' });
      continue;
    }
    const already = context.activeTrips.find(
      (trip) => trip.route_id === schedule.route_id && trip.run_type === schedule.run_type
    );
    if (already) {
      skipped.push({ ...slotOf(schedule), reason: 'trip_already_exists' });
      continue;
    }

    const conflicts = findConflicts(
      {
        routeId: schedule.route_id,
        busId: schedule.bus_id ?? null,
        serviceDate: 'recurring',
        runType: schedule.run_type,
      },
      context
    );
    if (conflicts.length > 0) {
      skipped.push({ ...slotOf(schedule), reason: 'conflict', conflicts });
      continue;
    }

    planned.push({
      route_id: schedule.route_id,
      bus_id: schedule.bus_id ?? null,
      run_type: schedule.run_type,
      days_of_week: schedule.days_of_week,
    });
  }

  const summary = {
    schedules: schedules.length,
    planned: planned.length,
    skipped: skipped.length,
    skipped_by_reason: skipped.reduce((totals, entry) => {
      totals[entry.reason] = (totals[entry.reason] || 0) + 1;
      return totals;
    }, {}),
  };

  if (dryRun) return { trips: planned, skipped, summary, created: 0, dry_run: true };

  const created = [];
  for (const plan of planned) {
    try {
      created.push(await createTrip({ ...plan, source: 'generated' }));
    } catch (error) {
      // One bad route must not stop the rest of the run, which matters most
      // for the scheduled job: nobody is watching it.
      skipped.push({
        route_id: plan.route_id,
        run_type: plan.run_type,
        reason: 'conflict',
        conflicts: error.details?.conflicts ?? [{ code: 'ERROR', message: error.message }],
      });
    }
  }

  return {
    trips: planned,
    skipped,
    summary: { ...summary, created: created.length },
    created: created.length,
    created_trips: created,
    dry_run: false,
  };
}

function slotOf(schedule) {
  return { route_id: schedule.route_id, run_type: schedule.run_type };
}

// ============================================================================
// Audit
// ============================================================================

/**
 * Record a state-changing action.
 *
 * Written to the log rather than to a table: CloudWatch is already the place
 * the SECURITY lines go and is where the metric filter and alarm read from,
 * and one AUDIT line per admin action is enough to answer "who cancelled a
 * month of trips". Never allowed to fail the request it describes.
 */
function recordAudit({ userId, role, action, resourceType, resourceId, statusCode, requestId }) {
  try {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'AUDIT',
        service: SERVICE_NAME,
        user_id: userId ?? null,
        role: role ?? null,
        action,
        resource_type: resourceType,
        resource_id: resourceId ? String(resourceId) : null,
        status: statusCode,
        request_id: requestId,
        at: nowIso(),
      })
    );
  } catch {
    // An audit line must never break the action it is describing.
  }
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
  recordAudit,
  ping,
};
