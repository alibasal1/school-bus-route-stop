// Route & Stop controller. Owner: Yahia Wael (247330).
//
// The controller is the trust boundary. Everything arriving here came from
// outside the application and is untrusted, however it was sent: through our
// own React page, through Postman, or through a script. Frontend validation
// is a convenience for the user; these checks are the ones that count.
//
// Each handler does the same four things in the same order:
//   1. validate the request and answer 400 if it is wrong
//   2. call exactly one service function
//   3. turn the answer, or its absence, into a status code
//   4. record the action in the audit log when it changed something
// It never writes SQL, and the service it calls never sees req or res.

const service = require('../services/routes');
const validate = require('../lib/validate');
const { badRequest, notFound, asyncHandler } = require('../middleware/errors');
const { cacheControl } = require('../middleware/security');
const { today } = require('../lib/dates');
const events = require('../services/events');

/** Rejects a body that is not a JSON object, which would make every field undefined. */
function body(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw badRequest('Request body must be a JSON object.');
  }
  return req.body;
}

function fail(problem) {
  if (problem) throw badRequest(problem);
}

/**
 * Page and limit from the query string.
 *
 * limit is capped. Without a cap, `?limit=1000000` is a cheap way to make the
 * database build an enormous result set, which is a denial of service that
 * costs the caller one request.
 */
function pagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const limit = Number.parseInt(query.limit ?? String(defaultLimit), 10);
  if (!Number.isInteger(page) || page < 1 || page > 10000) {
    throw badRequest('page must be a whole number between 1 and 10000.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw badRequest(`limit must be a whole number between 1 and ${maxLimit}.`);
  }
  return { page, limit };
}

function audit(req, res, action, resourceType, resourceId) {
  return service.recordAudit({
    userId: req.user?.id ?? null,
    role: req.user?.role ?? null,
    action,
    resourceType,
    resourceId,
    statusCode: res.statusCode,
    requestId: res.locals.requestId
  });
}

// ============================================================================
// Routes
// ============================================================================

// GET /api/routes
const listRoutes = asyncHandler(async (req, res) => {
  const { page, limit } = pagination(req.query);
  const search = String(req.query.search ?? '');
  const area = String(req.query.area ?? '');
  if (search.length > 100 || area.length > 100) {
    throw badRequest('Search terms must be 100 characters or fewer.');
  }

  const result = await service.searchRoutes({
    search,
    area,
    page,
    limit,
    // Only an admin has any use for retired routes, and showing them to
    // parents would mean offering a bus that does not run.
    includeInactive: req.user.role === 'admin' && req.query.include_inactive === 'true'
  });

  // The route list changes a few times a term and is read by every parent on
  // every page load. A short private cache takes that traffic off the Neon
  // free tier without risking a parent seeing a stale timetable for long.
  cacheControl(res, 60);
  res.status(200).json(result);
});

// GET /api/routes/:id
const getRoute = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Route id'));
  const route = await service.getRoute(req.params.id);
  if (!route) throw notFound('That route does not exist.');
  cacheControl(res, 60);
  res.status(200).json(route);
});

// POST /api/routes
const createRoute = asyncHandler(async (req, res) => {
  const input = body(req);
  fail(validate.rejectServerOwnedFields(input, ['id', 'created_at', 'updated_at']));
  fail(
    validate.first(
      validate.routeCode(input.code),
      validate.text(input.name, 'Route name', 3, 100),
      validate.text(input.area, 'Area', 2, 100)
    )
  );

  const route = await service.createRoute(input);
  res.status(201).location(`/api/routes/${route.id}`).json(route);
  await audit(req, res, 'route.create', 'route', route.id);
});

// PUT /api/routes/:id
const updateRoute = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Route id'));
  const input = body(req);
  fail(validate.rejectServerOwnedFields(input, ['id', 'created_at', 'updated_at']));

  if (input.code !== undefined) fail(validate.routeCode(input.code));
  if (input.name !== undefined) fail(validate.text(input.name, 'Route name', 3, 100));
  if (input.area !== undefined) fail(validate.text(input.area, 'Area', 2, 100));
  if (input.is_active !== undefined && typeof input.is_active !== 'boolean') {
    fail('is_active must be true or false.');
  }
  if (['code', 'name', 'area', 'is_active'].every((field) => input[field] === undefined)) {
    fail('Send at least one of code, name, area or is_active.');
  }

  const route = await service.updateRoute(req.params.id, input);
  if (!route) throw notFound('That route does not exist.');
  res.status(200).json(route);
  await audit(req, res, 'route.update', 'route', route.id);
});

