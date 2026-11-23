# Route & Stop — how the backend works

Service owner: Yahia Wael (247330), Team 14, 26CSCN29H.

This document explains the backend rather than listing endpoints. The
endpoint list is in [api-contract.md](api-contract.md).

---

## 1. What this service is for

Three people need three different things from the same timetable.

The **admin** plans it: routes, the stops along them, the buses, and which
trips run on which days. The **parent** reads it: which route serves their
area, which stop is theirs, is there a bus tomorrow. The **supervisor** needs
to know which trip they are on today.

The hard part is not storing any of that. It is that the three views have to
stay consistent while one person edits them: a stop cannot be fourth and
fifth at the same time, a bus cannot be on two routes at 07:00, and a
cancelled trip cannot leave a parent waiting at the kerb because an alert was
lost. Those are the problems this service exists to solve, and they are why
it is not a set of CRUD endpoints.

---

## 2. The three layers, and why the boundaries are where they are

```
HTTP request
    │
    ▼
routes/routes.js        method + path  ->  guards  ->  one controller function
    │                   knows: which endpoints exist, who may call them
    ▼
controllers/routes.js   validates input, chooses the status code
    │                   knows: HTTP. Never writes SQL.
    ▼
services/routes.js      all SQL, all transactions, all business rules
    │                   knows: the database. Never sees req or res.
    ▼
db/index.js             one Neon connection, parameterised queries only
    │
    ▼
Neon Postgres
```

Alongside them sits `lib/`, which holds the decisions that are not about
HTTP *or* the database: `tripPlanner.js` (what should exist on the calendar),
`resequence.js` (what a valid stop order looks like), `validate.js`,
`dates.js`. They are pure functions over plain data.

**Why split it this way.** Each layer can be understood, changed and tested
without the others:

- the service never touches `req`, so swapping Neon for DynamoDB (Lab 7)
  changes one file and no routes or controllers — which is exactly what
  happened to the Cloud Issue Tracker when it moved off its JSON file;
- `lib/` has no database, so the 47 tests in `tests/` run in a quarter of a
  second with `npm test` and no Neon instance. Checking "a leap day is a
  normal service day" through HTTP would need a live database and a month of
  seeded rows;
- the routes file is the complete access-control map. One line shows every
  guard a request passes before any code touches data.

---

## 3. The trust boundary

```
UNTRUSTED                          │  TRUSTED
                                   │
browser, Postman, curl, a script ──┼──▶ API ──▶ database
                                   │
                        the boundary is the HTTP request
```

Everything arriving from outside is untrusted, **however it was sent**. Our
own React page is not special: anyone can open DevTools, or skip the page
entirely and call the API with curl. Frontend validation exists to give the
user quick feedback; the checks in `controllers/routes.js` are the ones that
decide anything.

Four rules hold at the boundary:

1. **The API validates every request.** Types, lengths, enums, date
   realism (`2026-02-31` parses but is not a day), id format.
2. **The client never owns server fields.** `id`, `status`, `created_at`,
   `stop_order` are rejected if sent, not silently ignored — so an attempt
   shows up as a 400 in the logs rather than disappearing.
3. **The browser never reaches the database.** Only this API holds
   `DATABASE_URL`.
4. **Errors say what the caller did wrong and nothing else.** Internal
   messages and stack traces are logged with a request id; the caller gets
   the id and a generic message.

### Authentication and authorisation are separate questions

```js
router.post('/routes', requireAuth, requireRole('admin'), writeLimit,
            verifyTurnstile, idempotent('POST /api/routes'), c.createRoute)
```

`requireAuth` answers *who is this* (401 if there is no valid session).
`requireRole` answers *may they do this* (403 if the role is wrong). Mixing
them produces the classic bug where any logged-in parent can edit routes
because the code only ever asked whether a token was present.

Login itself lives in `school-bus-schedule-arrival`. This service never sees
a password: it takes the bearer token, hashes it with SHA-256 and looks the
hash up in the shared `sessions` table. The database stores only hashes, so a
leaked backup contains nothing anyone can log in with.

Guards are ordered cheapest-and-most-decisive first, so an anonymous flood is
rejected by `requireAuth` without ever reaching Cloudflare or Postgres.

---

## 4. What happens to one request

