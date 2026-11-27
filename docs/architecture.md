# Route & Stop — how the backend works

Service owner: Yahia Wael (247330), Team 14, 26CSCN29H.

This explains the backend rather than listing endpoints. The endpoint list
is in [api-contract.md](api-contract.md).

Running on **Floci**: DynamoDB, Lambda, API Gateway, SQS, EventBridge,
CloudWatch, IAM. Neon and Vercel are gone; the old version is on the
`neon-version` branch.

---

## 1. What this service is for

Three people need three different things from the same timetable. The
**admin** plans it: routes, the stops along them, the buses, and which trips
run. The **parent** reads it: which route serves their area, which stop is
theirs, is there a bus tomorrow. The **supervisor** needs to know which trip
they are on.

The hard part is not storing that. It is keeping the three views consistent
while one person edits them: a stop cannot be fourth and fifth at the same
time, a bus cannot be on two routes at 07:00, and a cancelled trip cannot
leave a parent waiting because an alert was lost. Those are the problems
this service exists to solve, and they are why it is not a set of CRUD
endpoints.

---

## 2. The three layers

```
API Gateway  (only this service's routes, throttled)
    |
Lambda  route-stop-api   lambda.js -> app.js
    |
routes/routes.js        method + path -> guards -> one controller function
    |                   the complete access-control map
controllers/routes.js   validates input, chooses the status code
    |                   knows HTTP. Never touches a table.
services/routes.js      all DynamoDB access, all business rules
    |                   knows the tables. Never sees req or res.
db/dynamo.js            one Document client, paginated reads
    |
DynamoDB  +  SQS (send only, to Ali's queue)
```

Alongside them sits `lib/`: `tripPlanner.js` (what should exist),
`resequence.js` (what a valid stop order looks like), `validate.js`,
`dates.js`. Pure functions over plain data, no AWS and no HTTP.

**Why the boundaries are there.** The move from Neon to DynamoDB touched
`db/` and `services/routes.js` and **nothing else**: not one route, not one
controller, not one test in `tests/unit/`. That is the layering paying for
itself. The 50 unit tests still run in under a second with no database at
all, because the logic they test never had one.

---

## 3. The trust boundary

```
UNTRUSTED                           |  TRUSTED
browser, Postman, curl, a script ---+---> API --> DynamoDB
                                    |
                      the boundary is the HTTP request
```

Our own React page is not special: anyone can open DevTools or skip the page
and call the API with curl. Frontend validation is a convenience; the checks
in `controllers/routes.js` are the ones that decide anything.

Four rules:

1. **Every request is validated.** Types, lengths, enums, date realism
   (`2026-02-31` parses but is not a day), and id format.
2. **The client never owns server fields.** `id`, `status`, `created_at`,
   `stop_order`, `cancelled_date` are refused if sent, not ignored, so an
   attempt shows in the log instead of vanishing.
3. **The browser never reaches the database.** Only the Lambda does, and
   only with what its IAM role allows.
4. **Errors say what the caller did wrong and nothing else.** Internals are
   logged with a request id; the caller gets the id and a generic message.

### Ids

Ids are no longer UUIDs, because Ahmed's data uses readable keys like
`route-cairo-demo`. The rule in `lib/validate.js` is an allow-list:
letters, digits, hyphen, underscore, colon, 1 to 128 characters. An
allow-list rather than a block-list, because listing what is safe holds
against inputs nobody thought of.

The **type** is checked before the pattern. A JSON body can carry an object
where a string is expected, and `{"$ne": null}` reaching a query is the
NoSQL version of `' OR 1=1`.

### Authentication and authorisation are separate questions

```js
router.post('/routes', requireAuth, requireRole('admin'), writeLimit,
            verifyTurnstile, idempotent('POST /api/routes'), c.createRoute)
```

`requireAuth` answers *who is this* (401). `requireRole` answers *may they
do this* (403). Mixing them is how a logged-in parent ends up able to edit
routes.

Login lives in Ahmed's service. This one hashes the bearer token with
SHA-256, reads `Sessions` by that hash, checks `expires_at` in Unix
seconds, then reads `Users` for the role. The table stores only hashes, so a
dump of it contains nothing anyone can log in with.

---

## 4. One request, end to end

`POST /api/trips`:

| # | Where | What happens |
|---|---|---|
| 1 | API Gateway | route matched, throttle applied, event built |
| 2 | `lambda.js` | body turned from a Buffer into a string, event attached for the rate limiter |
| 3 | `app.js` | request id, security headers, log line, CORS, 32 kb body cap |
| 4 | `routes/routes.js` | `requireAuth` → `requireRole('admin')` → rate limit → Turnstile → idempotency |
| 5 | `controllers/routes.js` | fields validated; a bad id is 400 here |
| 6 | `services/routes.js` | loads the route, its stops, the bus, and every active trip |
| 7 | `lib/tripPlanner.js` | `findConflicts()` — a clash is **409 with the reasons listed** |
| 8 | `services/routes.js` | conditional `PutItem`, then the event is written and sent |
| 9 | controller | 201, and an AUDIT line |

Every status code is produced in exactly one known place:

| Status | Code | Produced by |
|---|---|---|
| 400 | `VALIDATION_ERROR` | controller, or `errorHandler` for bad JSON |
| 401 | `UNAUTHENTICATED` | `middleware/auth.js` |
| 403 | `FORBIDDEN` / `BOT_CHECK_FAILED` | `requireRole` / `verifyTurnstile` |
| 404 | `RESOURCE_NOT_FOUND` | controller, when the service returns null |
| 404 | `ROUTE_NOT_FOUND` | `routeNotFound` in `app.js` |
| 409 | `CONFLICT` | service, from `findConflicts` or a failed condition |
| 413 | `PAYLOAD_TOO_LARGE` | `errorHandler` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `requireJsonBody` |
| 429 | `RATE_LIMITED` | `middleware/rateLimit.js` |
| 500 | `INTERNAL_ERROR` | `errorHandler` |
| 503 | `SERVICE_UNAVAILABLE` | DynamoDB unreachable or access denied |

All of them use one body shape, so the frontend handles every failure the
same way:

```json
{ "error": { "code": "CONFLICT", "message": "...", "request_id": "..." } }
```

---

## 5. Tables, and who owns what

**This matters for the team. Confirm the Trips row with Ahmed.**

| Table | Key | This service | Owner |
|---|---|---|---|
| `Routes` | `id` (+ `name-index`, `area-index`) | read and write | me |
| `Stops` | `id` (+ `route-id-index`) | read and write | me |
| `Buses` | `id` (+ `route-id-index`, `supervisor-id-index`) | read and write | me |
| `RouteSchedules` | `id` (+ `route-id-index`) | read and write | me |
| `TripEvents` | `event_id` (+ `sent-index`) | read and write | me |
| `Trips` | `id` (+ `route-id-index`) | **creates and cancels** | Ahmed's design |
| `TripStops` | `trip_id` + `stop_id` | writes when a trip is made | Ahmed's design |
| `Users` | `user_id` | **read only** | Ahmed |
| `Sessions` | `id` | **read only** | Ahmed |
| `IdempotencyKeys` | `id`, TTL `expires_at` | read and write | me |

### The Trips change, and why it needs confirming

In Ahmed's design a **Trip is the recurring run for one route and one run
type** — "R1 morning" — not one row per day. Cancelling a single day sets
`cancelled_date`.

That is different from the Neon version of this service, where a trip was
one day. Three things follow, and Ahmed should agree with all three:

1. A trip's id is `trip:<route_id>:<run_type>`, so a route has at most one
   morning trip and one afternoon trip. Creating a second is a 409.
2. `POST /api/trips` no longer takes `service_date`. The date appears only
   when cancelling.
3. "Generating trips" now means making sure every active route with stops
   has the trips its schedule describes, rather than filling a calendar.
   The daily EventBridge run does this.

If Ahmed expects one row per day instead, only `services/routes.js` changes:
the shape of a trip is not baked into the routes, the controller or the
frontend.

---

## 6. The four things that are not CRUD

### 6.1 Conflict detection

Before any trip is written, `findConflicts()` checks it against the route's
state and every other active trip:

| Code | Refused because |
|---|---|
| `ROUTE_SLOT_TAKEN` | the route already has that run |
| `BUS_DOUBLE_BOOKED` | the bus is already out on another route then |
| `SUPERVISOR_DOUBLE_BOOKED` | the bus's supervisor is on another bus then |
| `BUS_ROUTE_MISMATCH` | the bus belongs to a different route |
| `ROUTE_INACTIVE` | the route is retired |
| `ROUTE_HAS_NO_STOPS` | there is nowhere for the bus to stop |

