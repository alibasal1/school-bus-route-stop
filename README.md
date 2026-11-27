# school-bus-route-stop

School Bus Route Tracker — Team 14 (Lab Group A-2), 26CSCN29H.

**Service:** Route & Stop
**Owner:** Yahia Wael (247330)
**Runs on:** Floci (DynamoDB, Lambda, API Gateway, SQS, EventBridge,
CloudWatch, IAM). Not Vercel, not Neon.

The Neon and Vercel version is kept on the `neon-version` branch.

## What this service does

Not CRUD. Four pieces of real behaviour, explained in
[`docs/architecture.md`](docs/architecture.md):

1. **Conflict detection.** Before a trip is written it is checked against
   the whole timetable: the route already has that run, the bus is out on
   another route, the bus's supervisor is on another bus, the route is
   retired or has no stops. The answer is 409 listing every reason, not a
   database error.
2. **Atomic stop resequencing.** `stop_order` is always 1..n with no gaps.
   The client says what the order should be; the server computes the
   smallest set of changes and applies them in one `TransactWriteItems`.
   Deleting a stop closes the gap in the same transaction.
3. **Trip generation.** The admin describes each route's pattern once; the
   service works out which trips should exist, skips what is there and
   refuses what would double-book, with a reason for each. Preview by
   default. A daily EventBridge rule runs the same code.
4. **Cancellation impact and the outbox.** Cancelling works out which stops
   and how many families are affected, and writes the alert event before
   sending it to Ali's queue, so an alert cannot be lost when his service
   is down.

## The whole project

| Repo | What | Owner |
|---|---|---|
| `school-bus-frontend` | React app, all pages | Whole team |
| `school-bus-route-stop` | Route & Stop API | Yahia |
| `school-bus-schedule-arrival` | Schedule & Arrival, signup and login | Ahmed |
| `school-bus-favorites-alerts` | Favorites & Alerts | Ali |

One DynamoDB database on Floci, Ahmed's table design. Each service has its
own API Gateway, and the frontend calls each one directly. Login comes from
Ahmed; this service only checks the token against the shared tables.

## Tables

| Table | This service |
|---|---|
| `Routes`, `Stops`, `Buses`, `RouteSchedules`, `TripEvents`, `IdempotencyKeys` | owns |
| `Trips`, `TripStops` | **creates and cancels**; Ahmed reads them |
| `Users`, `Sessions` | **read only** |

A **Trip is the recurring run for one route and one run type**, in Ahmed's
design, not one row per day. Cancelling a single day sets `cancelled_date`.
This is written up in `docs/architecture.md` section 5 and **needs
confirming with Ahmed**.

## Folders

```
app.js          the Express app (no listen, so it runs anywhere)
server.js       starts it on a PC, port 3001
lambda.js       starts it on Lambda, with the Buffer body fix
routes/         method + path -> guards -> controller. The access map.
controllers/    validation and status codes. Never touches a table.
services/       all DynamoDB access, plus the SQS sender. Never sees req.
lib/            pure logic: planning, resequencing, validation, dates
middleware/     auth, rate limit, Turnstile, idempotency, logging, errors
db/dynamo.js    one Document client, paginated reads
config/         secrets, when Secrets Manager is in use
infra/          deploy.sh, one command for the whole stack
scripts/        zip, seed, cleanup, test sessions
tests/unit      50 tests, no AWS
tests/api       Jest and Supertest, no AWS
loadtest/       k6
docs/           architecture, contract, test plan, threat model, events
evidence/       test output and screenshots
```

## Run it

```bash
cp .env.example .env
npm install
npm run test:unit        # 50 tests, no AWS needed
npm run test:api         # Jest + Supertest, no AWS needed
npm run dev              # http://localhost:3001/api/health
```

## Deploy it

```bash
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
bash infra/deploy.sh     # prints the API address
npm run seed
node scripts/make-test-sessions.js
```

Detail, including what to do when something fails:
[`infra/README.md`](infra/README.md).

## The seven AWS services

| Service | What it does here |
|---|---|
| **Lambda** | runs the API. `lambda.js` wraps the same `app.js` that `server.js` runs locally |
| **API Gateway** | the public address. Only this service's routes, plus OPTIONS. Throttling 10 rps, burst 20 |
| **DynamoDB** | the data. Ahmed's table design, shared by the three services |
| **SQS** (sender) | trip events to Ali's queue, so a cancellation reaches parents even if his service is down |
| **EventBridge** | a daily rule that generates trips and resends any event whose send failed |
| **CloudWatch Logs** | one JSON line per request, a metric filter on the SECURITY lines, and an alarm |
| **IAM** | least privilege: write own tables, read-only Users and Sessions, send to one queue |

## Endpoints

`A` = admin, `L` = any signed-in user, `S` = service key.

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | is the service running |
| GET | `/api/ready` | — | can it reach DynamoDB |
| GET | `/api/routes` | L | ranked search, paged |
| GET | `/api/routes/:id` | L | one route with its stops |
| POST | `/api/routes` | A | create a route |
| PUT | `/api/routes/:id` | A | rename, change area, retire |
| DELETE | `/api/routes/:id` | A | delete a route with no trips |
| POST | `/api/routes/:id/stops` | A | add a stop |
| PUT | `/api/routes/:id/stops/order` | A | reorder every stop atomically |
| PUT | `/api/stops/:id` | A | rename a stop |
| DELETE | `/api/stops/:id` | A | delete a stop, closing the gap |
| GET | `/api/buses` | A | list buses |
| POST | `/api/buses` | A | add a bus |
| GET | `/api/routes/:id/schedule` | A | the saved pattern |
| PUT | `/api/routes/:id/schedule` | A | set the pattern |
| GET | `/api/trips` | L | search by route, day, status, run |
| GET | `/api/trips/:id` | L | one trip |
| GET | `/api/trips/:id/impact` | A | who a cancellation would affect |
| POST | `/api/trips` | A | create one trip, conflict checked |
| PATCH | `/api/trips/:id/status` | A | cancel a run for a day |
| POST | `/api/trips/generate` | A | preview or commit generated trips |
| GET | `/api/internal/cron/generate` | S | the daily scheduled run |
| POST | `/api/internal/events/retry` | S | resend anything unsent to the queue |

Full contract with examples and error codes:
[`docs/api-contract.md`](docs/api-contract.md).

## Git rules

- Small commits on `main`, pushed after each step.
- **Never** commit `.env` or `.test-tokens.local`. Only `.env.example`.
- The tests must pass before pushing.
- Never drop or empty a shared table. Never touch Ali's or Ahmed's
  resources.

## Docs

| File | What |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | how the backend works: layers, trust boundary, tables and ownership, the four non-CRUD features |
| [`docs/api-contract.md`](docs/api-contract.md) | data dictionary, endpoints, examples, error codes |
| [`docs/api-test-plan.md`](docs/api-test-plan.md) | unit, API, ST-01 to ST-10 on Floci, and k6 |
| [`docs/threat-model.md`](docs/threat-model.md) | 8 threats, each naming the file with the control and the test that proves it |
| [`docs/events.md`](docs/events.md) | the SQS contract with Ali |
| [`docs/cloud-services.md`](docs/cloud-services.md) | why each cloud service is here |
| [`infra/README.md`](infra/README.md) | deployment |