// DELETE /api/routes/:id
const deleteRoute = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Route id'));
  const route = await service.deleteRoute(req.params.id);
  if (!route) throw notFound('That route does not exist.');
  res.status(204).end();
  await audit(req, res, 'route.delete', 'route', req.params.id);
});

// ============================================================================
// Stops
// ============================================================================

// POST /api/routes/:id/stops
const addStop = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Route id'));
  const input = body(req);
  fail(validate.rejectServerOwnedFields(input, ['id', 'route_id', 'stop_order']));
  fail(
    validate.first(
      validate.text(input.name, 'Stop name', 3, 100),
      validate.text(input.landmark, 'Landmark', 3, 150, { required: false })
    )
  );
  if (input.position !== undefined) {
    fail(validate.positiveInteger(input.position, 'Position', 200));
  }

  const stop = await service.addStop(req.params.id, {
    name: input.name,
    landmark: input.landmark ?? null,
    position: input.position ?? null
  });
  if (!stop) throw notFound('That route does not exist.');
  res.status(201).json(stop);
  await audit(req, res, 'stop.create', 'stop', stop.id);
});

// PUT /api/stops/:id
const updateStop = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Stop id'));
  const input = body(req);
  // stop_order is deliberately not accepted here. Changing one stop's number
  // in isolation is what produces gaps and duplicates; ordering goes through
  // the reorder endpoint, which rewrites the whole sequence atomically.
  fail(validate.rejectServerOwnedFields(input, ['id', 'route_id', 'stop_order']));
  if (input.name !== undefined) fail(validate.text(input.name, 'Stop name', 3, 100));
  if (input.landmark !== undefined && input.landmark !== null) {
    fail(validate.text(input.landmark, 'Landmark', 3, 150));
  }
  if (input.name === undefined && input.landmark === undefined) {
    fail('Send at least one of name or landmark.');
  }

  const stop = await service.updateStop(req.params.id, input);
  if (!stop) throw notFound('That stop does not exist.');
  res.status(200).json(stop);
  await audit(req, res, 'stop.update', 'stop', stop.id);
});

// DELETE /api/stops/:id
const deleteStop = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Stop id'));
  const stop = await service.deleteStop(req.params.id);
  if (!stop) throw notFound('That stop does not exist.');
  res.status(204).end();
  await audit(req, res, 'stop.delete', 'stop', req.params.id);
});

// PUT /api/routes/:id/stops/order
const reorderStops = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Route id'));
  const input = body(req);

  const hasOrder = Array.isArray(input.stop_ids);
  const hasMove = input.move && typeof input.move === 'object';
  if (hasOrder === hasMove) {
    fail('Send either stop_ids (the full new order) or move ({ stop_id, to_position }).');
  }

  if (hasOrder) {
    if (input.stop_ids.length > 200) fail('A route cannot have more than 200 stops.');
    for (const id of input.stop_ids) fail(validate.id(id, 'Stop id'));
  } else {
    fail(
      validate.first(
        validate.id(input.move.stop_id, 'Stop id'),
        validate.positiveInteger(input.move.to_position, 'Position', 200)
      )
    );
  }

  const result = await service.reorderStops(req.params.id, {
    orderedIds: hasOrder ? input.stop_ids : null,
    move: hasMove ? input.move : null
  });
  if (!result) throw notFound('That route does not exist.');
  res.status(200).json(result);
  await audit(req, res, 'stop.reorder', 'route', req.params.id);
});

// ============================================================================
// Buses
// ============================================================================

// GET /api/buses
const listBuses = asyncHandler(async (req, res) => {
  res.status(200).json({ items: await service.listBuses() });
});

