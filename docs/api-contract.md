# API contract — Route & Stop

Service owner: Yahia Wael (247330). Base path `/api`. All requests and
responses are JSON. How the backend works is explained in
[architecture.md](architecture.md).

Local: `http://localhost:3001` · Deployed: `https://school-bus-route-stop.vercel.app`

---

## Data dictionary

### Route

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | uuid | server | immutable |
| `code` | string | client | required, 2–20, letters/numbers/hyphens, unique, stored upper-case |
| `name` | string | client | required, 3–100, trimmed |
| `area` | string | client | required, 2–100, trimmed |
| `is_active` | boolean | client | defaults true; false hides the route from parents |
| `created_at`, `updated_at` | timestamp | server | immutable |

### Stop

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | uuid | server | immutable |
| `route_id` | uuid | server | from the URL, never the body |
| `name` | string | client | required, 3–100 |
| `landmark` | string \| null | client | optional, 3–150 |
| `stop_order` | int | **server** | always 1..n, no gaps. Changed only via the reorder endpoint |

### Bus

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | uuid | server | immutable |
| `plate_number` | string | client | required, 3–20, unique |
| `capacity` | int | client | 1–100, default 40 |
| `route_id` | uuid \| null | client | must exist |
| `supervisor_id` | uuid \| null | client | must exist and have role `supervisor` |

### Route schedule

| Field | Type | Source | Rule |
|---|---|---|---|
| `run_type` | enum | client | `morning` or `afternoon`; one schedule per route per run |
| `days_of_week` | int[] | client | 1–7 values, ISO (1 = Monday, 7 = Sunday), no repeats |
| `bus_id` | uuid \| null | client | must exist |
| `active_from` / `active_to` | date \| null | client | `YYYY-MM-DD`; `active_to` null means open-ended |

### Trip

| Field | Type | Source | Rule |
|---|---|---|---|
| `id` | uuid | server | immutable |
| `route_id` | uuid | client | must exist, be active and have ≥1 stop |
| `bus_id` | uuid \| null | client | must not be double-booked for that slot |
| `service_date` | date | client | `YYYY-MM-DD`, not in the past |
| `run_type` | enum | client | `morning` or `afternoon` |
| `status` | enum | **server** | `active` on creation; only ever moves to `cancelled` |
| `cancellation_reason` | string \| null | client on cancel | 3–200 |
| `source` | enum | server | `manual` or `generated` |

A route, a day and a run identify at most one active trip.

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
| GET | `/api/trips` | L | search by route, day, range, status | 200 | 400, 401, 429 |
| GET | `/api/trips/:id` | L | one trip | 200 | 400, 401, 404 |
| GET | `/api/trips/:id/impact` | A | who a cancellation would affect | 200 | 400, 401, 403, 404 |
| POST | `/api/trips` | A | create one trip, conflict-checked | 201 | 400, 401, 403, 404, **409**, 415 |
| PATCH | `/api/trips/:id/status` | A | cancel a trip | 200 | 400, 401, 403, 404, 409, 415 |
| POST | `/api/trips/generate` | A | preview or commit generated trips | 200 / 201 | 400, 401, 403, 415, 429 |
| GET | `/api/internal/cron/generate` | S | the scheduled run | 200 | 400, 401 |
| GET | `/api/internal/events` | S | unpublished outbox events | 200 | 400, 401 |
| POST | `/api/internal/events/ack` | S | mark events published | 200 | 400, 401 |

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
{ "route_id": "…", "bus_id": "…", "service_date": "2026-03-01", "run_type": "morning" }
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
          "message": "That bus is already running another morning trip on 2026-03-01." }
      ]
    },
    "request_id": "…"
  }
}
```

### Generate trips (preview is the default)

`POST /api/trips/generate`

```json
{ "from": "2026-03-01", "to": "2026-03-07", "dry_run": true }
```

```json
{
  "trips": [ { "route_id": "…", "service_date": "2026-03-01", "run_type": "morning" } ],
  "skipped": [
    { "route_id": "…", "service_date": "2026-03-06", "run_type": "morning",
      "reason": "not_a_service_day" },
    { "route_id": "…", "service_date": "2026-03-03", "run_type": "morning",
      "reason": "public_holiday" }
  ],
  "summary": {
    "from": "2026-03-01", "to": "2026-03-07", "days": 7, "schedules": 2,
    "planned": 9, "skipped": 5,
    "skipped_by_reason": { "not_a_service_day": 4, "public_holiday": 1 }
  },
  "created": 0,
  "dry_run": true
}
```

Send `"dry_run": false` to commit; the response is `201` and `created` is the
number of rows written.

### Cancel a trip

`PATCH /api/trips/:id/status`

```json
{ "status": "cancelled", "reason": "Bus 14 is in for repair" }
```

```json
{
  "id": "…", "status": "cancelled", "service_date": "2026-03-01",
  "run_type": "morning", "cancellation_reason": "Bus 14 is in for repair",
  "cancelled_at": "2026-02-28T19:40:11.482Z",
  "impact": {
    "stop_count": 3,
    "stops": [ { "id": "…", "name": "Road 9 Corner", "stop_order": 1 } ],
    "affected_students": 12,
    "affected_parents": 11
  },
  "event_id": "…"
}
```

`event_id` is the outbox row written in the same transaction. It is what the
Favorites & Alerts service eventually receives from SNS, and it doubles as
that service's idempotency key.

`affected_students` and `affected_parents` are `null` when the Schedule &
Arrival schema has not been applied yet; the cancellation still succeeds.

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