`POST /api/trips` with a valid body:

| # | Where | What happens |
|---|---|---|
| 1 | `app.js` | request id assigned, security headers set, request logged |
| 2 | `app.js` | CORS: is this origin on the allow-list? |
| 3 | `app.js` | body parsed, capped at 32 kb; not JSON → 415 |
| 4 | `routes/routes.js` | `requireAuth` → `requireRole('admin')` → rate limit → Turnstile → idempotency |
| 5 | `controllers/routes.js` | fields validated; a date in the past → 400 |
| 6 | `services/routes.js` | loads the route, the bus and every active trip in that slot |
| 7 | `lib/tripPlanner.js` | `findConflicts()` — clash → **409 with the reasons listed** |
| 8 | `services/routes.js` | transaction: insert the trip **and** the outbox event |
| 9 | `controllers/routes.js` | 201 with the trip; audit row written |

Every status code is produced in exactly one known place:

| Status | Code | Produced by |
|---|---|---|
| 400 | `VALIDATION_ERROR` | controller, or `errorHandler` for malformed JSON |
| 401 | `UNAUTHENTICATED` | `middleware/auth.js` |
| 403 | `FORBIDDEN` / `BOT_CHECK_FAILED` | `requireRole` / `verifyTurnstile` |
| 404 | `RESOURCE_NOT_FOUND` | controller, when the service returns null |
| 404 | `ROUTE_NOT_FOUND` | `routeNotFound` in `app.js` |
| 409 | `CONFLICT` | service, from `findConflicts` or a unique constraint |
| 413 | `PAYLOAD_TOO_LARGE` | `errorHandler`, from the body-size cap |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `requireJsonBody` |
| 429 | `RATE_LIMITED` | `middleware/rateLimit.js` |
| 500 | `INTERNAL_ERROR` | `errorHandler`, for anything unexpected |
| 503 | `SERVICE_UNAVAILABLE` | database unreachable, or Turnstile unreachable |

All of them use one body shape, so the frontend handles every failure the
same way:

```json
{ "error": { "code": "CONFLICT", "message": "…", "request_id": "…" } }
```

---

## 5. The four things that are not CRUD

### 5.1 Trip generation

An admin planning by hand creates one trip per route per run per day: three
routes, two runs, five days is 30 forms a week. Instead they describe the
pattern once in `route_schedules` — "route R-01 runs a morning trip Sunday to
Thursday from 1 September" — and `planTrips()` expands it over a date range,
skipping:

- days the route does not run,
- days outside the schedule's window,
- public holidays, read from the Favorites & Alerts service's `holidays`
  table (filled from Calendarific),
- days that already have a trip,
- anything that would double-book a bus or a supervisor.

`dry_run` is the **default**: the admin sees exactly what would be created
and why each skipped day was skipped, then commits. A Vercel Cron job runs
the same code every Sunday so the timetable always reaches three weeks ahead
without anyone opening the admin page.

Generation is safe to repeat. Each run treats what it has already planned as
occupied, the insert uses `ON CONFLICT DO NOTHING`, and an `Idempotency-Key`
replays the first response rather than doing the work twice.

### 5.2 Conflict detection

Before any trip is written, `findConflicts()` checks it against the route's
state and every other active trip in the same slot:

| Code | Refused because |
|---|---|
| `ROUTE_SLOT_TAKEN` | the route already has an active trip in that slot |
| `BUS_DOUBLE_BOOKED` | the bus is already out on another route then |
| `SUPERVISOR_DOUBLE_BOOKED` | the bus's supervisor is on another bus then |
| `BUS_ROUTE_MISMATCH` | the bus is assigned to a different route |
| `ROUTE_INACTIVE` | the route is retired |
| `ROUTE_HAS_NO_STOPS` | there is nowhere for the bus to stop |

The caller gets 409 with every reason listed, not a database error.

Two of these are also enforced by the database —
`trips_route_slot_unique`, and a **partial** unique index on
`(bus_id, service_date, run_type) WHERE status = 'active'`, so cancelling a
trip frees the slot. The application check gives a readable answer; the
constraints are the backstop for two admins saving in the same instant.
Defence in depth, as in Lecture 9: the control that produces the good error
message is not the control that guarantees correctness.

### 5.3 Atomic stop resequencing

