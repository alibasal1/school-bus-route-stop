-- ============================================================================
-- Migration 001: scaffold schema -> Route & Stop v2
--
-- Use THIS file on a Neon database that already has the first version of the
-- tables. db/schema.sql is for a brand-new, empty database only: it starts
-- with plain CREATE TABLE and will fail with "relation already exists" on a
-- database that is already set up.
--
-- DO NOT drop and recreate the tables to get around that. routes, stops,
-- buses and trips are read by the other two services, and users, sessions
-- and audit_log are shared: dropping any of them takes the whole team's
-- database with it. This migration only adds.
--
-- Safe to run more than once: every statement is guarded, so a second run
-- changes nothing and reports no error.
--
-- What it does:
--   * adds the new columns on routes, stops, buses and trips
--   * gives trips a service_date, which the first version had no column for
--     at all (it only stored cancelled_date), so "search trips by route and
--     day" had nothing to search
--   * creates route_schedules, route_events, idempotency_keys, audit_log
--   * adds the deferrable stop-order constraint and the partial unique index
--     that stops a bus being booked twice in one slot
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- routes
-- ---------------------------------------------------------------------------
ALTER TABLE routes
  ADD COLUMN IF NOT EXISTS is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS routes_name_lower_idx ON routes (lower(name));
CREATE INDEX IF NOT EXISTS routes_area_lower_idx ON routes (lower(area));
CREATE INDEX IF NOT EXISTS routes_code_lower_idx ON routes (lower(code));

-- ---------------------------------------------------------------------------
-- stops
--
-- The unique constraint has to be DEFERRABLE, otherwise any reorder that is
-- not a simple append fails halfway through: two stops briefly hold the same
-- position and a non-deferrable constraint rejects that immediately instead
-- of waiting for COMMIT.
-- ---------------------------------------------------------------------------
ALTER TABLE stops
  ADD COLUMN IF NOT EXISTS landmark   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stops_route_order_unique'
  ) THEN
    ALTER TABLE stops
      ADD CONSTRAINT stops_route_order_unique UNIQUE (route_id, stop_order)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS stops_route_idx ON stops (route_id, stop_order);

-- ---------------------------------------------------------------------------
-- buses
-- ---------------------------------------------------------------------------
ALTER TABLE buses
  ADD COLUMN IF NOT EXISTS capacity   INT         NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buses_capacity_sane') THEN
    ALTER TABLE buses ADD CONSTRAINT buses_capacity_sane CHECK (capacity BETWEEN 1 AND 100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS buses_route_idx ON buses (route_id);

-- ---------------------------------------------------------------------------
-- route_schedules  (new)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_schedules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id     UUID        NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  run_type     VARCHAR(10) NOT NULL CHECK (run_type IN ('morning', 'afternoon')),
  days_of_week SMALLINT[]  NOT NULL CHECK (array_length(days_of_week, 1) BETWEEN 1 AND 7),
  bus_id       UUID REFERENCES buses(id) ON DELETE SET NULL,
  active_from  DATE        NOT NULL,
  active_to    DATE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT route_schedules_one_per_run UNIQUE (route_id, run_type),
  CONSTRAINT route_schedules_dates_ordered CHECK (active_to IS NULL OR active_to >= active_from)
);

-- ---------------------------------------------------------------------------
-- trips
--
-- service_date is added as nullable first, because existing rows have no date
-- to put in it. Any trip that was already cancelled keeps its cancelled_date
-- as its service date; anything still active has to be filled in by hand,
-- and the NOT NULL is only applied once nothing is left empty.
-- cancelled_date is kept, not dropped, so a rollback stays possible.
-- ---------------------------------------------------------------------------
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS service_date        DATE,
  ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(200),
  ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source              VARCHAR(10) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE trips SET service_date = cancelled_date
  WHERE service_date IS NULL AND cancelled_date IS NOT NULL;

UPDATE trips SET cancelled_at = now()
  WHERE status = 'cancelled' AND cancelled_at IS NULL;

DO $$
DECLARE
  undated INT;
BEGIN
  SELECT COUNT(*) INTO undated FROM trips WHERE service_date IS NULL;

  IF undated > 0 THEN
    -- Stop rather than guess. Inventing a date here would put a bus on a day
    -- it does not run, which parents would read as a real trip.
    RAISE EXCEPTION USING
      MESSAGE = format('%s trip(s) have no service_date.', undated),
      HINT    = 'Set them first, e.g. UPDATE trips SET service_date = DATE ''2026-03-01'' WHERE service_date IS NULL; then run this migration again. If they are test rows, DELETE FROM trips WHERE service_date IS NULL;';
  END IF;

  ALTER TABLE trips ALTER COLUMN service_date SET NOT NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_source_known') THEN
    ALTER TABLE trips ADD CONSTRAINT trips_source_known
      CHECK (source IN ('manual', 'generated'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_route_slot_unique') THEN
    ALTER TABLE trips ADD CONSTRAINT trips_route_slot_unique
      UNIQUE (route_id, service_date, run_type);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trips_cancel_fields_consistent') THEN
    ALTER TABLE trips ADD CONSTRAINT trips_cancel_fields_consistent CHECK (
      (status = 'cancelled' AND cancelled_at IS NOT NULL)
      OR (status = 'active' AND cancelled_at IS NULL)
    );
  END IF;
END $$;

-- Partial: only active trips hold a slot, so cancelling one frees its bus.
CREATE UNIQUE INDEX IF NOT EXISTS trips_bus_slot_unique
  ON trips (bus_id, service_date, run_type)
  WHERE status = 'active' AND bus_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trips_date_idx  ON trips (service_date, run_type);
CREATE INDEX IF NOT EXISTS trips_route_idx ON trips (route_id, service_date);

-- ---------------------------------------------------------------------------
-- route_events  (transactional outbox, new)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS route_events (
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

CREATE INDEX IF NOT EXISTS route_events_pending_idx
  ON route_events (occurred_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------------
-- idempotency_keys  (new)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           VARCHAR(100) NOT NULL,
  endpoint      VARCHAR(120) NOT NULL,
  user_id       UUID,
  request_hash  CHAR(64)     NOT NULL,
  status_code   INT          NOT NULL,
  response_body JSONB        NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (key, endpoint)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- audit_log  (shared; whichever service runs first creates it)
-- ---------------------------------------------------------------------------
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

COMMIT;

-- ============================================================================
-- Check it worked
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'trips' ORDER BY ordinal_position;
--   -- service_date, source, cancelled_at, cancelled_by, created_at present
--
--   SELECT conname FROM pg_constraint WHERE conrelid = 'trips'::regclass;
--   -- trips_route_slot_unique, trips_cancel_fields_consistent, trips_source_known
--
--   SELECT conname, condeferrable FROM pg_constraint
--   WHERE conname = 'stops_route_order_unique';
--   -- condeferrable must be true, or reordering stops will fail
--
-- Rolling back: cancelled_date is still there and nothing was deleted, so the
-- old code keeps working. To undo completely, drop the four new tables and
-- the columns added above. Never drop routes, stops, buses, trips, users,
-- sessions or audit_log: other services depend on them.
-- ============================================================================
