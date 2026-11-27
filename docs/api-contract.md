# API contract — Route & Stop

Service owner: Yahia Wael (247330). Base path `/api`. All requests and
responses are JSON. How the backend works is explained in
[architecture.md](architecture.md).

Local: `http://localhost:3001` · Floci:
`http://<api-id>.execute-api.localhost.floci.io:4566` (printed by
`infra/deploy.sh`)

---

## Data dictionary

### Route

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | id | server | immutable; letters, digits, `-`, `_`, `:` |
| `code` | string | client | required, 2–20, letters/numbers/hyphens, unique, stored upper-case |
| `name` | string | client | required, 3–100, trimmed |
| `area` | string | client | required, 2–100, trimmed |
| `is_active` | boolean | client | defaults true; false hides the route from parents |
| `created_at`, `updated_at` | timestamp | server | immutable |

### Stop

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | id | server | immutable; letters, digits, `-`, `_`, `:` |
| `route_id` | id | server | from the URL, never the body |
| `name` | string | client | required, 3–100 |
| `landmark` | string \| null | client | optional, 3–150 |
| `stop_order` | int | **server** | always 1..n, no gaps. Changed only via the reorder endpoint |

### Bus

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | id | server | immutable; letters, digits, `-`, `_`, `:` |
| `plate_number` | string | client | required, 3–20, unique |
| `capacity` | int | client | 1–100, default 40 |
| `route_id` | id \| null | client | must exist |
| `supervisor_id` | id \| null | client | must exist and have role `supervisor` |

### Route schedule

| Field | Type | Source | Rule |
|---|---|---|---|
| `run_type` | enum | client | `morning` or `afternoon`; one schedule per route per run |
| `days_of_week` | int[] | client | 1–7 values, ISO (1 = Monday, 7 = Sunday), no repeats |
| `bus_id` | id \| null | client | must exist |
| `active_from` / `active_to` | date \| null | client | `YYYY-MM-DD`; `active_to` null means open-ended |

### Trip

A Trip is the **recurring run** for one route and one run type, in Ahmed's
table design. It is not one row per day. Cancelling a single day sets
`cancelled_date`.

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | id | **server** | `trip:<route_id>:<run_type>` |
| `route_id` | id | client | must exist, be active and have at least 1 stop |
| `bus_id` | id \| null | client | must not be double-booked for that run |
| `run_type` | enum | client | `morning` or `afternoon` |
| `status` | enum | **server** | `active` on creation; only ever moves to `cancelled` |
| `cancelled_date` | date \| null | client on cancel | `YYYY-MM-DD`, the day called off |
| `cancellation_reason` | string \| null | client on cancel | 3 to 200 characters |
| `source` | enum | server | `manual`, `generated` or `seed` |

A route has at most one `morning` trip and one `afternoon` trip.

---

## Endpoints

`A` = admin · `L` = any logged-in user · `S` = service credential

| Method | Path | Who | Purpose | OK | Errors |
|---|---|---|---|---|---|
| GET | `/api/health` | — | is the service running | 200 | — |
| GET | `/api/ready` | — | can it reach the database | 200 | 503 |
| GET | `/api/routes` | L | ranked search, paged | 200 | 400, 401, 429 |
| GET | `/api/routes/:id` | L | one route with its stops | 200 | 400, 401, 404 |
| POST | `/api/routes` | A | create a route | 201 | 400, 401, 403, 409, 415, 429 |
| PUT | `/api/routes/:id` | A | update a route | 200 | 400, 401, 403, 404, 409, 415 |
| DELETE | `/api/routes/:id` | A | delete a route with no trips | 204 | 400, 401, 403, 404, 409 |
| POST | `/api/routes/:id/stops` | A | add a stop | 201 | 400, 401, 403, 404, 415 |
| PUT | `/api/routes/:id/stops/order` | A | reorder every stop atomically | 200 | 400, 401, 403, 404, 415 |
| PUT | `/api/stops/:id` | A | rename a stop | 200 | 400, 401, 403, 404, 415 |
| DELETE | `/api/stops/:id` | A | delete a stop, closing the gap | 204 | 400, 401, 403, 404 |
| GET | `/api/buses` | A | list buses | 200 | 401, 403 |
| POST | `/api/buses` | A | add a bus | 201 | 400, 401, 403, 404, 409, 415 |
| GET | `/api/routes/:id/schedule` | A | the recurring pattern | 200 | 400, 401, 403 |
| PUT | `/api/routes/:id/schedule` | A | set the recurring pattern | 200 | 400, 401, 403, 404, 415 |
| GET | `/api/trips` | L | search by route, day, status, run | 200 | 400, 401, 429 |
| GET | `/api/trips/:id` | L | one trip | 200 | 400, 401, 404 |
| GET | `/api/trips/:id/impact` | A | who a cancellation would affect | 200 | 400, 401, 403, 404 |
| POST | `/api/trips` | A | create one trip, conflict-checked | 201 | 400, 401, 403, 404, **409**, 415 |
| PATCH | `/api/trips/:id/status` | A | cancel a trip | 200 | 400, 401, 403, 404, 409, 415 |
| POST | `/api/trips/generate` | A | preview or commit generated trips | 200 / 201 | 400, 401, 403, 415, 429 |
| GET | `/api/internal/cron/generate` | S | the daily scheduled run | 200 | 401 |
| POST | `/api/internal/events/retry` | S | resend anything unsent to the queue | 200 | 401 |