// POST /api/buses
const createBus = asyncHandler(async (req, res) => {
  const input = body(req);
  fail(validate.rejectServerOwnedFields(input, ['id', 'created_at']));
  fail(
    validate.first(
      validate.plateNumber(input.plate_number),
      validate.optionalId(input.route_id, 'Route id'),
      validate.optionalId(input.supervisor_id, 'Supervisor id')
    )
  );
  if (input.capacity !== undefined) {
    fail(validate.positiveInteger(input.capacity, 'Capacity', 100));
  }

  const bus = await service.createBus({
    plate_number: input.plate_number,
    capacity: input.capacity ?? 40,
    route_id: input.route_id ?? null,
    supervisor_id: input.supervisor_id ?? null
  });
  res.status(201).location(`/api/buses/${bus.id}`).json(bus);
  await audit(req, res, 'bus.create', 'bus', bus.id);
});

// ============================================================================
// Schedules
// ============================================================================

// GET /api/routes/:id/schedule
const listSchedules = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Route id'));
  res.status(200).json({ items: await service.listSchedules(req.params.id) });
});

// PUT /api/routes/:id/schedule
const upsertSchedule = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Route id'));
  const input = body(req);
  fail(
    validate.first(
      validate.runType(input.run_type),
      validate.daysOfWeek(input.days_of_week),
      validate.optionalId(input.bus_id, 'Bus id'),
      validate.isoDate(input.active_from, 'active_from'),
      input.active_to == null ? null : validate.isoDate(input.active_to, 'active_to')
    )
  );
  if (input.active_to && input.active_to < input.active_from) {
    fail('active_to must not be before active_from.');
  }

  const schedule = await service.upsertSchedule(req.params.id, {
    run_type: input.run_type,
    days_of_week: input.days_of_week,
    bus_id: input.bus_id ?? null,
    active_from: input.active_from,
    active_to: input.active_to ?? null
  });
  if (!schedule) throw notFound('That route does not exist.');
  res.status(200).json(schedule);
  await audit(req, res, 'schedule.upsert', 'route', req.params.id);
});

// ============================================================================
// Trips
// ============================================================================

// GET /api/trips
const listTrips = asyncHandler(async (req, res) => {
  const { page, limit } = pagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const query = req.query;

  if (query.route_id !== undefined) fail(validate.id(query.route_id, 'route_id'));
  if (query.date !== undefined) fail(validate.isoDate(query.date, 'date'));
  if (query.status !== undefined) fail(validate.tripStatus(query.status));
  if (query.run_type !== undefined) fail(validate.runType(query.run_type));

  const result = await service.searchTrips({
    route_id: query.route_id ?? null,
    date: query.date ?? null,
    status: query.status ?? null,
    run_type: query.run_type ?? null,
    page,
    limit
  });
  cacheControl(res, 30);
  res.status(200).json(result);
});

// GET /api/trips/:id
const getTrip = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Trip id'));
  const trip = await service.getTrip(req.params.id);
  if (!trip) throw notFound('That trip does not exist.');
  res.status(200).json(trip);
});

// POST /api/trips
const createTrip = asyncHandler(async (req, res) => {
  const input = body(req);
  fail(
    validate.rejectServerOwnedFields(input, [
      'id',
      'status',
      'created_at',
      'cancelled_at',
      'cancelled_date'
    ])
  );
  fail(
    validate.first(
      validate.id(input.route_id, 'Route id'),
      validate.optionalId(input.bus_id, 'Bus id'),
      validate.runType(input.run_type)
    )
  );

  // A trip is the recurring run for one route and one run type, in Ahmed's
  // table design. There is no per-day trip to date, so no service_date here;
  // the date only appears when a single day is cancelled.
  const trip = await service.createTrip({
    route_id: input.route_id,
    bus_id: input.bus_id ?? null,
    run_type: input.run_type
  });
  res.status(201).location(`/api/trips/${trip.id}`).json(trip);
  await audit(req, res, 'trip.create', 'trip', trip.id);
});

// GET /api/trips/:id/impact
const tripImpact = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Trip id'));
  const trip = await service.getTrip(req.params.id);
  if (!trip) throw notFound('That trip does not exist.');
  res.status(200).json(await service.tripImpact(trip));
});

