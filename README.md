# school-bus-route-stop

School Bus Route Tracker — Team 14 (Lab Group A-2), 26CSCN29H.

**Service:** Route & Stop
**Owner:** Yahia Wael (247330)
**Local port:** 3001

This repo holds one backend service: routes, stops, buses, recurring
schedules, and trips.

## What this service actually does

Not CRUD. Four pieces of real behaviour, explained in
[`docs/architecture.md`](docs/architecture.md):

1. **Trip generation.** The admin describes a route's recurring pattern once
   ("morning run, Sunday to Thursday, from 1 September") and the service
   expands it over a date range — skipping non-service days, public holidays
   taken from the Favorites & Alerts service, days that already have a trip,
   and anything that would double-book a bus. A preview shows what would be
   created and why each day was skipped, before anything is written. A
   scheduled job runs the same code weekly so the timetable always reaches
   three weeks ahead.

2. **Conflict detection.** Before a trip is written it is checked against the
   whole calendar: slot already taken, bus out on another route, the bus's
   supervisor already on another bus, a route with no stops, a retired route.
   The answer is 409 with every reason listed, not a database error. Two of
   the rules are also enforced by database constraints, so two admins saving
   at the same instant cannot slip past.

3. **Atomic stop resequencing.** `stop_order` is always 1..n with no gaps.
   The client says what the order should be; the service computes the
   smallest set of changes and applies them in one transaction against a
   deferrable constraint. Deleting a stop closes the gap in the same
   transaction.

4. **Cancellation impact and the outbox.** Cancelling works out which stops
   and how many families are affected, and writes the alert event in the
   **same transaction** as the status change — so an alert can never be lost
   because another service was down. A Lambda drains those events to SNS.

## The whole project

| Repo | What it holds | Owner |
|---|---|---|
| `school-bus-frontend` | React app (all pages) | Whole team |
| `school-bus-route-stop` | Route & Stop API | Yahia |
| `school-bus-schedule-arrival` | Schedule & Arrival API + Signup / Login | Ahmed |
| `school-bus-favorites-alerts` | Favorites & Alerts API | Ali |

Three service repos plus one frontend repo, as the Phase 1 feedback asked
for. All three APIs use the same Neon database and each writes only to its
own tables. Login happens in `school-bus-schedule-arrival`; the other
services check the same session token with their own copy of
`middleware/auth.js`.

## Folders

```
app.js          the Express app (importable: Vercel, Lambda, tests)
server.js       starts it on a laptop
routes/         method + path -> guards -> controller. The access map.
controllers/    validation and status codes. Never writes SQL.
services/       all SQL and transactions. Never sees req or res.
lib/            pure logic: trip planning, resequencing, validation, dates
middleware/     auth, rate limiting, Turnstile, idempotency, logging, errors
db/             Neon connection, schema.sql
tests/          47 unit tests, no database needed
docs/           architecture, API contract, test plan, threat model
infra/          Upstash, Turnstile, Vercel Cron, AWS forwarder + IAM
```

## Run it

```bash
cp .env.example .env     # then paste the Neon connection string
npm install
npm test                 # 47 tests, no database needed
npm run dev
```

Check: <http://localhost:3001/api/health> (running) and
<http://localhost:3001/api/ready> (database reachable).

`docs/requests.http` sends every test in the plan from VS Code with the REST
Client extension.

## Database setup (once, in the Neon SQL Editor)

Run in this order:

1. `school-bus-schedule-arrival/db/auth-schema.sql` — `users`, `sessions`
2. `school-bus-route-stop/db/schema.sql` — **this repo**
3. `school-bus-schedule-arrival/db/schema.sql`
4. `school-bus-favorites-alerts/db/schema.sql`

This service reads `users`, `students` and `holidays` and never writes them.
If the later schemas are not applied yet, it still runs — holiday skipping
and impact counts are simply unavailable, and that is logged.

## Cloud services

Beyond Vercel and Neon: Upstash Redis (shared rate-limit counters),
Cloudflare Turnstile (bot checks verified server-side), Vercel Cron
(scheduled generation), and AWS SNS + Lambda + EventBridge + IAM (the event
forwarder). What each one solves and what happens without it:
[`docs/cloud-services.md`](docs/cloud-services.md). Setup:
[`infra/README.md`](infra/README.md).

## Git rules

- Work on a branch, open a pull request, merge after review.
- **Never** commit `.env`. Only `.env.example` is pushed.
- `npm test` must pass before a PR is merged.

## Docs

| File | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | how the backend works: layers, trust boundary, request flow, the four non-CRUD features |
| [`docs/api-contract.md`](docs/api-contract.md) | data dictionary, endpoints, examples, error codes |
| [`docs/api-test-plan.md`](docs/api-test-plan.md) | 53 test cases, automated and manual |
| [`docs/threat-model.md`](docs/threat-model.md) | nine threats, each with a cloud control and a code control |
| [`docs/cloud-services.md`](docs/cloud-services.md) | why each cloud service is here |
| [`infra/README.md`](infra/README.md) | deployment and AWS commands |