The caller gets 409 with every reason, not a database error. A conditional
`PutItem` is the backstop for two admins saving in the same instant, since
DynamoDB cannot express most of these as a constraint.

### 6.2 Atomic stop resequencing

`stop_order` must always be 1..n with no gaps: Ahmed's service walks the
stops in order and the parent app says "your stop is 4th". Letting the
client set its own numbers breaks that three ways — a dropped request leaves
a gap, two admins produce duplicates, a typo sends a stop to position 99.

So the client says what the order should be (the full list, or
`{ stop_id, to_position }`), `lib/resequence.js` computes the smallest set
of changes, and they go in one `TransactWriteItems`. Deleting a stop closes
the gap in the same transaction, and `stop_order` is refused outright on the
stop-update endpoint.

This is where SQL and DynamoDB differ most. The SQL version leaned on a
`DEFERRABLE UNIQUE` constraint; DynamoDB has no such thing, so the guarantee
comes from the transaction plus the rule that only this one function sets
`stop_order`.

### 6.3 Trip generation

The admin describes the pattern once in `RouteSchedules` — "R1 runs morning
and afternoon, Sunday to Thursday" — and generation expands it, skipping
what already exists and refusing anything that would double-book a bus or a
supervisor, with a reason for each. `dry_run` is the **default**, so the
plan is always visible before anything is written. The EventBridge rule runs
the same code daily.

### 6.4 Cancellation impact, and the outbox

Cancelling is not a status flip. The service works out which stops and how
many families are affected (reading Ahmed's `Students` table if present,
tolerantly), returns that with the response, and writes the alert event to
`TripEvents` **before** sending it to Ali's queue.

Sending inside the request and hoping is how an admin sees "cancelled" while
nobody is told. A failed send stays unsent and the daily run sweeps it.
Delivery is at-least-once, so `event_id` is the consumer's idempotency key.
Full contract: [events.md](events.md).

---

## 7. Keeping the service standing up

| Concern | How |
|---|---|
| Traffic | Three rate-limit tiers keyed on `requestContext.http.sourceIp`, never `X-Forwarded-For`. API Gateway throttling 10 rps burst 20 as well. |
| Bots | Turnstile verified server-side on writes; skipped on Floci with a SECURITY line, see the threat model. |
| Abuse of size | Body 32 kb, `limit` capped, reorder capped at 100 stops. |
| Repeats | `Idempotency-Key` on creates, stored in DynamoDB with a TTL. |
| Injection | Allow-list ids, type checks, and values only ever as `ExpressionAttributeValues`. |
| Blast radius | IAM: write own tables, read-only Users and Sessions, send to one queue, own logs. No `"*"`. |
| Who did what | One `AUDIT` line per state-changing action. |
| Diagnosis | One JSON log line per request with a request id, echoed in every error body. `/api/health` (running) separate from `/api/ready` (can reach DynamoDB). |

Never logged: bodies, `Authorization` headers, tokens, query strings. A log
holding a bearer token hands anyone with log access a working login. The
user **id** is logged, which is enough to investigate and useless for
impersonation.

### Where this design would stop scaling

Honest limits, since the marking asks for judgement rather than a clean
story:

- **Route search is a Scan.** Right for one school's handful of routes,
  wrong at ten thousand. The fix is a search attribute or OpenSearch, not a
  bigger scan. `db/dynamo.js` caps it at 2000 items.
- **`stop_count` is counted per route on every search.** Fine for a few
  routes; it would become a stored counter.
- **Rate limiting is in memory**, so it is per Lambda container.
- **The outbox is two steps, not one transaction.** `TransactWriteItems`
  across the trip and the event would close the millisecond window.

---

## 8. Running it

```bash
cp .env.example .env
npm install
npm run test:unit                       # 50 tests, no AWS
npm run test:api                        # Jest + Supertest, no AWS
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
bash infra/deploy.sh                    # prints the API address
npm run seed
node scripts/make-test-sessions.js
```

Deployment detail is in [../infra/README.md](../infra/README.md); the test
plan is in [api-test-plan.md](api-test-plan.md).