// PATCH /api/trips/:id/status
const cancelTrip = asyncHandler(async (req, res) => {
  fail(validate.id(req.params.id, 'Trip id'));
  const input = body(req);
  fail(validate.tripStatus(input.status));

  // Cancelling is the only status change this service offers. Un-cancelling
  // would silently re-book a bus that has since been given to another route,
  // so the admin creates a fresh trip instead and the history stays honest.
  if (input.status !== 'cancelled') {
    fail('Only "cancelled" is supported. To run a trip again, create a new one.');
  }
  fail(validate.text(input.reason, 'Reason', 3, 200));

  // Which day is being cancelled. Ahmed's Trips table records this in
  // cancelled_date, and it is what the parents' alert says. Defaults to
  // today, which is what "the bus is not running" almost always means.
  const date = input.date ?? today();
  fail(validate.isoDate(date, 'date'));

  const result = await service.cancelTrip(req.params.id, {
    reason: input.reason.trim(),
    date,
    userId: req.user.id
  });
  if (!result) throw notFound('That trip does not exist.');
  res.status(200).json(result);
  await audit(req, res, 'trip.cancel', 'trip', req.params.id);
});

// POST /api/trips/generate
const generateTrips = asyncHandler(async (req, res) => {
  const input = body(req);
  fail(validate.optionalId(input.route_id, 'Route id'));
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') {
    fail('dry_run must be true or false.');
  }

  const result = await service.generateTrips({
    routeId: input.route_id ?? null,
    // Default to a preview. Writing has to be asked for explicitly, so an
    // admin always sees what would be created, and why each schedule was
    // skipped, before anything happens.
    dryRun: input.dry_run !== false,
    userId: req.user.id ?? null
  });

  res.status(result.dry_run ? 200 : 201).json(result);
  if (!result.dry_run) {
    await audit(req, res, 'trip.generate', 'route', input.route_id ?? 'all');
  }
});

// GET /api/internal/cron/generate
//
// The daily scheduled run, called by EventBridge. Separate from the admin
// endpoint because it must never be a preview: its whole purpose is to
// write. It also sweeps any event whose SQS send failed earlier, so a queue
// that was briefly unreachable does not cost anyone their alert.
const cronGenerateTrips = asyncHandler(async (req, res) => {
  const result = await service.generateTrips({ dryRun: false, userId: null });
  const sweep = await events.retryUnsent({ limit: 50 });

  // One line per run, so a scheduled job that has quietly stopped working
  // is visible in CloudWatch without anyone opening the app.
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'scheduled trip generation',
      request_id: res.locals.requestId,
      planned: result.summary.planned,
      created: result.created,
      events_retried: sweep.retried,
      events_delivered: sweep.delivered
    })
  );

  res.status(200).json({ created: result.created, summary: result.summary, events: sweep });
  await audit(req, res, 'trip.generate.scheduled', 'route', 'all');
});

// POST /api/internal/events/retry
//
// Resend anything still unsent. The cron does this too; having it as an
// endpoint means a failed delivery can be pushed through during the demo
// without waiting for tomorrow.
const retryEvents = asyncHandler(async (req, res) => {
  res.status(200).json(await events.retryUnsent({ limit: 50 }));
});

// ============================================================================
// Health
// ============================================================================

// GET /api/health  — liveness: is the function running at all?
const health = (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'route-stop',
    environment: process.env.NODE_ENV || 'development',
    runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : process.env.VERCEL ? 'vercel' : 'pc'
  });
};

// GET /api/ready — readiness: can it actually reach the database?
// Separating the two is what makes a deployment diagnosable: health up and
// ready down means the code shipped fine and the tables or the IAM role are wrong.
const ready = asyncHandler(async (req, res) => {
  try {
    await service.ping();
    res.status(200).json({ status: 'ready', database: 'reachable' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', msg: 'readiness failed', error: error.message }));
    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The database is not reachable.',
        request_id: res.locals.requestId
      }
    });
  }
});

module.exports = {
  listRoutes,
  getRoute,
  createRoute,
  updateRoute,
  deleteRoute,
  addStop,
  updateStop,
  deleteStop,
  reorderStops,
  listBuses,
  createBus,
  listSchedules,
  upsertSchedule,
  listTrips,
  getTrip,
  createTrip,
  tripImpact,
  cancelTrip,
  generateTrips,
  cronGenerateTrips,
  retryEvents,
  health,
  ready
};
