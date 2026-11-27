# Threat model — Route & Stop

Service owner: Yahia Wael (247330), Team 14, 26CSCN29H.

Scope: this service only. Login belongs to Ahmed, alerts belong to Ali.
Running on Floci: DynamoDB, Lambda, API Gateway, SQS, EventBridge,
CloudWatch, IAM.

Every threat below names **the file that holds the control** and **the test
that proves it works**. A control nobody tested is a claim, not a control.

## Assets

| Asset | Why it matters | Worst case |
|---|---|---|
| Timetable data | Families plan their morning around it | A child is sent to a stop with no bus |
| Session tokens | Impersonation of an admin | Anything an admin can do |
| The Lambda's IAM role | Reaches every table the policy allows | Whole-database damage |
| `INTERNAL_API_KEY` | Opens `/api/internal/*` | Forged generation runs |
| Availability | One shared Floci for three services | The whole app is down for the demo |
| The alert path to Ali | Parents only learn of a cancellation this way | Children wait at the kerb |

## Trust boundaries

1. **Browser to API Gateway.** The main one. Everything crossing it is
   untrusted, whichever page it came from.
2. **Lambda to DynamoDB and SQS.** Controlled by the IAM role, not by a
   credential in the code.
3. **This service to Ali's service.** One queue, send only.
4. **Developer to repository.** Where secrets leak if they leak.

---

## T1 — Someone calls an admin endpoint without being an admin

A parent, or anyone with any valid token, tries to create a route, cancel a
trip or read the bus list.

**Control:** `middleware/auth.js`. `requireAuth` answers *who is this* and
`requireRole('admin')` answers *may they do this*, as two separate guards
applied in `routes/routes.js`, where the whole access map can be read in one
screen. The role comes from the Users table, never from the request.

**Why it is split:** a single "is logged in" check is how a parent ends up
able to edit routes. Hiding a button is not access control either; the
frontend chooses a view for convenience only.

**Tests:** `tests/api/routes.test.js` — "a parent may NOT create a route"
(403), "a parent may NOT cancel a trip" (403, and no SQS message sent).
On Floci: ST-03 in `docs/api-test-plan.md`.

---

## T2 — A stolen, guessed or expired token

Someone replays a token from a log or a screenshot, or keeps using one after
it should have expired.

**Control:** `middleware/auth.js`. The Sessions table is keyed by the
SHA-256 of the token, so the table holds nothing anyone can log in with. A
missing session and an expired one get **the same** 401 and the same words,
so the API never confirms which tokens were once real. `expires_at` is
checked in Unix seconds on every request.

**Also:** `middleware/logger.js` never logs tokens, Authorization headers,
bodies or query strings. A log holding a bearer token hands anyone with log
access a working login.

**Tests:** "an invented token is 401, with the same message as an expired
one" and "an expired session is 401 even though the row exists". On Floci:
ST-01 and ST-02.

---

## T3 — Injection through an id (NoSQL, and the SQL habit)

A caller sends `{"$ne": null}`, `' OR 1=1`, or `../../` where an id is
expected.

**Control:** `lib/validate.js`. Ids must match an allow-list of letters,
digits, hyphen, underscore and colon, 1 to 128 characters. An allow-list,
not a block-list: listing what is safe holds against inputs nobody thought
of. The **type** is checked first, because a JSON body can carry an object
where a string is expected, and that is how NoSQL injection usually
arrives.

**Also:** `services/routes.js` never builds an expression from input. Values
always travel as `ExpressionAttributeValues`.

**Tests:** `tests/unit/validate.test.js` — "id blocks SQL and NoSQL
injection" and "id rejects a non-string". `tests/api/routes.test.js` — "a
bad id is 400, not a lookup" and "a NoSQL injection object in an id is 400".
On Floci: ST-04.

---

## T4 — Flooding the API

A script, or a buggy loop in the frontend, calls the API thousands of times
a minute. Three services share one Floci, so this takes the whole demo down.

**Control:** `middleware/rateLimit.js`, counted per source address taken
from `requestContext.http.sourceIp` in the API Gateway event — **never**
`X-Forwarded-For`, which the client writes itself and could change on every
request to get an unlimited budget. Reads 120/min, writes 20/min,
generation 5 per 5 minutes, each answering 429 with `Retry-After`.

API Gateway is also configured with throttling at 10 rps, burst 20
(`infra/deploy.sh`). Floci records that but does not enforce it, which is
exactly why the application keeps its own limit: on the demo machine, this
is the only one that fires.

