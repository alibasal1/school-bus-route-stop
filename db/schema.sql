-- ============================================================================
-- Route & Stop service schema.  Owner: Yahia Wael (247330), Team 14.
--
-- >>> THIS FILE IS FOR AN EMPTY DATABASE ONLY. <<<
-- It starts with plain CREATE TABLE, so on a Neon database that already has
-- these tables it stops at "relation already exists".
--
-- Already have the first version of the tables?
--   Run db/migrations/001_route_stop_v2.sql instead. It only adds, it can be
--   run twice safely, and it keeps the data.
--
-- Do NOT drop the tables to make this file run. routes, stops, buses and
-- trips are read by the other two services, and users, sessions and
-- audit_log are shared by all three: dropping any of them takes the whole
-- team's database down with it.
--
-- Run order in the Neon SQL Editor:
--   1. school-bus-schedule-arrival/db/auth-schema.sql   (users, sessions)
--   2. THIS FILE
--   3. school-bus-schedule-arrival/db/schema.sql
--   4. school-bus-favorites-alerts/db/schema.sql
--
-- This service owns: routes, stops, buses, route_schedules, trips,
--                    route_events, idempotency_keys.
-- It shares:         audit_log (created by whichever service runs first).
-- It only reads:     users (auth service), holidays (favorites service).
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto, which Neon enables by default.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ----------------------------------------------------------------------------
-- routes
-- ----------------------------------------------------------------------------
CREATE TABLE routes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       VARCHAR(20)  NOT NULL UNIQUE,
  name       VARCHAR(100) NOT NULL,
  area       VARCHAR(100) NOT NULL,
  is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Search is the highest-traffic read in this service (every parent hits it),
-- so the columns it filters on are indexed in lower-case form to match the
-- case-insensitive comparison used by the search query.
CREATE INDEX routes_name_lower_idx ON routes (lower(name));
CREATE INDEX routes_area_lower_idx ON routes (lower(area));
CREATE INDEX routes_code_lower_idx ON routes (lower(code));


-- ----------------------------------------------------------------------------
-- stops
--
-- stop_order is the position of the stop along the route, starting at 1 with
-- no gaps.  The UNIQUE constraint is DEFERRABLE so that a whole re-ordering
-- can be applied inside one transaction: during the update two stops briefly
-- hold the same position, and the constraint is only checked at COMMIT.
-- Without DEFERRABLE, any reorder that is not a simple append would fail.
-- ----------------------------------------------------------------------------
CREATE TABLE stops (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id   UUID         NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  landmark   VARCHAR(150),
  stop_order INT          NOT NULL CHECK (stop_order > 0),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT stops_route_order_unique UNIQUE (route_id, stop_order)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX stops_route_idx ON stops (route_id, stop_order);


-- ----------------------------------------------------------------------------
-- buses
-- ----------------------------------------------------------------------------
CREATE TABLE buses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number  VARCHAR(20) NOT NULL UNIQUE,
  capacity      INT         NOT NULL DEFAULT 40 CHECK (capacity BETWEEN 1 AND 100),
  route_id      UUID REFERENCES routes(id) ON DELETE SET NULL,
  supervisor_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX buses_route_idx ON buses (route_id);


-- ----------------------------------------------------------------------------
-- route_schedules
--
-- The recurring pattern a route runs on.  This is what makes trip creation a
-- generated result rather than a form the admin fills in once per day:
-- "route R runs a morning trip on Sunday-Thursday from 2026-09-01".
-- days_of_week uses ISO numbering, 1 = Monday ... 7 = Sunday.
-- ----------------------------------------------------------------------------
CREATE TABLE route_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id     UUID        NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  run_type     VARCHAR(10) NOT NULL CHECK (run_type IN ('morning', 'afternoon')),
  days_of_week SMALLINT[]  NOT NULL CHECK (
                 array_length(days_of_week, 1) BETWEEN 1 AND 7
               ),
  bus_id       UUID REFERENCES buses(id) ON DELETE SET NULL,
  active_from  DATE        NOT NULL,
  active_to    DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT route_schedules_one_per_run UNIQUE (route_id, run_type),
  CONSTRAINT route_schedules_dates_ordered CHECK (active_to IS NULL OR active_to >= active_from)
);


