// Route & Stop endpoints. Owner: Yahia Wael (247330).
//
// This file is the map of the service and nothing else: for each method and
// path it lists the guards a request must pass and the controller function
// that answers it. No validation, no status codes, no SQL.
//
// Reading one line tells you the whole access rule. For example:
//
//   router.post('/routes', requireAuth, requireRole('admin'), writeLimit,
//               verifyTurnstile, idempotent('POST /api/routes'), c.createRoute)
//
//   logged in -> is an admin -> within their write budget -> is a real
//   browser, not a script -> not a repeat of a request already handled ->
//   only then does any code touch the database.
//
// Order matters. The cheapest and most decisive checks run first, so an
// anonymous flood is rejected by requireAuth without ever reaching Cloudflare
// or the database.

const express = require('express');
const controller = require('../controllers/routes');
const {
  requireAuth,
  requireRole,
  requireServiceToken,
  requireScheduler
} = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { verifyTurnstile } = require('../middleware/turnstile');
const { idempotent } = require('../middleware/idempotency');

const router = express.Router();
const admin = requireRole('admin');

// Three budgets, because the three kinds of request cost very different
// amounts. Reads are cheap and constant (every parent, every page load);
// writes are rare and only ever made by a handful of admins; generation
// writes dozens of rows at once and is the most expensive thing here.
const readLimit = rateLimit({ name: 'read', limit: 120, windowSeconds: 60 });
const writeLimit = rateLimit({ name: 'write', limit: 20, windowSeconds: 60 });
const generateLimit = rateLimit({ name: 'generate', limit: 5, windowSeconds: 300 });

// --- health -----------------------------------------------------------------
// Deliberately unauthenticated: a readiness probe that needs a login cannot
// be used by the platform that is meant to be probing it. Neither endpoint
// reveals anything an attacker can use.
router.get('/health', controller.health);
router.get('/ready', controller.ready);

// --- routes -----------------------------------------------------------------
router.get('/routes', requireAuth, readLimit, controller.listRoutes);
router.get('/routes/:id', requireAuth, readLimit, controller.getRoute);
router.post(
  '/routes',
  requireAuth,
  admin,
  writeLimit,
  verifyTurnstile,
  idempotent('POST /api/routes'),
  controller.createRoute
);
router.put('/routes/:id', requireAuth, admin, writeLimit, verifyTurnstile, controller.updateRoute);
router.delete('/routes/:id', requireAuth, admin, writeLimit, controller.deleteRoute);

// --- stops ------------------------------------------------------------------
router.post(
  '/routes/:id/stops',
  requireAuth,
  admin,
  writeLimit,
  verifyTurnstile,
  idempotent('POST /api/routes/:id/stops'),
  controller.addStop
);
router.put('/routes/:id/stops/order', requireAuth, admin, writeLimit, controller.reorderStops);
router.put('/stops/:id', requireAuth, admin, writeLimit, verifyTurnstile, controller.updateStop);
router.delete('/stops/:id', requireAuth, admin, writeLimit, controller.deleteStop);

// --- buses ------------------------------------------------------------------
router.get('/buses', requireAuth, admin, readLimit, controller.listBuses);
router.post(
  '/buses',
  requireAuth,
  admin,
  writeLimit,
  verifyTurnstile,
  idempotent('POST /api/buses'),
  controller.createBus
);

// --- schedules --------------------------------------------------------------
router.get('/routes/:id/schedule', requireAuth, admin, readLimit, controller.listSchedules);
router.put('/routes/:id/schedule', requireAuth, admin, writeLimit, controller.upsertSchedule);

// --- trips ------------------------------------------------------------------
router.get('/trips', requireAuth, readLimit, controller.listTrips);
router.get('/trips/:id', requireAuth, readLimit, controller.getTrip);
router.get('/trips/:id/impact', requireAuth, admin, readLimit, controller.tripImpact);
router.post(
  '/trips',
  requireAuth,
  admin,
  writeLimit,
  verifyTurnstile,
  idempotent('POST /api/trips'),
  controller.createTrip
);
router.patch('/trips/:id/status', requireAuth, admin, writeLimit, controller.cancelTrip);
router.post(
  '/trips/generate',
  requireAuth,
  admin,
  generateLimit,
  idempotent('POST /api/trips/generate'),
  controller.generateTrips
);

// --- internal ---------------------------------------------------------------
// Called by the scheduled job and the event forwarder, never by a browser.
// requireServiceToken, not requireAuth: these callers have no session, they
// present a shared secret from the platform's encrypted environment.
router.post('/internal/trips/generate', requireServiceToken, controller.generateTrips);
router.get('/internal/events', requireServiceToken, controller.listPendingEvents);
router.post('/internal/events/ack', requireServiceToken, controller.ackEvents);

// The weekly scheduled run. GET with no body, because that is all Vercel Cron
// can send; the window and the commit flag come from the query string so the
// schedule in vercel.json stays the single place the job is configured.
router.get('/internal/cron/generate', requireScheduler, controller.cronGenerateTrips);

module.exports = router;