---

## Examples

### Search routes

`GET /api/routes?search=maadi&page=1&limit=20`

```json
{
  "items": [
    { "id": "…", "code": "R-01", "name": "Maadi Morning Line",
      "area": "Maadi", "is_active": true, "stop_count": 3 }
  ],
  "page": 1, "limit": 20, "total": 1, "pages": 1
}
```

Results are ranked: exact code first, then code prefix, then name, then
area. An empty result is `200` with `"items": []`, never `404`.

### Reorder stops

`PUT /api/routes/:id/stops/order` — send either form:

```json
{ "stop_ids": ["<id-3>", "<id-1>", "<id-2>"] }
```
```json
{ "move": { "stop_id": "<id>", "to_position": 1 } }
```

```json
{ "route_id": "…", "moved": 2, "stops": [ { "id": "…", "stop_order": 1 }, "…" ] }
```

A partial list, a repeated id, or a stop from another route is `400`.

### Create a trip that clashes

`POST /api/trips`

```json
{ "route_id": "route-cairo-demo", "bus_id": "bus-demo-1", "run_type": "morning" }
```

```http
HTTP/1.1 409 Conflict
```
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "This trip clashes with the existing timetable.",
    "details": {
      "conflicts": [
        { "code": "BUS_DOUBLE_BOOKED",
          "message": "That bus is already running another morning trip on recurring." }
      ]
    },
    "request_id": "..."
  }
}
```

### Generate trips (preview is the default)

`POST /api/trips/generate`

```json
{ "dry_run": true }
```

```json
{
  "trips": [
    { "route_id": "route-demo-nasr", "bus_id": "bus-demo-2", "run_type": "afternoon" }
  ],
  "skipped": [
    { "route_id": "route-demo-maadi", "run_type": "morning",
      "reason": "trip_already_exists" }
  ],
  "summary": {
    "schedules": 4, "planned": 1, "skipped": 3,
    "skipped_by_reason": { "trip_already_exists": 3 }
  },
  "created": 0,
  "dry_run": true
}
```

Send `"dry_run": false` to commit; the response is `201` and `created` is
the number written.

### Cancel a trip for a day

`PATCH /api/trips/:id/status`

```json
{ "status": "cancelled", "reason": "Bus 14 is in for repair", "date": "2026-11-30" }
```

`date` is optional and defaults to today.

```json
{
  "id": "trip:route-cairo-demo:morning",
  "status": "cancelled",
  "run_type": "morning",
  "cancelled_date": "2026-11-30",
  "cancellation_reason": "Bus 14 is in for repair",
  "cancelled_at": "2026-11-29T19:40:11.482Z",
  "impact": {
    "stop_count": 3,
    "stops": [ { "id": "stop-demo-maadi-1", "name": "Road 9 Corner", "stop_order": 1 } ],
    "affected_students": 12,
    "affected_parents": 11
  },
  "event_id": "9f1c7a52-0b3e-4f1a-9c21-7d5a1e2f4b60",
  "event_delivered": true
}
```

`event_id` is the message sent to Ali's queue, and it is his idempotency
key. `event_delivered` is false when SQS could not be reached; the event is
stored as unsent and the daily run retries it. The cancellation itself has
still happened.

`affected_students` and `affected_parents` are `null` when the `Students`
table is not readable; the cancellation still succeeds.

---

## Errors

Every failure uses one shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "request_id": "…" } }
```

`details` is added where it helps — the list of conflicts on a 409.

| Status | Code | Returned when |
|---|---|---|
| 400 | `VALIDATION_ERROR` | a field is missing, the wrong type, out of range, a non-existent date, or a server-owned field was sent |
| 401 | `UNAUTHENTICATED` | no token, an unknown token, or an expired session |
| 403 | `FORBIDDEN` | logged in, wrong role |
| 403 | `BOT_CHECK_FAILED` | the Turnstile token was missing or rejected |
| 404 | `RESOURCE_NOT_FOUND` | the id in the URL does not exist |
| 404 | `ROUTE_NOT_FOUND` | the method and path are not an endpoint |
| 409 | `CONFLICT` | duplicate code or plate, a timetable clash, or deleting a route that has trips |
| 409 | `IDEMPOTENCY_KEY_REUSED` | the same key with a different body |
| 413 | `PAYLOAD_TOO_LARGE` | the body is over 32 kb |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | the body is not `application/json` |
| 429 | `RATE_LIMITED` | over the budget; `Retry-After` says how long to wait |
| 500 | `INTERNAL_ERROR` | an unexpected failure; details are only in the server log |
| 503 | `SERVICE_UNAVAILABLE` | the database or Cloudflare could not be reached |

---

## Headers

**Sent by the client**

| Header | When |
|---|---|
| `Authorization: Bearer <token>` | every endpoint except `/api/health` and `/api/ready` |
| `Content-Type: application/json` | every POST, PUT and PATCH |
| `Idempotency-Key: <unique string>` | optional on creates; replays the first response |
| `X-Turnstile-Token: <token>` | writes, when Turnstile is enabled |
| `X-Internal-Key: <secret>` | `/api/internal/*` only |

**Returned by the API**

`X-Request-Id` on every response · `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset` on limited endpoints · `Retry-After` on 429 ·
`Idempotent-Replay: true` on a replayed response · `Location` on 201.
