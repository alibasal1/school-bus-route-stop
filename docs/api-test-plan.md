# API test plan — Route & Stop

Two layers of testing, because they catch different things.

**Automated unit tests** (`npm test`, 47 tests, no database) cover the logic
in `lib/`: calendar arithmetic, generation rules, conflict detection, stop
resequencing, validation. These are the cases that are impractical to reach
through HTTP — a leap day, a schedule window boundary, two schedules sharing
a bus on the same day.

**Manual API tests** (below) cover the wiring: status codes, access control,
headers, and the paths through Express. Run them with
[`requests.http`](requests.http) in VS Code (REST Client extension) or the
Postman collection exported to `evidence/`.

---

## Automated — `npm test`

```
tests/tripPlanner.test.js   16 tests  generation and conflicts
tests/resequence.test.js    15 tests  stop ordering
tests/validate.test.js      16 tests  field rules and date maths
```

Notable cases:

| What it proves |
|---|
| Weekends and holidays are skipped, and the skip reason is reported |
| Running generation twice creates nothing the second time (idempotent) |
| Two routes sharing one bus do not both get the same slot in one run |
| A leap day is treated as a normal service day |
| Cancelling frees the slot; the afternoon run is independent of the morning |
| A reorder returns only the stops that move; a partial or duplicated list is refused |
| Deleting a middle stop closes the gap |
| `2026-02-31` is rejected even though it matches the date pattern |
| A whitespace-only name, a numeric name and a missing field all fail cleanly |
| Server-owned fields in a body are refused, not ignored |

---

## Manual — endpoint tests

Prerequisite: log in through the Schedule & Arrival service to get a token.
`@adminToken` is an account with role `admin`; `@parentToken` is a parent.

### Happy path

| ID | Request | Expect |
|---|---|---|
| T01 | `GET /api/health` | 200, `runtime` says where it is running |
| T02 | `GET /api/ready` | 200, `database: reachable` |
| T03 | `GET /api/routes` (admin) | 200, paged list with `stop_count` |
| T04 | `GET /api/routes?search=maadi` | 200, exact code match ranked first |
| T05 | `POST /api/routes` valid | 201, `Location` header, server-made id |
| T06 | `POST /api/routes/:id/stops` ×3 | 201 each, `stop_order` 1, 2, 3 |
| T07 | `PUT /api/routes/:id/stops/order` reversed | 200, `moved` > 0, order reversed |
| T08 | `DELETE /api/stops/:id` (the middle one) | 204, remaining stops renumber to 1, 2 |
| T09 | `POST /api/buses` | 201 |
| T10 | `PUT /api/routes/:id/schedule` | 200, the recurring pattern is stored |
| T11 | `POST /api/trips/generate` `dry_run: true` | 200, `created: 0`, plan with skip reasons |
| T12 | same with `dry_run: false` | 201, `created` matches `summary.planned` |
| T13 | `GET /api/trips?date=…` | 200, the generated trips for that day |
| T14 | `GET /api/trips/:id/impact` | 200, stops listed, student count or `null` |
| T15 | `PATCH /api/trips/:id/status` cancelled | 200, `impact` and `event_id` present |

### Validation — 400

| ID | Request | Expect |
|---|---|---|
| T16 | `POST /api/routes` with `name: "ab"` | 400 `VALIDATION_ERROR`, length message |
| T17 | `POST /api/routes` with `id: "HACKED-1"` | 400, "set by the server" |
| T18 | `POST /api/trips` `service_date: "2026-02-31"` | 400, "not a real date" |
| T19 | `POST /api/trips` `run_type: "evening"` | 400, "morning or afternoon" |
| T20 | `POST /api/trips` with yesterday's date | 400, "cannot be in the past" |
| T21 | `PUT …/stops/order` with a partial list | 400, "every stop on this route" |
| T22 | `PUT …/stops/order` with a repeated id | 400, "same stop twice" |
| T23 | `PUT /api/stops/:id` with `stop_order: 9` | 400, "set by the server" |
| T24 | `GET /api/routes?limit=100000` | 400, limit cap |
| T25 | malformed JSON body | 400, "not valid JSON", server stays up |
| T26 | `PUT …/schedule` `days_of_week: [0]` | 400, ISO day range |

### Access control — 401 / 403 / 404

| ID | Request | Expect |
|---|---|---|
| T27 | `GET /api/routes` with no token | **401** `UNAUTHENTICATED` |
| T28 | `GET /api/routes` with a made-up token | **401**, same message as T27 |
| T29 | `POST /api/routes` with `@parentToken` | **403** `FORBIDDEN` |
| T30 | `DELETE /api/routes/:id` with `@parentToken` | **403** |
| T31 | `GET /api/internal/events` with no key | **401** |
| T32 | `GET /api/internal/events` with a wrong key | **401** |
| T33 | `PATCH /api/trips/<unknown-uuid>/status` | **404** `RESOURCE_NOT_FOUND` |
| T34 | `GET /api/nonsense` | **404** `ROUTE_NOT_FOUND` (different code to T33) |

### Conflicts — 409

| ID | Request | Expect |
|---|---|---|
| T35 | `POST /api/routes` with an existing code | 409, "already exists" |
| T36 | `POST /api/trips` for a slot that has one | 409, `ROUTE_SLOT_TAKEN` |
| T37 | `POST /api/trips` with a bus already out | 409, `BUS_DOUBLE_BOOKED` |
| T38 | `POST /api/trips` on a route with no stops | 409, `ROUTE_HAS_NO_STOPS` |
| T39 | `DELETE /api/routes/:id` with trips | 409, suggests deactivating |
| T40 | `PATCH …/status` on an already-cancelled trip | 409, "already cancelled" |
| T41 | same `Idempotency-Key`, different body | 409 `IDEMPOTENCY_KEY_REUSED` |

### Platform behaviour

| ID | Request | Expect |
|---|---|---|
| T42 | `POST /api/routes` with `Content-Type: text/plain` | 415 |
| T43 | a body over 32 kb | 413 `PAYLOAD_TOO_LARGE` |
| T44 | `POST /api/routes` twice with the same `Idempotency-Key` | 201 then the same body with `Idempotent-Replay: true`; only one route exists |
| T45 | 130 rapid `GET /api/routes` | 429 with `Retry-After` after 120 |
| T46 | any response | `X-Request-Id`, `X-Content-Type-Options`, `X-Frame-Options`, CSP present |
| T47 | preflight `OPTIONS` from the deployed frontend | 204 with `Access-Control-Allow-Origin` |
| T48 | preflight `OPTIONS` from `https://evil.example` | **no** `Access-Control-Allow-Origin` |
| T49 | `GET /api/internal/cron/generate` with `CRON_SECRET` | 200, trips created, one log line |

### Integrity

| ID | Check | Expect |
|---|---|---|
| T50 | After T15, `SELECT * FROM route_events WHERE trip_id = …` | one `trip.cancelled` row, `published_at` null until the forwarder runs |
| T51 | After the forwarder runs | `published_at` set; the row is not sent again |
| T52 | After any admin write | a matching row in `audit_log` with the user and status |
| T53 | After T07 and T08 | `SELECT stop_order … ORDER BY stop_order` is exactly 1..n |

---

## Results

Fill in as the tests are run. A failing row is information, not something to
hide — the table in `architecture.md` §4 says which file produces each status
code, which is where to start looking.

| ID | Expected | Actual | Pass/Fail |
|---|---|---|---|
| T01 | | | |
| … | | | |