-- ----------------------------------------------------------------------------
-- trips
--
-- service_date is the day the trip runs.  The proposal promises "search trips
-- by route and day", which the original schema could not answer: it only had
-- cancelled_date, so an active trip had no date at all.
--
-- Two guarantees are enforced here rather than only in application code:
--   trips_route_slot_unique  one trip per route, per day, per run
--   trips_bus_slot_unique    a bus cannot run two active trips in the same
--                            slot (partial index: cancelled trips are exempt,
--                            so the slot frees up when a trip is cancelled)
-- The API still checks both before inserting so it can answer 409 with a
-- readable explanation; the constraints are the backstop for races.
-- ----------------------------------------------------------------------------
CREATE TABLE trips (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id            UUID        NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  bus_id              UUID REFERENCES buses(id) ON DELETE SET NULL,
  service_date        DATE        NOT NULL,
  run_type            VARCHAR(10) NOT NULL CHECK (run_type IN ('morning', 'afternoon')),
  status              VARCHAR(10) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'cancelled')),
  cancellation_reason VARCHAR(200),
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  source              VARCHAR(10) NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'generated')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trips_route_slot_unique UNIQUE (route_id, service_date, run_type),
  CONSTRAINT trips_cancel_fields_consistent CHECK (
    (status = 'cancelled' AND cancelled_at IS NOT NULL)
    OR (status = 'active' AND cancelled_at IS NULL)
  )
);

CREATE UNIQUE INDEX trips_bus_slot_unique
  ON trips (bus_id, service_date, run_type)
  WHERE status = 'active' AND bus_id IS NOT NULL;

CREATE INDEX trips_date_idx  ON trips (service_date, run_type);
CREATE INDEX trips_route_idx ON trips (route_id, service_date);


-- ----------------------------------------------------------------------------
-- route_events  (transactional outbox)
--
-- When a trip is cancelled, the parents of the children on that route have to
-- be told.  Calling the Favorites & Alerts service directly from inside the
-- cancel request would mean the cancellation succeeds and the alert silently
-- disappears whenever that service is down or slow.
--
-- Instead the event is written in the SAME transaction as the status change:
-- either both land or neither does.  A separate forwarder (AWS Lambda on an
-- EventBridge schedule, see infra/aws/) reads unpublished rows and pushes them
-- to SNS, and marks them published.  Delivery is at-least-once, so consumers
-- must treat event ids as idempotency keys.
-- ----------------------------------------------------------------------------
CREATE TABLE route_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   VARCHAR(40) NOT NULL,
  route_id     UUID,
  trip_id      UUID,
  payload      JSONB       NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  attempts     INT         NOT NULL DEFAULT 0,
  last_error   TEXT
);

-- Partial index: the forwarder only ever scans rows that are still unpublished,
-- so the index stays small no matter how many events the table accumulates.
CREATE INDEX route_events_pending_idx
  ON route_events (occurred_at)
  WHERE published_at IS NULL;


-- ----------------------------------------------------------------------------
-- idempotency_keys
--
-- A parent tapping "create" twice, or a cron run that is retried after a
-- timeout, must not produce two routes or two sets of trips.  A write that
-- carries an Idempotency-Key header stores its response here; a repeat of the
-- same key replays the stored response instead of doing the work again.
-- ----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key           VARCHAR(100) NOT NULL,
  endpoint      VARCHAR(120) NOT NULL,
  user_id       UUID,
  request_hash  CHAR(64)     NOT NULL,
  status_code   INT          NOT NULL,
  response_body JSONB        NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (key, endpoint)
);

CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);


-- ----------------------------------------------------------------------------
-- audit_log  (shared across the three backend services)
--
-- Every state-changing admin action is recorded with who did it, what they
-- touched and what the API answered.  IF NOT EXISTS so that the three service
-- schemas can be run in any order without clashing.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service       VARCHAR(40)  NOT NULL,
  user_id       UUID,
  user_role     VARCHAR(20),
  action        VARCHAR(60)  NOT NULL,
  resource_type VARCHAR(40),
  resource_id   VARCHAR(100),
  status_code   INT          NOT NULL,
  request_id    VARCHAR(64),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_user_idx    ON audit_log (user_id, created_at DESC);


-- ----------------------------------------------------------------------------
-- Demo data.  Safe to delete; useful for the Week 6 demo.
-- ----------------------------------------------------------------------------
INSERT INTO routes (code, name, area) VALUES
  ('R-01', 'Maadi Morning Line',   'Maadi'),
  ('R-02', 'Nasr City Line',       'Nasr City'),
  ('R-03', 'Sheikh Zayed Express', 'Sheikh Zayed');

INSERT INTO stops (route_id, name, landmark, stop_order)
SELECT r.id, s.name, s.landmark, s.ord
FROM routes r
JOIN (VALUES
  ('R-01', 'Road 9 Corner',    'Next to the pharmacy', 1),
  ('R-01', 'Maadi Club Gate',  'Main gate',            2),
  ('R-01', 'School Gate B',    NULL,                   3),
  ('R-02', 'Abbas El Akkad',   'Opposite the bank',    1),
  ('R-02', 'School Gate B',    NULL,                   2)
) AS s(code, name, landmark, ord) ON s.code = r.code;