**Also:** `limit` is capped at 100–200, the body at 32 kb, and a reorder at
100 stops, so one request cannot ask for unbounded work.

**Tests:** ST-06 on Floci (130 requests, expect 429 and `Retry-After`).
The limiter fails open if its store is unreachable, which is deliberate and
recorded in `docs/api-test-plan.md`.

---

## T5 — A compromised function reaching further than it should

Someone finds a flaw in this service and uses its identity to read or
destroy data belonging to the rest of the team.

**Control:** the IAM policy in `infra/deploy.sh`. Four statements, each
naming its resources:

- write only on `Routes`, `Stops`, `Buses`, `RouteSchedules`, `TripEvents`,
  `Trips`, `TripStops`
- **read only** on `Users` and `Sessions`
- `sqs:SendMessage` on Ali's one queue ARN, nothing else
- logs only in this service's own log group

No `"*"` resource anywhere. If this function were fully compromised, that is
the entire blast radius: it cannot create a user, cannot grant itself a
role, cannot read Ali's tables, and cannot touch another queue.

**Tests:** ST-07 reads the deployed role policy back and checks there is no
`"*"`. The read-only split is visible in the policy document itself.

---

## T6 — A cancellation that nobody hears about

A trip is cancelled while Ali's service or the queue is unreachable. Parents
are never told and the children wait at the kerb. This one has a real safety
cost, and it is an integrity problem rather than a classic attack.

**Control:** `services/events.js`. The event is written to `TripEvents`
before it is sent, and only marked sent once SQS has accepted it. A failed
send stays unsent and the daily EventBridge run
(`controllers/routes.js`, `cronGenerateTrips`) sweeps it. Delivery is
at-least-once, so `event_id` is the consumer's idempotency key.

The cancel itself uses a conditional write, so two admins pressing cancel at
the same moment produce one cancellation and one alert, not two.

**Tests:** "cancelling sends exactly one SQS message, in the agreed shape"
and "cancelling twice is 409 and does not send a second message". End to end
with Ali: ST-09, `evidence/joint-cancel-test.txt`.

---

## T7 — Secrets leaking through the repository or the logs

**Control:** `.gitignore` covers `.env` and `.test-tokens.local`.
`scripts/zip.js` refuses to build the deployment package if anything
matching `.env` would be included. With DynamoDB there is no connection
string at all: access comes from the IAM role, which is the strongest
version of this control, because there is no secret to leak.

**Tests:** ST-08 — `git grep` for secrets, the Lambda's environment read
back, and the log group checked for tokens.

---

## T8 — Automated writes from a script driving a real account

**Control:** `middleware/turnstile.js`, verified server-side, on writes. The
widget in the browser protects nothing on its own, because a script can skip
the page and call the API directly.

**Honest status:** Floci has no Turnstile secret, so on the demo deployment
this check is **skipped**, and it logs a SECURITY line saying so once per
container rather than failing silently. On a real deployment with the key
set it fails closed. This is a known gap, accepted for the deadline, and T4
is what actually limits automated writes on Floci.

**Tests:** the skip line appears in the log, which ST-06 captures.

---

## Risk summary

| # | Threat | Likelihood | Impact | After controls |
|---|---|---|---|---|
| T1 | Role escalation | Medium | High | Low |
| T2 | Stolen or expired token | Medium | High | Low |
| T3 | Injection in an id | Medium | Critical | Very low |
| T4 | Flooding | High | High | Low |
| T5 | Over-permissioned function | Low | Critical | Very low |
| T6 | Lost cancellation alert | Medium | **High (safety)** | Low |
| T7 | Leaked secrets | Medium | Critical | Low |
| T8 | Bot writes | Medium | Medium | Medium on Floci |

## Accepted, with reasons

- **Turnstile off on Floci** (T8 above). Rate limiting carries the load.
- **No WAF.** Needs a custom domain the team does not have.
- **The outbox is two steps, not one transaction.** DynamoDB could do it
  with `TransactWriteItems` across the trip and the event, and that would be
  the next improvement; the current window is milliseconds and the sweep
  closes it.
- **Route search uses a Scan.** Correct for one school's handful of routes,
  wrong at scale. `db/dynamo.js` caps it and `docs/architecture.md` says
  what to do instead.
- **Rate limiting is in memory**, so it is per Lambda container. On Floci
  that is usually one container; on real AWS it would need a shared store.