`stop_order` must always be 1..n with no gaps and no repeats, because the
Schedule & Arrival service walks the stops in order and the parent app shows
"your stop is 4th". Letting the client `PUT` its own numbers one stop at a
time breaks that three ways: a dropped request leaves a gap, two admins
editing at once produce duplicates, and a typo pushes a stop to position 99.

So the client says what the order should be — the full list, or
`{ stop_id, to_position }` — and `lib/resequence.js` computes the smallest
set of changes. They are applied in one transaction against a `DEFERRABLE
INITIALLY DEFERRED` unique constraint, so two stops may briefly share a
position mid-update and the constraint is checked once at COMMIT. Without
`DEFERRABLE`, any reorder that is not a simple append would fail. Deleting a
stop closes the gap in the same transaction, and `stop_order` is rejected
outright on the stop-update endpoint.

### 5.4 Cancellation impact, and the outbox

Cancelling a trip is not a status flip. The service first works out who is
affected — which stops, and how many students and parents, by reading (never
writing) the Schedule & Arrival service's `students` table — and returns that
with the response so the admin sees what they just did.

Then the important part. The alert belongs to Ali's service, and calling it
over HTTP from inside the cancel request is the obvious design and the wrong
one: the call sits outside the database transaction, so if that service is
slow or down the trip is cancelled and the alert is **lost**. The admin sees
success; the parents are never told.

Instead the cancellation and a row in `route_events` are written in one
transaction: either both land or neither does. A Lambda on an EventBridge
schedule publishes unpublished rows to an SNS topic and marks them published
(`infra/aws/event-forwarder/`). If the alerts service is down the events
wait. Delivery is at-least-once, so the event id doubles as the consumer's
idempotency key.

This also decouples the services: a fourth consumer subscribes to the topic
and nothing here changes.

---

## 6. Keeping the service standing up

| Concern | How |
|---|---|
| Traffic | Rate limits in three tiers (reads 120/min, writes 20/min, generation 5 per 5 min), counted in Upstash Redis so the limit is shared across serverless instances. `Cache-Control` on the two read-heavy endpoints. |
| Bots | Cloudflare Turnstile verified **server-side** on writes. Fails closed. |
| Abuse of size | Body capped at 32 kb; `limit` capped at 100–200; generation capped at 120 days. |
| Repeats | `Idempotency-Key` on every create. |
| SQL injection | Every value is a bind parameter via `sql\`…${value}\``. No statement is built by joining strings, including the reorder, which uses `unnest` with arrays. |
| Secrets | `.env` locally, encrypted environment variables in Vercel and Lambda. `.env` is in `.gitignore`; only `.env.example` is committed. |
| Who did what | `audit_log` records every state-changing action with user, role, resource and status. Written after the response, never able to fail the request. |
| Diagnosis | One JSON log line per request with a request id, echoed in every error body. `/api/health` (is it running) is separate from `/api/ready` (can it reach the database), so a bad deploy and a bad `DATABASE_URL` look different. |

Nothing sensitive is logged: no bodies, no `Authorization` headers, no
tokens, no query strings. Lecture 7's point is that logs are themselves
security-sensitive data — a log that records a bearer token hands anyone with
log access a working login. The user **id** is logged, which is enough to
investigate an incident and useless for impersonation.

---

## 7. What this service does not own

| Table | Owner | This service |
|---|---|---|
| `users`, `sessions` | Schedule & Arrival (login) | reads only |
| `students`, `attendance` | Schedule & Arrival | reads `students` for impact counts |
| `holidays` | Favorites & Alerts | reads only |
| `favorites`, `alerts` | Favorites & Alerts | never touches |
| `audit_log` | shared | appends only |

The two cross-service reads are deliberately tolerant: if `students` or
`holidays` does not exist yet, the code logs a warning and carries on without
that information. Knowing who to tell is useful, but it must never be able to
block a cancellation.

---

## 8. Running it

```bash
cp .env.example .env     # then paste the Neon connection string
npm install
npm test                 # 47 tests, no database needed
npm run dev              # http://localhost:3001/api/health
```

`docs/requests.http` sends every request in the test plan from VS Code with
the REST Client extension. Deployment and the cloud services are in
[`infra/README.md`](../infra/README.md).
